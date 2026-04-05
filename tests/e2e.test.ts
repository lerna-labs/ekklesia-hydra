/**
 * End-to-end integration test for the Ekklesia Hydra voting middleware.
 *
 * Requires a live environment:
 *   - Middleware running on a remote VM (or locally)
 *   - Hydra node + IPFS node available
 *   - Blockfrost API key configured on the middleware
 *   - Valid admin wallet with funds
 *   - `cardano-signer` CLI installed (for key generation + CIP-8 signing)
 *
 * Set environment variables before running:
 *   E2E_API_URL    — middleware base URL (e.g., http://10.0.0.5:3000)
 *   E2E_API_KEY    — x-api-key header value
 *   E2E_CLOSE_TOKEN — close token (default: shutitdown)
 *
 * Run: npm run test:e2e
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import type { SignedVotePayload } from '../src/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.E2E_API_URL ?? '';
const API_KEY = process.env.E2E_API_KEY ?? '';
const CLOSE_TOKEN = process.env.E2E_CLOSE_TOKEN ?? 'shutitdown';
const BLOCKFROST_KEY = process.env.E2E_BLOCKFROST_KEY ?? '';
const DUMP_ADDRESS = process.env.E2E_DUMP_ADDRESS ?? '';

// ---------------------------------------------------------------------------
// Helpers — cardano-signer CLI wrappers
// ---------------------------------------------------------------------------

interface DRepKeys {
    secretKey: string;   // extended secret key hex
    publicKey: string;   // ed25519 public key hex
    drepId: string;      // CIP-129 bech32 drep1...
}

interface CoseWitness {
    coseSign1Hex: string;
    coseKeyHex: string;
    key: string;
    signature: string;
}

/** Generate a fresh DRep key pair using cardano-signer. */
function generateDRepKeys(): DRepKeys {
    const raw = execSync('cardano-signer keygen --path drep --json-extended', {
        encoding: 'utf-8',
    });
    const json = JSON.parse(raw);
    return {
        secretKey: json.secretKey as string,
        publicKey: json.publicKey as string,
        drepId: json.drepIdBech as string,
    };
}

/**
 * Sign a merkleRoot hex string with CIP-8 COSE_Sign1 using cardano-signer.
 * Returns the four fields expected by the middleware's CoseWitness interface.
 */
function signMerkleRoot(merkleRoot: string, secretKey: string, drepAddress: string): CoseWitness {
    const raw = execSync(
        `cardano-signer sign --cip8 ` +
        `--data "${merkleRoot}" ` +
        `--secret-key "${secretKey}" ` +
        `--address "${drepAddress}" ` +
        `--json-extended`,
        { encoding: 'utf-8' },
    );
    const json = JSON.parse(raw);
    return {
        coseSign1Hex: json.output.COSE_Sign1_hex,
        coseKeyHex: json.output.COSE_Key_hex,
        key: json.publicKey,
        signature: json.signature,
    };
}

