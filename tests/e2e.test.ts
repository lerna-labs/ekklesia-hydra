/**
 * End-to-end integration test for the Ekklesia Hydra voting middleware.
 *
 * Tests the full ballot lifecycle with TWO DRep voters:
 *   - DRep A: register → vote → update vote
 *   - DRep B: vote-and-register → update vote
 *   - Settle: burn all → finalize → close → fanout
 *
 * Captures a head UTxO snapshot after every transaction for diagnostics.
 *
 * Requires a live environment:
 *   - Middleware running on a remote VM (or locally)
 *   - Hydra node + IPFS node available
 *   - Blockfrost API key configured on the middleware
 *   - Valid admin wallet with funds
 *   - `cardano-signer` CLI installed (for key generation + CIP-8 signing)
 *
 * Set environment variables before running:
 *   E2E_API_URL        — middleware base URL (e.g., http://10.0.0.5:3000)
 *   E2E_API_KEY        — x-api-key header value
 *   E2E_BLOCKFROST_KEY — Blockfrost project ID (required for L1 confirmation)
 *   E2E_CLOSE_TOKEN    — close token (default: shutitdown)
 *   E2E_DUMP_ADDRESS   — address to sweep stale tokens to (optional)
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
    secretKey: string;
    publicKey: string;
    drepId: string;
}

interface CoseWitness {
    coseSign1Hex: string;
    coseKeyHex: string;
    key: string;
    signature: string;
}

function generateDRepKeys(): DRepKeys {
    const raw = execSync('cardano-signer keygen --path drep --json-extended', { encoding: 'utf-8' });
    const json = JSON.parse(raw);
    return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.drepIdBech };
}

function signMerkleRoot(merkleRoot: string, secretKey: string, drepAddress: string): CoseWitness {
    const raw = execSync(
        `cardano-signer sign --cip8 --data "${merkleRoot}" --secret-key "${secretKey}" --address "${drepAddress}" --json-extended`,
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

function computeMerkleRoot(payload: SignedVotePayload): string {
    return bytesToHex(blake2b256(JSON.stringify(payload)));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const headers = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });

async function api(method: string, path: string, body?: unknown, timeoutMs = 300_000) {
    const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (res.status >= 400) {
        console.log(`  [${method} ${path}] ${res.status}:`, JSON.stringify(json).slice(0, 300));
    }
    return { status: res.status, json };
}

/** Log the head UTxO set via /ledger for diagnostics. */
async function snapshotHead(label: string) {
    const { status, json } = await api('POST', '/ledger');
    if (status !== 200) {
        console.log(`  [${label}] Ledger query failed: ${status}`);
        return;
    }
    const utxos = json.data?.utxos ?? [];
    console.log(`  [${label}] Head UTxOs: ${utxos.length}`);
    for (const u of utxos) {
        const tokens = u.amount
            .filter((a: any) => a.unit !== 'lovelace')
            .map((a: any) => `${a.unit.slice(0, 16)}…(${a.quantity})`)
            .join(', ');
        const lovelace = u.amount.find((a: any) => a.unit === 'lovelace')?.quantity ?? '0';
        console.log(`    ${u.tx_hash.slice(0, 12)}…#${u.output_index}: ${lovelace} lovelace${tokens ? ' + ' + tokens : ''}`);
    }
}

/** Wait for a Blockfrost tx to reach the desired confirmation depth. */
async function waitForL1Confirmation(txHash: string, minDepth = 2, maxAttempts = 15) {
    if (!BLOCKFROST_KEY) throw new Error('E2E_BLOCKFROST_KEY is required');
    const networkPrefix = BLOCKFROST_KEY.startsWith('mainnet') ? 'cardano-mainnet'
        : BLOCKFROST_KEY.startsWith('preprod') ? 'cardano-preprod' : 'cardano-preview';
    const bfBase = `https://${networkPrefix}.blockfrost.io/api/v0`;
    const bfHeaders = { project_id: BLOCKFROST_KEY };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const txRes = await fetch(`${bfBase}/txs/${txHash}`, { headers: bfHeaders });
        if (txRes.ok) {
            const txData = await txRes.json() as { block_height: number };
            const tipRes = await fetch(`${bfBase}/blocks/latest`, { headers: bfHeaders });
            const tipData = await tipRes.json() as { height: number };
            const depth = tipData.height - txData.block_height;
            console.log(`  L1 depth: ${depth} (height ${txData.block_height}, tip ${tipData.height})`);
            if (depth >= minDepth) return;
        }
        if (attempt === maxAttempts - 1) throw new Error(`Tx ${txHash} not confirmed after ${maxAttempts * 40}s`);
        await new Promise(r => setTimeout(r, 40_000));
    }
}

