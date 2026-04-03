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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import type { SignedVotePayload } from '../src/types.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = process.env.E2E_API_URL ?? '';
const API_KEY = process.env.E2E_API_KEY ?? '';
const CLOSE_TOKEN = process.env.E2E_CLOSE_TOKEN ?? 'shutitdown';

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
let ballotIpfsCid: string;
let ballotContentHash: string;
let drepKeys: DRepKeys;
let voteReceipt: { txHash: string; voteHash: string; ipfsCid: string; tokenName: string };

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
                        open: new Date().toISOString(),
                        close: new Date(Date.now() + 86400000).toISOString(),
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

            // Wait for L1 confirmation (preprod can have rollbacks)
            console.log('  Waiting 180s for L1 confirmation...');
            await new Promise(r => setTimeout(r, 180_000));
        }, 300_000);
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
        }, 240_000);
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
            expect(json.data.txHash).toBeDefined();
            expect(json.data.voteHash).toBeDefined();
            expect(json.data.ipfsCid).toBeDefined();

            voteReceipt = json.data;
            console.log(`  Registered + voted: ${json.data.txHash}`);
            console.log(`  Vote hash: ${json.data.voteHash}`);
            console.log(`  IPFS CID: ${json.data.ipfsCid}`);
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
            expect(json.data.voteHash).toBe(voteReceipt.voteHash);
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
    // Phase 7: Finalization
    // -----------------------------------------------------------------------

    describe('POST /finalize — tally and update (601) datum', () => {
        it('should finalize the ballot', async () => {
            const { status, json } = await api('POST', '/finalize', {
                ballotId: prepareTxHash,
                ballotName: instanceAssetName,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.resultsHash).toBeDefined();
            expect(json.data.evidenceDirectoryCid).toBeDefined();
            expect(json.data.evidenceMerkleRoot).toBeDefined();
            expect(json.data.totalVoters).toBeGreaterThanOrEqual(1);

            console.log(`  Finalized: ${json.data.evidenceDirectoryCid}`);
            console.log(`  Results hash: ${json.data.resultsHash}`);
            console.log(`  Total voters: ${json.data.totalVoters}`);
        }, 120_000);
    });

    // -----------------------------------------------------------------------
    // Phase 8: Burn + Close
    // -----------------------------------------------------------------------

    describe('POST /count — burn all voter tokens', () => {
        it('should burn voter tokens', async () => {
            const { status, json } = await api('POST', '/count');

            expect(status).toBe(200);
            console.log(`  Burned: ${json.data?.burned ?? 0}/${json.data?.total ?? 0}`);
        }, 120_000);
    });

    describe('POST /close — close the head', () => {
        it('should close the head and fanout to L1', async () => {
            const { status, json } = await api('POST', '/close', {
                closeToken: CLOSE_TOKEN,
            });

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            console.log('  Head closed');
        }, 240_000);
    });

    // -----------------------------------------------------------------------
    // Phase 9: Post-settlement verification
    // -----------------------------------------------------------------------

    describe('GET /health — verify head is closed', () => {
        it('should report non-Open status', async () => {
            const { json } = await api('GET', '/health');
            expect(json.status).not.toBe('Open');
            console.log(`  Final head status: ${json.status}`);
        });
    });
});