/** Compute merkleRoot the same way the middleware does. */
function computeMerkleRoot(payload: SignedVotePayload): string {
    return bytesToHex(blake2b256(JSON.stringify(payload)));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const headers = () => ({
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
});

async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    if (res.status >= 400) {
        console.log(`  [${method} ${path}] ${res.status}:`, JSON.stringify(json).slice(0, 300));
    }
    return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Shared state across ordered tests
// ---------------------------------------------------------------------------

let prepareTxHash: string;
let policyId: string;
let fingerprint: string;
let instanceAssetName: string;
let votingOpenTime: number; // epoch ms — when votes can begin
let ballotIpfsCid: string;
let ballotContentHash: string;
let drepKeys: DRepKeys;
let voteReceipt: { txHash: string; voteHash: string; ipfsCid: string; tokenName: string };

/** Set to true when any test fails — subsequent tests skip immediately. */
let bail = false;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ekklesia Hydra E2E — Full Ballot Lifecycle', () => {

    // -----------------------------------------------------------------------
    // Phase 0: Preconditions
    // -----------------------------------------------------------------------

    beforeAll(() => {
        if (!API_URL) throw new Error('E2E_API_URL is required');
        if (!API_KEY) throw new Error('E2E_API_KEY is required');

        // Generate DRep keys once for the entire test run
        drepKeys = generateDRepKeys();
        console.log(`  Generated DRep: ${drepKeys.drepId}`);
    });

    // Skip all remaining tests once any test fails (sequential pipeline)
    beforeEach(({ task }) => {
        if (bail) {
            console.log(`  SKIPPED: ${task.name} — a prior phase failed`);
            throw new Error('Skipped — a prior phase failed');
        }
    });

    afterEach(({ task }) => {
        if (task.result?.state === 'fail') {
            bail = true;
        }
    });

    it('should be reachable', async () => {
        const { status, json } = await api('GET', '/');
        expect(status).toBe(200);
        expect(json.status).toBe('SUCCESS');
    });

    it('should report health', async () => {
        const { status, json } = await api('GET', '/health');
        // 200 = head reachable, 503 = Hydra node unreachable (both are valid pre-head states)
        expect([200, 503]).toContain(status);
        console.log(`  Health: ${status}`, JSON.stringify(json.data ?? json.message ?? '').slice(0, 200));
    }, 15_000);

    // -----------------------------------------------------------------------
    // Phase 0b: Sweep stale tokens from admin wallet
    // -----------------------------------------------------------------------

    describe('Wallet cleanup — sweep stale tokens', () => {
        it('should sweep stale tokens to ensure clean collateral', async () => {
            if (!DUMP_ADDRESS) {
                console.log('  Skipped: E2E_DUMP_ADDRESS not set');
                return;
            }

            const { status, json } = await api('POST', '/sweep', {
                dumpAddress: DUMP_ADDRESS,
            });

            if (status === 200 && json.data?.swept === 0) {
                console.log('  Wallet is clean — no stale tokens');
            } else if (status === 200) {
                console.log(`  Swept ${json.data.swept} tokens → ${json.data.txHash}`);

                // Wait for sweep tx to settle
                if (!BLOCKFROST_KEY) throw new Error('E2E_BLOCKFROST_KEY required to confirm sweep tx');
                const networkPrefix = BLOCKFROST_KEY.startsWith('preprod')
                    ? 'cardano-preprod'
                    : BLOCKFROST_KEY.startsWith('mainnet')
                        ? 'cardano-mainnet'
                        : 'cardano-preview';
                const MIN_DEPTH = 2;
                const bfHeaders = { project_id: BLOCKFROST_KEY };
                const bfBase = `https://${networkPrefix}.blockfrost.io/api/v0`;
                console.log(`  Waiting for sweep tx confirmation (${MIN_DEPTH} blocks deep)...`);
                for (let attempt = 0; attempt < 10; attempt++) {
                    const txRes = await fetch(`${bfBase}/txs/${json.data.txHash}`, { headers: bfHeaders });
                    if (txRes.ok) {
                        const txData = await txRes.json() as { block_height: number };
                        const tipRes = await fetch(`${bfBase}/blocks/latest`, { headers: bfHeaders });
                        const tipData = await tipRes.json() as { height: number };
                        const depth = tipData.height - txData.block_height;
                        console.log(`  Sweep tx depth: ${depth}`);
                        if (depth >= MIN_DEPTH) {
                            console.log(`  Sweep confirmed ${depth} blocks deep after ~${attempt * 40}s`);
                            break;
                        }
                    }
                    if (attempt === 9) throw new Error('Sweep tx not confirmed after 400s');
                    await new Promise(r => setTimeout(r, 40_000));
                }
            } else {
                console.log(`  Sweep failed: ${json.message}`);
            }
        }, 480_000);
    });

    // -----------------------------------------------------------------------
    // Phase 0c: Flush vote cache
    // -----------------------------------------------------------------------

    describe('Flush vote cache — clear stale entries from previous runs', () => {
        it('should flush the vote cache', async () => {
            const { status, json } = await api('POST', '/flush-cache');

            expect(status).toBe(200);
            console.log(`  Cache flushed: cleared ${json.data?.cleared ?? 0}, remaining ${json.data?.remaining ?? 0}`);
        });
    });

    // -----------------------------------------------------------------------
    // Phase 1: Ballot Preparation (L1)
    // -----------------------------------------------------------------------

    describe('POST /prepare — mint ballot tokens on L1', () => {
        it('should mint (600) + (601) tokens and pin ballot to IPFS', async () => {
            const ballot = {
                specVersion: '1.0.0',
                title: 'E2E Test Ballot',
                description: 'Automated integration test ballot',
                questions: [
                    {
                        questionId: 'q1',
                        question: 'Do you approve this proposal?',
                        method: 'binary',
                        options: [
                            { label: 'Yes', value: 1 },
                            { label: 'No', value: 0 },
                            { label: 'Abstain', value: 2 },
                        ],
                    },
                    {
                        questionId: 'q2',
                        question: 'Select your preferred options',
                        method: 'multi-choice',
                        options: [
                            { label: 'Option A', value: 0 },
                            { label: 'Option B', value: 1 },
                            { label: 'Option C', value: 2 },
                        ],
                        maxSelections: 2,
                        minSelections: 1,
                    },
                ],
                roleWeighting: { DRep: 'CredentialBased' },
                endEpoch: 999,
                ekklesia: {
                    namespace: '',
                    votingAuthority: '',
                    context: 'hydra-head',
                    acceptedCredentials: ['0x22'],
                    merkleRoot: '',
                    ballotIpfsCid: '',
                    votingWindow: {
                        open: new Date((votingOpenTime = Date.now() + 600_000)).toISOString(),  // 10 minutes from now
                        close: new Date(Date.now() + 86_400_000).toISOString(),
                    },
                },
            };

            const { status, json } = await api('POST', '/prepare', {
                namespace: 'vote.ekklesia.e2e.test',
                ballot,
                gasAmount: 50,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.txHash).toBeDefined();
            expect(json.data.policyId).toBeDefined();
            expect(json.data.fingerprint).toBeDefined();
            expect(json.data.ballotIpfsCid).toBeDefined();
            expect(json.data.ballotContentHash).toBeDefined();

            prepareTxHash = json.data.txHash;
            policyId = json.data.policyId;
            fingerprint = json.data.fingerprint;
            instanceAssetName = json.data.instanceAssetName;
            ballotIpfsCid = json.data.ballotIpfsCid;
            ballotContentHash = json.data.ballotContentHash;

            console.log(`  Ballot minted: ${prepareTxHash}`);
            console.log(`  Policy ID: ${policyId}`);
            console.log(`  IPFS CID: ${ballotIpfsCid}`);

            // Poll Blockfrost until the transaction is confirmed and at least 2 blocks deep
            const MIN_DEPTH = 2;
            console.log(`  Waiting for L1 confirmation (${MIN_DEPTH} blocks deep)...`);
            if (!BLOCKFROST_KEY) throw new Error('E2E_BLOCKFROST_KEY is required to confirm L1 transactions');
            const networkPrefix = BLOCKFROST_KEY.startsWith('mainnet')
                ? 'cardano-mainnet'
                : BLOCKFROST_KEY.startsWith('preprod')
                    ? 'cardano-preprod'
                    : 'cardano-preview';
            const bfHeaders = { project_id: BLOCKFROST_KEY };
            const bfBase = `https://${networkPrefix}.blockfrost.io/api/v0`;

            for (let attempt = 0; attempt < 15; attempt++) {
                const txRes = await fetch(`${bfBase}/txs/${prepareTxHash}`, { headers: bfHeaders });
                if (txRes.ok) {
                    const txData = await txRes.json() as { block_height: number };
                    const tipRes = await fetch(`${bfBase}/blocks/latest`, { headers: bfHeaders });
                    const tipData = await tipRes.json() as { height: number };
                    const depth = tipData.height - txData.block_height;
                    console.log(`  Tx at height ${txData.block_height}, tip ${tipData.height}, depth ${depth}`);
                    if (depth >= MIN_DEPTH) {
                        console.log(`  Confirmed ${depth} blocks deep after ~${attempt * 40}s`);
                        break;
                    }
                }
                if (attempt === 14) throw new Error('Transaction not confirmed after 10 minutes');
                await new Promise(r => setTimeout(r, 40_000));
            }
        }, 660_000);
    });

    // -----------------------------------------------------------------------
    // Phase 2: Open Head
    // -----------------------------------------------------------------------

    describe('POST /start — commit (601) + gas into Hydra head', () => {
        it('should open the head and cache the ballot', async () => {
            const { status, json } = await api('POST', '/start', {
                utxos: [
                    { txHash: prepareTxHash, outputIndex: 1 },
                    { txHash: prepareTxHash, outputIndex: 2 },
                ],
                ballotIpfsCid,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.ballotCached).toBe(true);

            console.log('  Head opened, ballot cached');
        }, 660_000); // up to ~11 min — head init + L1 commit can be slow on preprod
    });

    // -----------------------------------------------------------------------
    // Phase 3: Query ballot
    // -----------------------------------------------------------------------

    describe('GET /ballot — verify cached ballot', () => {
        it('should return the ballot definition', async () => {
            const { status, json } = await api('GET', '/ballot');

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.title).toBe('E2E Test Ballot');
            expect(json.data.questions).toHaveLength(2);
        });
    });

    // -----------------------------------------------------------------------
    // Phase 4: Register + Vote (with real COSE signatures)
    // -----------------------------------------------------------------------

    describe('Wait for voting window to open', () => {
        it('should wait until the voting start time', async () => {
            const remaining = votingOpenTime - Date.now();
            if (remaining > 0) {
                console.log(`  Waiting ${Math.ceil(remaining / 1000)}s for voting window to open...`);
                await new Promise(r => setTimeout(r, remaining));
            }
            console.log('  Voting window is open');
        }, 660_000); // 11 minutes max
    });

    describe('POST /vote-and-register — register voter and cast first vote', () => {
        it('should register and vote with a real COSE signature', async () => {
            const votes = [
                { questionId: 'q1', selection: [1] },        // Yes
                { questionId: 'q2', selection: [0, 2] },     // Options A + C
            ];

            // Build the same signed payload the server will compute
            const signedPayload: SignedVotePayload = {
                ballotId: prepareTxHash,
                nonce: 1,
                votes,
            };

            // Compute merkleRoot and sign it
            const merkleRoot = computeMerkleRoot(signedPayload);
            const signature = signMerkleRoot(merkleRoot, drepKeys.secretKey, drepKeys.drepId);

            console.log(`  merkleRoot: ${merkleRoot}`);
            console.log(`  Signing with DRep: ${drepKeys.drepId}`);

            const { status, json } = await api('POST', '/vote-and-register', {
                voterId: drepKeys.drepId,
                ballotId: prepareTxHash,
                votes,
                signature,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.voteHash).toBeDefined();
            expect(json.data.ipfsCid).toBeDefined();

            voteReceipt = json.data;
            console.log(`  Registered + voted: ${json.data.txHash ?? '(no txHash — TRP submit pending)'}`);
            console.log(`  Vote hash: ${json.data.voteHash}`);
            console.log(`  IPFS CID: ${json.data.ipfsCid}`);
        }, 60_000);
    });

    // -----------------------------------------------------------------------
    // Phase 4b: Update vote (cast_vote with incremented nonce)
    // -----------------------------------------------------------------------

    describe('POST /vote — update an existing vote', () => {
        it('should update the vote with nonce 2', async () => {
            const votes = [
                { questionId: 'q1', selection: [0] },        // Changed to No
                { questionId: 'q2', selection: [1] },         // Changed to Option B only
            ];

            const signedPayload: SignedVotePayload = {
                ballotId: prepareTxHash,
                nonce: 2,
                votes,
            };

            const merkleRoot = computeMerkleRoot(signedPayload);
            const signature = signMerkleRoot(merkleRoot, drepKeys.secretKey, drepKeys.drepId);

            console.log(`  Updating vote with nonce 2, merkleRoot: ${merkleRoot}`);

            const { status, json } = await api('POST', '/vote', {
                voterId: drepKeys.drepId,
                nonce: 2,
                ballotId: prepareTxHash,
                votes,
                signature,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.txHash).toBeDefined();
            expect(json.data.voteHash).toBeDefined();

            voteReceipt = json.data;
            console.log(`  Vote updated: ${json.data.txHash}`);
            console.log(`  New vote hash: ${json.data.voteHash}`);
        }, 60_000);
    });

    // -----------------------------------------------------------------------
    // Phase 5: Query votes
    // -----------------------------------------------------------------------

    describe('GET /votes — list all votes', () => {
        it('should return at least one vote', async () => {
            const { status, json } = await api('GET', '/votes');

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.totalVoters).toBeGreaterThanOrEqual(1);
        });
    });

    describe('GET /voter/:voterId — lookup the test voter', () => {
        it('should find the registered voter', async () => {
            const { status, json } = await api('GET', `/voter/${drepKeys.drepId}`);

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.voterId).toBe(drepKeys.drepId);
            if (voteReceipt?.voteHash) {
                expect(json.data.voteHash).toBe(voteReceipt.voteHash);
            }
        });
    });

    // -----------------------------------------------------------------------
    // Phase 6: Audit
    // -----------------------------------------------------------------------

    describe('GET /audit — full verification bundle', () => {
        it('should return audit data with at least one voter', async () => {
            const { status, json } = await api('GET', '/audit');

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.ballotCached).toBe(true);
            expect(json.data.totalVoters).toBeGreaterThanOrEqual(1);
        });
    });

    describe('GET /audit/vote/:voterId — single voter audit', () => {
        it('should return voter evidence with verification data', async () => {
            const { status, json } = await api('GET', `/audit/vote/${drepKeys.drepId}`);

            expect(status).toBe(200);
            expect(json.data.cacheEntry).toBeDefined();
            expect(json.data.verification).toBeDefined();
            expect(json.data.history).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // Phase 7: Settle — burn → finalize+decommit → close
    // -----------------------------------------------------------------------
    // Uses /settle which burns voter tokens, builds the finalize tx via TRP,
    // submits it as a decommit (ballot token + datum settles to L1 directly),
    // then closes the head (fanout only handles ADA — no tokens or datums).

    describe('POST /settle — full settlement with decommit', () => {
        it('should burn, decommit finalized ballot, and close head', async () => {
            const { status, json } = await api('POST', '/settle', {
                ballotId: prepareTxHash,
                ballotName: instanceAssetName,
                ballotPolicy: policyId,
                closeToken: CLOSE_TOKEN,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.resultsHash).toBeDefined();
            expect(json.data.evidenceDirectoryCid).toBeDefined();
            expect(json.data.totalVoters).toBe(1);

            console.log('  Settlement steps:');
            for (const step of json.data.steps ?? []) {
                console.log(`    ${step.step}: ${step.status}`, step.data ? JSON.stringify(step.data).slice(0, 200) : '');
            }
            console.log(`  Results hash: ${json.data.resultsHash}`);
            console.log(`  Evidence CID: ${json.data.evidenceDirectoryCid}`);
            console.log(`  Total voters: ${json.data.totalVoters}`);
        }, 600_000); // 10 min — burn + decommit + contestation + fanout
    });

    // -----------------------------------------------------------------------
    // Phase 9: Wait for contestation period + fanout
    // -----------------------------------------------------------------------

    describe('Wait for fanout — contestation period + finalize', () => {
        it('should wait for head to reach Idle state', async () => {
            // The contestation period is typically 600s (10 min).
            // Poll health every 30s until the head reaches Idle (post-fanout).
            // The /close endpoint's Wrangler should handle the fanout automatically,
            // but if it doesn't, we trigger it manually when we see FanoutPossible.
            console.log('  Waiting for contestation period + fanout...');

            let fanoutAttempted = false;

            for (let attempt = 0; attempt < 30; attempt++) {
                const { json } = await api('GET', '/health');
                const headStatus = json.data?.headStatus ?? json.status;
                console.log(`  [${attempt * 30}s] Head status: ${headStatus}`);

                if (headStatus === 'Idle') {
                    console.log('  Head returned to Idle — fanout complete!');
                    return;
                }

                if (headStatus === 'FanoutPossible' && !fanoutAttempted) {
                    fanoutAttempted = true;
                    console.log('  Triggering fanout via /close...');
                    // Fire and forget — the Wrangler may timeout but the fanout
                    // command still gets sent to the Hydra node
                    api('POST', '/close', { closeToken: CLOSE_TOKEN }).catch(() => {});
                    // Give the fanout tx time to land on L1
                    await new Promise(r => setTimeout(r, 60_000));
                    continue;
                }

                await new Promise(r => setTimeout(r, 30_000));
            }

            throw new Error('Head did not reach Idle state within 15 minutes');
        }, 960_000); // 16 min timeout
    });

    // -----------------------------------------------------------------------
    // Phase 10: Post-settlement verification
    // -----------------------------------------------------------------------

    describe('GET /health — verify head is back to Idle', () => {
        it('should report Idle status after fanout', async () => {
            const { json } = await api('GET', '/health');
            const headStatus = json.data?.headStatus ?? 'unknown';
            console.log(`  Final head status: ${headStatus}`);
            expect(headStatus).toBe('Idle');
        });
    });
});