// ---------------------------------------------------------------------------
// Shared state across ordered tests
// ---------------------------------------------------------------------------

let prepareTxHash: string;
let policyId: string;
let instanceAssetName: string;
let votingOpenTime: number;
let ballotIpfsCid: string;

let drepA: DRepKeys;
let drepB: DRepKeys;

let bail = false;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ekklesia Hydra E2E — Full Ballot Lifecycle (2 DReps)', () => {

    beforeAll(() => {
        if (!API_URL) throw new Error('E2E_API_URL is required');
        if (!API_KEY) throw new Error('E2E_API_KEY is required');

        drepA = generateDRepKeys();
        drepB = generateDRepKeys();
        console.log(`  DRep A: ${drepA.drepId}`);
        console.log(`  DRep B: ${drepB.drepId}`);
    });

    beforeEach(({ task }) => {
        if (bail) {
            console.log(`  SKIPPED: ${task.name}`);
            throw new Error('Skipped — a prior phase failed');
        }
    });

    afterEach(({ task }) => {
        if (task.result?.state === 'fail') bail = true;
    });

    // ===== Phase 0: Preconditions =====

    it('should be reachable', async () => {
        const { status } = await api('GET', '/');
        expect(status).toBe(200);
    });

    it('should report health', async () => {
        const { status, json } = await api('GET', '/health');
        expect([200, 503]).toContain(status);
        console.log(`  Health: ${status}`, JSON.stringify(json.data ?? '').slice(0, 200));
    }, 15_000);

    // ===== Phase 0b: Cleanup =====

    it('should sweep stale tokens', async () => {
        if (!DUMP_ADDRESS) { console.log('  Skipped: E2E_DUMP_ADDRESS not set'); return; }
        const { status, json } = await api('POST', '/sweep', { dumpAddress: DUMP_ADDRESS });
        if (status === 200 && json.data?.swept > 0) {
            console.log(`  Swept ${json.data.swept} tokens → ${json.data.txHash}`);
            await waitForL1Confirmation(json.data.txHash);
        } else {
            console.log('  Wallet clean');
        }
    }, 480_000);

    it('should flush vote cache', async () => {
        const { status, json } = await api('POST', '/flush-cache');
        expect(status).toBe(200);
        console.log(`  Cleared ${json.data?.cleared ?? 0} entries`);
    });

    // ===== Phase 1: Prepare ballot on L1 =====

    it('should mint (600) + (601) ballot tokens', async () => {
        const ballot = {
            specVersion: '1.0.0',
            title: 'E2E Test Ballot — 2 DReps',
            description: 'Tests register, vote-and-register, vote updates, settle, fanout',
            questions: [
                {
                    questionId: 'q1',
                    question: 'Do you approve?',
                    method: 'binary',
                    options: [
                        { label: 'Yes', value: 1 },
                        { label: 'No', value: 0 },
                        { label: 'Abstain', value: 2 },
                    ],
                },
                {
                    questionId: 'q2',
                    question: 'Pick your options',
                    method: 'multi-choice',
                    options: [
                        { label: 'A', value: 0 },
                        { label: 'B', value: 1 },
                        { label: 'C', value: 2 },
                    ],
                    maxSelections: 2,
                    minSelections: 1,
                },
            ],
            roleWeighting: { DRep: 'CredentialBased' },
            endEpoch: 999,
            ekklesia: {
                namespace: '', votingAuthority: '', context: 'hydra-head',
                acceptedCredentials: ['0x22'], merkleRoot: '', ballotIpfsCid: '',
                votingWindow: {
                    open: new Date((votingOpenTime = Date.now() + 600_000)).toISOString(),
                    close: new Date(Date.now() + 86_400_000).toISOString(),
                },
            },
        };

        const { status, json } = await api('POST', '/prepare', {
            namespace: 'vote.ekklesia.e2e.2drep',
            ballot,
            gasAmount: 50,
        });

        expect(status).toBe(200);
        expect(json.data.txHash).toBeDefined();

        prepareTxHash = json.data.txHash;
        policyId = json.data.policyId;
        instanceAssetName = json.data.instanceAssetName;
        ballotIpfsCid = json.data.ballotIpfsCid;

        console.log(`  Tx: ${prepareTxHash}`);
        console.log(`  Policy: ${policyId}`);
        console.log(`  Instance: ${instanceAssetName}`);

        await waitForL1Confirmation(prepareTxHash);
    }, 660_000);

    // ===== Phase 2: Open head =====

    it('should open the head and cache the ballot', async () => {
        const { status, json } = await api('POST', '/start', {
            utxos: [{ txHash: prepareTxHash, outputIndex: 1 }],
            ballotIpfsCid,
            ballotPolicy: policyId,
            ballotToken: instanceAssetName,
        });

        expect(status).toBe(200);
        expect(json.data.ballotCached).toBe(true);
        console.log('  Head opened');

        await snapshotHead('after-start');
    }, 660_000);

    // ===== Phase 3: Verify ballot cached =====

    it('should return the ballot definition', async () => {
        const { status, json } = await api('GET', '/ballot');
        expect(status).toBe(200);
        expect(json.data.title).toContain('2 DReps');
        expect(json.data.questions).toHaveLength(2);
    });

    // ===== Phase 4: Wait for voting window =====

    it('should wait for voting window', async () => {
        const remaining = votingOpenTime - Date.now();
        if (remaining > 0) {
            console.log(`  Waiting ${Math.ceil(remaining / 1000)}s…`);
            await new Promise(r => setTimeout(r, remaining));
        }
        console.log('  Voting window open');
    }, 660_000);

    // ===== Phase 5: DRep A — register then vote separately =====

    it('DRep A: register', async () => {
        const { status, json } = await api('POST', '/register', { voterId: drepA.drepId });
        expect(status).toBe(200);
        console.log(`  Registered: ${json.data.txHash}`);
        await snapshotHead('after-register-A');
    }, 60_000);

    it('DRep A: first vote (nonce 1)', async () => {
        const votes = [{ questionId: 'q1', selection: [1] }, { questionId: 'q2', selection: [0, 2] }];
        const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 1, votes };
        const merkleRoot = computeMerkleRoot(payload);
        const signature = signMerkleRoot(merkleRoot, drepA.secretKey, drepA.drepId);

        const { status, json } = await api('POST', '/vote', {
            voterId: drepA.drepId, nonce: 1, ballotId: prepareTxHash, votes, signature,
        });

        expect(status).toBe(200);
        console.log(`  Voted: ${json.data.txHash} (hash: ${json.data.voteHash})`);
        await snapshotHead('after-vote-A-1');
    }, 60_000);

    it('DRep A: update vote (nonce 2)', async () => {
        const votes = [{ questionId: 'q1', selection: [0] }, { questionId: 'q2', selection: [1] }];
        const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 2, votes };
        const merkleRoot = computeMerkleRoot(payload);
        const signature = signMerkleRoot(merkleRoot, drepA.secretKey, drepA.drepId);

        const { status, json } = await api('POST', '/vote', {
            voterId: drepA.drepId, nonce: 2, ballotId: prepareTxHash, votes, signature,
        });

        expect(status).toBe(200);
        console.log(`  Updated: ${json.data.txHash} (hash: ${json.data.voteHash})`);
        await snapshotHead('after-vote-A-2');
    }, 60_000);

    // ===== Phase 6: DRep B — vote-and-register then update =====

    it('DRep B: vote-and-register (nonce 1)', async () => {
        const votes = [{ questionId: 'q1', selection: [2] }, { questionId: 'q2', selection: [0] }];
        const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 1, votes };
        const merkleRoot = computeMerkleRoot(payload);
        const signature = signMerkleRoot(merkleRoot, drepB.secretKey, drepB.drepId);

        const { status, json } = await api('POST', '/vote-and-register', {
            voterId: drepB.drepId, ballotId: prepareTxHash, votes, signature,
        });

        expect(status).toBe(200);
        console.log(`  Registered + voted: ${json.data.txHash} (hash: ${json.data.voteHash})`);
        await snapshotHead('after-voteregister-B');
    }, 60_000);

    it('DRep B: update vote (nonce 2)', async () => {
        const votes = [{ questionId: 'q1', selection: [1] }, { questionId: 'q2', selection: [1, 2] }];
        const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 2, votes };
        const merkleRoot = computeMerkleRoot(payload);
        const signature = signMerkleRoot(merkleRoot, drepB.secretKey, drepB.drepId);

        const { status, json } = await api('POST', '/vote', {
            voterId: drepB.drepId, nonce: 2, ballotId: prepareTxHash, votes, signature,
        });

        expect(status).toBe(200);
        console.log(`  Updated: ${json.data.txHash} (hash: ${json.data.voteHash})`);
        await snapshotHead('after-vote-B-2');
    }, 60_000);

    // ===== Phase 7: Query + audit =====

    it('should list 2 voters', async () => {
        const { status, json } = await api('GET', '/votes');
        expect(status).toBe(200);
        expect(json.data.totalVoters).toBe(2);
        console.log(`  Total voters: ${json.data.totalVoters}`);
    });

    it('should find DRep A', async () => {
        const { status, json } = await api('GET', `/voter/${drepA.drepId}`);
        expect(status).toBe(200);
        expect(json.data.version).toBe(2);
    });

    it('should find DRep B', async () => {
        const { status, json } = await api('GET', `/voter/${drepB.drepId}`);
        expect(status).toBe(200);
        expect(json.data.version).toBe(2);
    });

    it('audit should show 2 voters', async () => {
        const { status, json } = await api('GET', '/audit');
        expect(status).toBe(200);
        expect(json.data.totalVoters).toBe(2);
    });

    // ===== Phase 8: Settle =====

    it('should settle: burn → finalize → close', async () => {
        await snapshotHead('pre-settle');

        const { status, json } = await api('POST', '/settle', {
            ballotId: prepareTxHash,
            ballotName: instanceAssetName,
            ballotPolicy: policyId,
            closeToken: CLOSE_TOKEN,
        }, 540_000);

        expect(status).toBe(200);
        expect(json.status).toBe('SUCCESS');
        expect(json.data.totalVoters).toBe(2);

        console.log('  Steps:');
        for (const step of json.data.steps ?? []) {
            console.log(`    ${step.step}: ${step.status}`, step.data ? JSON.stringify(step.data).slice(0, 200) : '');
        }
        console.log(`  Results hash: ${json.data.resultsHash}`);
        console.log(`  Evidence CID: ${json.data.evidenceDirectoryCid}`);
    }, 600_000);

    // ===== Phase 9: Wait for fanout =====

    it('should fanout to L1', async () => {
        console.log('  Waiting for contestation + fanout…');
        let fanoutAttempted = false;

        for (let attempt = 0; attempt < 30; attempt++) {
            const { json } = await api('GET', '/health');
            const headStatus = json.data?.headStatus ?? json.status;
            console.log(`  [${attempt * 30}s] ${headStatus}`);

            if (headStatus === 'Idle') {
                console.log('  Fanout complete!');
                return;
            }

            if (headStatus === 'FanoutPossible' && !fanoutAttempted) {
                fanoutAttempted = true;
                console.log('  Triggering fanout…');
                api('POST', '/close', { closeToken: CLOSE_TOKEN }).catch(() => {});
                await new Promise(r => setTimeout(r, 60_000));
                continue;
            }

            await new Promise(r => setTimeout(r, 30_000));
        }

        throw new Error('Head did not reach Idle within 15 minutes');
    }, 960_000);

    // ===== Phase 10: Post-fanout verification =====

    it('should be Idle after fanout', async () => {
        const { json } = await api('GET', '/health');
        console.log(`  Final status: ${json.data?.headStatus}`);
        expect(json.data?.headStatus).toBe('Idle');
    });
});
