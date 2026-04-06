/**
 * Load / performance test for the Ekklesia Hydra voting middleware.
 *
 * Opens a single head and scales up voters to measure response time
 * degradation as the in-head UTxO set grows.
 *
 * Configurable via environment variables:
 *   E2E_API_URL        — middleware base URL
 *   E2E_API_KEY        — x-api-key header value
 *   E2E_BLOCKFROST_KEY — Blockfrost project ID
 *   E2E_CLOSE_TOKEN    — close token (default: shutitdown)
 *   LOAD_VOTERS        — number of voters to register (default: 10)
 *   LOAD_BAD_VOTES     — number of bad vote attempts per batch (default: 5)
 *
 * Run: LOAD_VOTERS=20 npm run test:e2e -- tests/load.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { SignedVotePayload } from '../src/types.js';
import {
    API_URL,
    API_KEY,
    CLOSE_TOKEN,
    DUMP_ADDRESS,
    generateDRepKeys,
    signMerkleRoot,
    computeMerkleRoot,
    api,
    waitForL1Confirmation,
} from './helpers.js';
import type { DRepKeys } from './helpers.js';

// ---------------------------------------------------------------------------
// Load-test-specific config
// ---------------------------------------------------------------------------

const VOTER_COUNT = parseInt(process.env.LOAD_VOTERS ?? '10', 10);
const BAD_VOTE_COUNT = parseInt(process.env.LOAD_BAD_VOTES ?? '5', 10);

// ---------------------------------------------------------------------------
// Load-test-specific types
// ---------------------------------------------------------------------------

interface TimedResult {
    operation: string;
    voterIndex: number;
    utxoCount: number;
    durationMs: number;
    status: number;
    success: boolean;
    error?: string;
}

// ---------------------------------------------------------------------------
// Load-test-specific helpers
// ---------------------------------------------------------------------------

function printStats(label: string, results: TimedResult[]) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    if (successful.length === 0) {
        console.log(`  [${label}] All ${results.length} failed`);
        return;
    }
    const times = successful.map(r => r.durationMs).sort((a, b) => a - b);
    const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p95 = times[Math.floor(times.length * 0.95)];
    const min = times[0];
    const max = times[times.length - 1];
    console.log(`  [${label}] ${successful.length} ok, ${failed.length} fail | avg=${avg}ms p50=${p50}ms p95=${p95}ms min=${min}ms max=${max}ms`);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let prepareTxHash: string;
let policyId: string;
let instanceAssetName: string;
let ballotIpfsCid: string;
let votingOpenTime: number;
let bail = false;
const voters: DRepKeys[] = [];
const results: TimedResult[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Ekklesia Hydra Load Test — ${VOTER_COUNT} voters`, () => {

    beforeAll(() => {
        if (!API_URL) throw new Error('E2E_API_URL is required');
        if (!API_KEY) throw new Error('E2E_API_KEY is required');

        console.log(`  Generating ${VOTER_COUNT} DRep key pairs…`);
        const genStart = performance.now();
        for (let i = 0; i < VOTER_COUNT; i++) {
            voters.push(generateDRepKeys());
        }
        console.log(`  Keys generated in ${Math.round(performance.now() - genStart)}ms`);
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

    // ===== Phase 0: Preconditions (matches E2E baseline) =====

    it('should be reachable', async () => {
        const { status } = await api('GET', '/');
        expect(status).toBe(200);
    });

    it('should report health', async () => {
        const { status, json } = await api('GET', '/health');
        expect([200, 503]).toContain(status);
        console.log(`  Health: ${status}`, JSON.stringify(json.data ?? '').slice(0, 200));
    }, 15_000);

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

    it('should mint ballot tokens', async () => {
        const ballot = {
            specVersion: '1.0.0',
            title: `Load Test — ${VOTER_COUNT} voters`,
            description: 'Performance test for UTxO scaling',
            questions: [{
                questionId: 'q1',
                question: 'Approve?',
                method: 'binary',
                options: [
                    { label: 'Yes', value: 1 },
                    { label: 'No', value: 0 },
                    { label: 'Abstain', value: 2 },
                ],
            }],
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
            namespace: 'vote.ekklesia.load.test',
            ballot,
            gasAmount: 3,
        });

        expect(status).toBe(200);
        expect(json.data.txHash).toBeDefined();

        prepareTxHash = json.data.txHash;
        policyId = json.data.policyId;
        instanceAssetName = json.data.instanceAssetName;
        ballotIpfsCid = json.data.ballotIpfsCid;

        console.log(`  Tx: ${prepareTxHash}`);
        console.log(`  Policy: ${policyId}`);

        await waitForL1Confirmation(prepareTxHash);
    }, 660_000);

    // ===== Phase 2: Open head =====

    it('should open the head and cache the ballot', async () => {
        const { status, json } = await api('POST', '/start', {
            utxos: [{ txHash: prepareTxHash, outputIndex: 1 }],
            ballotIpfsCid,
            ballotPolicy: policyId,
            ballotToken: instanceAssetName,
        }, 540_000);

        expect(status).toBe(200);
        expect(json.data.ballotCached).toBe(true);
        console.log('  Head opened');
    }, 660_000);

    // ===== Phase 3: Wait for voting window =====

    it('should wait for voting window', async () => {
        const remaining = votingOpenTime - Date.now();
        if (remaining > 0) {
            console.log(`  Waiting ${Math.ceil(remaining / 1000)}s…`);
            await new Promise(r => setTimeout(r, remaining));
        }
        console.log('  Voting window open');
    }, 660_000);

    // ===== Phase 1: Register all voters via vote-and-register =====

    it('should register and vote for all voters', async () => {
        console.log(`  Registering ${VOTER_COUNT} voters via vote-and-register…`);

        for (let i = 0; i < VOTER_COUNT; i++) {
            const voter = voters[i];
            const votes = [{ questionId: 'q1', selection: [1] }]; // Yes
            const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 1, votes };
            const merkleRoot = computeMerkleRoot(payload);
            const signature = signMerkleRoot(merkleRoot, voter.secretKey, voter.drepId);

            const { status, json, durationMs } = await api('POST', '/vote-and-register', {
                voterId: voter.drepId,
                ballotId: prepareTxHash,
                votes,
                signature,
            });

            const utxoCount = 1 + (i + 1); // ballot token + i voter tokens
            results.push({
                operation: 'vote-and-register',
                voterIndex: i,
                utxoCount,
                durationMs,
                status,
                success: status === 200,
                error: status !== 200 ? json.message : undefined,
            });

            if (status !== 200) {
                console.log(`  [${i}] FAILED (${status}): ${json.message?.slice(0, 100)}`);
            } else if (i % 5 === 0 || i === VOTER_COUNT - 1) {
                console.log(`  [${i}/${VOTER_COUNT}] ${durationMs}ms (${utxoCount} UTxOs)`);
            }
        }

        printStats('vote-and-register', results.filter(r => r.operation === 'vote-and-register'));
    }, VOTER_COUNT * 30_000); // 30s per voter max

    // ===== Phase 2: Update votes (cast_vote) =====

    it('should update all votes', async () => {
        console.log(`  Updating ${VOTER_COUNT} votes via cast_vote…`);
        const updateResults: TimedResult[] = [];

        for (let i = 0; i < VOTER_COUNT; i++) {
            const voter = voters[i];
            const votes = [{ questionId: 'q1', selection: [0] }]; // Changed to No
            const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 2, votes };
            const merkleRoot = computeMerkleRoot(payload);
            const signature = signMerkleRoot(merkleRoot, voter.secretKey, voter.drepId);

            const { status, json, durationMs } = await api('POST', '/vote', {
                voterId: voter.drepId,
                nonce: 2,
                ballotId: prepareTxHash,
                votes,
                signature,
            });

            const utxoCount = 1 + VOTER_COUNT; // stable count during updates
            const result: TimedResult = {
                operation: 'cast_vote',
                voterIndex: i,
                utxoCount,
                durationMs,
                status,
                success: status === 200,
                error: status !== 200 ? json.message : undefined,
            };
            updateResults.push(result);
            results.push(result);

            if (status !== 200) {
                console.log(`  [${i}] FAILED (${status}): ${json.message?.slice(0, 100)}`);
            } else if (i % 5 === 0 || i === VOTER_COUNT - 1) {
                console.log(`  [${i}/${VOTER_COUNT}] ${durationMs}ms`);
            }
        }

        printStats('cast_vote', updateResults);
    }, VOTER_COUNT * 30_000);

    // ===== Phase 3: Bad votes =====

    it('should reject bad votes', async () => {
        console.log(`  Sending ${BAD_VOTE_COUNT} bad vote attempts…`);
        const badResults: TimedResult[] = [];

        for (let i = 0; i < BAD_VOTE_COUNT; i++) {
            const voter = voters[i % VOTER_COUNT];
            let body: any;
            let expectedError: string;

            switch (i % 5) {
                case 0: // Wrong nonce (too low)
                    body = {
                        voterId: voter.drepId, nonce: 1, ballotId: prepareTxHash,
                        votes: [{ questionId: 'q1', selection: [1] }],
                        signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                    };
                    expectedError = 'nonce';
                    break;
                case 1: // Missing fields
                    body = { voterId: voter.drepId };
                    expectedError = 'missing';
                    break;
                case 2: // Unknown voter
                    body = {
                        voterId: 'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4e87a0',
                        nonce: 1, ballotId: prepareTxHash,
                        votes: [{ questionId: 'q1', selection: [1] }],
                        signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                    };
                    expectedError = 'signature';
                    break;
                case 3: // Invalid selection
                    body = {
                        voterId: voter.drepId, nonce: 3, ballotId: prepareTxHash,
                        votes: [{ questionId: 'q1', selection: [99] }],
                        signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                    };
                    expectedError = 'invalid';
                    break;
                case 4: // Bad signature
                    {
                        const votes = [{ questionId: 'q1', selection: [1] }];
                        const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 3, votes };
                        computeMerkleRoot(payload);
                        body = {
                            voterId: voter.drepId, nonce: 3, ballotId: prepareTxHash, votes,
                            signature: { coseSign1Hex: 'deadbeef', coseKeyHex: 'cafebabe', key: 'bad', signature: 'bad' },
                        };
                        expectedError = 'signature';
                    }
                    break;
            }

            const path = (i % 5 === 2) ? '/vote-and-register' : '/vote';
            const { status, json, durationMs } = await api('POST', path, body);

            badResults.push({
                operation: `bad_vote_${i % 5}`,
                voterIndex: i,
                utxoCount: 1 + VOTER_COUNT,
                durationMs,
                status,
                success: status >= 400, // Success means it was rejected
                error: json.message,
            });

            const rejected = status >= 400;
            console.log(`  [bad ${i}] ${rejected ? 'REJECTED' : 'UNEXPECTED OK'} (${status}, ${durationMs}ms): ${json.message?.slice(0, 80) ?? json.code}`);
        }

        const allRejected = badResults.every(r => r.status >= 400);
        expect(allRejected).toBe(true);
    }, BAD_VOTE_COUNT * 10_000);

    // ===== Phase 4: Query performance =====

    it('should measure query performance', async () => {
        const queries = [
            { path: '/votes', method: 'GET' },
            { path: '/ballot', method: 'GET' },
            { path: `/voter/${voters[0].drepId}`, method: 'GET' },
            { path: '/audit', method: 'GET' },
            { path: '/ledger', method: 'POST' },
        ];

        for (const q of queries) {
            const { status, durationMs } = await api(q.method, q.path);
            console.log(`  ${q.method} ${q.path}: ${durationMs}ms (${status})`);
        }
    }, 30_000);

    // ===== Phase 5: Settle =====

    it('should settle: burn → finalize → close', async () => {
        const settleStart = performance.now();
        const { status, json, durationMs } = await api('POST', '/settle', {
            ballotId: prepareTxHash,
            ballotName: instanceAssetName,
            ballotPolicy: policyId,
            closeToken: CLOSE_TOKEN,
        }, 540_000);

        expect(status).toBe(200);
        console.log(`  Settle completed in ${durationMs}ms`);
        for (const step of json.data?.steps ?? []) {
            console.log(`    ${step.step}: ${step.status}`, step.data ? JSON.stringify(step.data).slice(0, 150) : '');
        }

        results.push({
            operation: 'settle',
            voterIndex: -1,
            utxoCount: 1 + VOTER_COUNT,
            durationMs,
            status,
            success: status === 200,
        });
    }, 600_000);

    // ===== Phase 6: Fanout =====

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

    it('should be Idle after fanout', async () => {
        const { json } = await api('GET', '/health');
        console.log(`  Final status: ${json.data?.headStatus}`);
        expect(json.data?.headStatus).toBe('Idle');
    });

    // ===== Phase 7: Report =====

    it('should write performance report', async () => {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportDir = path.join(process.cwd(), 'logs');
        await fs.mkdir(reportDir, { recursive: true });

        // --- Build summary lines (shared between console and file) ---
        const lines: string[] = [];
        const log = (s: string) => { lines.push(s); console.log(`  ${s}`); };

        log('========== PERFORMANCE SUMMARY ==========');
        log(`Voters: ${VOTER_COUNT}`);
        log(`Bad vote attempts: ${BAD_VOTE_COUNT}`);
        log(`Timestamp: ${new Date().toISOString()}`);
        log('');

        for (const op of ['vote-and-register', 'cast_vote'] as const) {
            const subset = results.filter(r => r.operation === op && r.success);
            const failed = results.filter(r => r.operation === op && !r.success);
            if (subset.length === 0) { log(`${op}: no data`); continue; }
            const times = subset.map(r => r.durationMs).sort((a, b) => a - b);
            const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
            const p50 = times[Math.floor(times.length * 0.5)];
            const p95 = times[Math.floor(times.length * 0.95)];
            log(`${op}: ${subset.length} ok, ${failed.length} fail | avg=${avg}ms p50=${p50}ms p95=${p95}ms min=${times[0]}ms max=${times[times.length - 1]}ms`);
        }

        const settleResult = results.find(r => r.operation === 'settle');
        if (settleResult) {
            log(`Settle (burn ${VOTER_COUNT} + finalize + close): ${settleResult.durationMs}ms`);
        }

        const registrations = results.filter(r => r.operation === 'vote-and-register' && r.success);
        if (registrations.length > 5) {
            log('');
            log('Response time by UTxO count:');
            const brackets = [
                { label: '  1-5', filter: (r: TimedResult) => r.utxoCount <= 5 },
                { label: '  6-10', filter: (r: TimedResult) => r.utxoCount > 5 && r.utxoCount <= 10 },
                { label: '  11-20', filter: (r: TimedResult) => r.utxoCount > 10 && r.utxoCount <= 20 },
                { label: '  21-50', filter: (r: TimedResult) => r.utxoCount > 20 && r.utxoCount <= 50 },
                { label: '  51-100', filter: (r: TimedResult) => r.utxoCount > 50 && r.utxoCount <= 100 },
                { label: '  100+', filter: (r: TimedResult) => r.utxoCount > 100 },
            ];
            for (const b of brackets) {
                const subset = registrations.filter(b.filter);
                if (subset.length > 0) {
                    const avg = Math.round(subset.reduce((s, r) => s + r.durationMs, 0) / subset.length);
                    log(`${b.label} UTxOs: avg=${avg}ms (n=${subset.length})`);
                }
            }
        }

        log('');
        log('==========================================');

        // --- Write raw results as JSON ---
        const jsonPath = path.join(reportDir, `load-${VOTER_COUNT}v-${timestamp}.json`);
        await fs.writeFile(jsonPath, JSON.stringify({
            config: { voters: VOTER_COUNT, badVotes: BAD_VOTE_COUNT, timestamp: new Date().toISOString() },
            summary: lines,
            results,
        }, null, 2));

        // --- Write human-readable summary as txt ---
        const txtPath = path.join(reportDir, `load-${VOTER_COUNT}v-${timestamp}.txt`);
        await fs.writeFile(txtPath, lines.join('\n') + '\n');

        console.log(`\n  Reports written to:`);
        console.log(`    ${jsonPath}`);
        console.log(`    ${txtPath}`);
    });
});
