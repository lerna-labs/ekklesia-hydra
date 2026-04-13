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
 *
 * Run: LOAD_VOTERS=20 npm run test:load
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { SignedVotePayload } from '../src/types.js';
import {
    API_URL,
    API_KEY,
    CLOSE_TOKEN,
    DUMP_ADDRESS,
    generateDRepKeysBatch,
    generateSPOKeysBatch,
    generateCalidusSPOKeysBatch,
    generateStakeKeysBatch,
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
    attempts?: number;
    error?: string;
}

// ---------------------------------------------------------------------------
// Load-test-specific helpers
// ---------------------------------------------------------------------------

/** Build a vote signature for any voter type, including calidus declaration when needed. */
function buildVoteSignature(voter: DRepKeys, merkleRoot: string): any {
    const signingAddress = voter.calidusId ?? voter.drepId;
    const sig: any = { ...signMerkleRoot(merkleRoot, voter.secretKey, signingAddress) };
    if (voter.calidusId) {
        sig.calidusDeclaration = { calidusId: voter.calidusId };
    }
    return sig;
}

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

    // Retry stats (if any results have attempts > 1)
    const withRetries = successful.filter(r => r.attempts && r.attempts > 1);
    if (withRetries.length > 0) {
        const totalRetries = withRetries.reduce((s, r) => s + ((r.attempts ?? 1) - 1), 0);
        const maxAttempts = Math.max(...withRetries.map(r => r.attempts ?? 1));
        console.log(`  [${label}] Retries: ${withRetries.length}/${successful.length} needed retry, ${totalRetries} total retries, max ${maxAttempts} attempts`);
    }
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let prepareTxHash: string;
let policyId: string;
let instanceAssetName: string;
let ballotIpfsCid: string;
let votingOpenTime: number;
// Hard bail: head setup or registration failed — nothing else can run.
// Soft bail: voting/adversarial phase failed — settlement must still run.
let hardBail = false;
let softFailures: string[] = [];
let setupStartTime: number;
let setupDurationMs: number;
let keyGenDurationMs: number;
const voters: DRepKeys[] = [];
const results: TimedResult[] = [];
let adversarialResults: Array<{ name: string; status: number; expected: number; code?: string; pass: boolean; durationMs: number }> = [];
let burstResults: Array<{ phase: string; total: number; succeeded: number; failed: number; fetchErrors: number; elapsedMs: number; times?: number[] }> = [];
// Pipeline marker for the perf summary. With the unified queue worker
// there's only one path, so this is constant.
const txMode = 'queue';

// Key generation runs concurrently with setup phases.
// Started in beforeAll, awaited before voting begins.
let keyGenPromise: Promise<DRepKeys[]>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(`Ekklesia Hydra Load Test — ${VOTER_COUNT} voters`, () => {

    beforeAll(() => {
        if (!API_URL) throw new Error('E2E_API_URL is required');
        if (!API_KEY) throw new Error('E2E_API_KEY is required');

        // Fire off key generation in the background — runs concurrently with
        // sweep, prepare, L1 confirmation, and head open. Awaited before voting.
        // Mixed voter population: ~60% DRep, ~10% SPO (cold key), ~10% SPO (calidus), ~20% Stakeholder
        const drepCount = Math.ceil(VOTER_COUNT * 0.6);
        const spoColdCount = Math.floor(VOTER_COUNT * 0.1);
        const spoCalidusCount = Math.floor(VOTER_COUNT * 0.1);
        const stakeCount = VOTER_COUNT - drepCount - spoColdCount - spoCalidusCount;
        const genStart = performance.now();
        console.log(`  Generating ${VOTER_COUNT} voter keys (${drepCount} DRep, ${spoColdCount} SPO-cold, ${spoCalidusCount} SPO-calidus, ${stakeCount} Stakeholder)…`);
        keyGenPromise = Promise.all([
            generateDRepKeysBatch(drepCount),
            generateSPOKeysBatch(spoColdCount),
            generateCalidusSPOKeysBatch(spoCalidusCount),
            generateStakeKeysBatch(stakeCount),
        ]).then(([dreps, sposCold, sposCalidus, stakes]) => {
            const spos = [...sposCold, ...sposCalidus];
            // Interleave voter types for realistic ordering
            const all: DRepKeys[] = [];
            const sources = [dreps, spos, stakes];
            const indices = [0, 0, 0];
            while (all.length < VOTER_COUNT) {
                for (let s = 0; s < sources.length; s++) {
                    if (indices[s] < sources[s].length) {
                        all.push(sources[s][indices[s]++]);
                    }
                }
            }
            keyGenDurationMs = Math.round(performance.now() - genStart);
            console.log(`  Keys generated in ${keyGenDurationMs}ms`);
            return all;
        });
    });

    // Tests that must always run regardless of earlier failures.
    const alwaysRun = new Set([
        'should settle: burn → finalize → close',
        'should fanout to L1',
        'should be Idle after fanout',
        'should write performance report',
    ]);

    // Tests where failure is "soft" — logged but doesn't block settlement.
    const softPhases = new Set([
        'should update all votes',
        'should handle concurrent vote updates',
        'should handle concurrent vote updates without contention',
        'should reject all adversarial inputs',
        'should measure query performance',
    ]);

    beforeEach(({ task }) => {
        if (alwaysRun.has(task.name)) return; // never skip these
        if (hardBail) {
            console.log(`  SKIPPED: ${task.name}`);
            throw new Error('Skipped — head setup or registration failed');
        }
    });

    afterEach(({ task }) => {
        if (task.result?.state === 'fail') {
            if (softPhases.has(task.name)) {
                softFailures.push(task.name);
                console.log(`  SOFT FAILURE: ${task.name} (settlement will still run)`);
            } else if (!alwaysRun.has(task.name)) {
                hardBail = true;
            }
        }
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
        setupStartTime = performance.now();
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
                acceptedCredentials: ['0x22', '0x06', '0xe0'], merkleRoot: '', ballotIpfsCid: '',
                votingWindow: {
                    open: new Date((votingOpenTime = Date.now() + 360_000)).toISOString(),
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
        setupDurationMs = Math.round(performance.now() - setupStartTime);
        console.log(`  Head opened (setup: ${Math.round(setupDurationMs / 1000)}s, pipeline: ${txMode})`);
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
        // Await key generation — may already be done if setup took long enough
        const keys = await keyGenPromise;
        voters.push(...keys);
        console.log(`  Registering ${VOTER_COUNT} voters via vote-and-register…`);

        for (let i = 0; i < VOTER_COUNT; i++) {
            const voter = voters[i];
            const votes = [{ questionId: 'q1', selection: [1] }]; // Yes
            const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: 1, votes };
            const merkleRoot = computeMerkleRoot(payload);
            const signature = buildVoteSignature(voter, merkleRoot);

            const { status, json, durationMs } = await api('POST', '/vote-and-register', {
                voterId: voter.drepId,
                ballotId: prepareTxHash,
                votes,
                signature,
                responderRole: voter.role,
            });

            const utxoCount = 1 + (i + 1); // ballot token + i voter tokens
            results.push({
                operation: 'vote-and-register',
                voterIndex: i,
                utxoCount,
                durationMs,
                status,
                success: status === 200,
                attempts: json.data?.attempts,
                error: status !== 200 ? json.message : undefined,
            });

            if (status !== 200) {
                console.log(`  [${i}] FAILED (${status}): ${json.message?.slice(0, 100)}`);
            } else if (i % Math.max(1, Math.floor(VOTER_COUNT / 10)) === 0 || i === VOTER_COUNT - 1) {
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
            const signature = buildVoteSignature(voter, merkleRoot);

            const { status, json, durationMs } = await api('POST', '/vote', {
                voterId: voter.drepId,
                nonce: 2,
                ballotId: prepareTxHash,
                votes,
                signature,
                responderRole: voter.role,
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
            } else if (i % Math.max(1, Math.floor(VOTER_COUNT / 10)) === 0 || i === VOTER_COUNT - 1) {
                console.log(`  [${i}/${VOTER_COUNT}] ${durationMs}ms`);
            }
        }

        printStats('cast_vote', updateResults);
    }, VOTER_COUNT * 30_000);

    // ===== Phase 2b: Concurrent vote burst =====
    //
    // Fire a percentage of voters simultaneously to test Express + TRP
    // under concurrent load. Some will succeed, some will fail due to
    // UTxO contention — we measure both to understand the failure mode.

    it('should handle concurrent vote updates', async () => {
        const concurrentCount = Math.max(5, Math.floor(VOTER_COUNT * 0.1)); // 10% of voters
        const concurrentVoters = voters.slice(0, concurrentCount);

        // Query each voter's current version so we use the correct next nonce
        const voterVersions = new Map<string, number>();
        for (const voter of concurrentVoters) {
            const { json } = await api('GET', `/voter/${voter.drepId}`);
            voterVersions.set(voter.drepId, json.data?.version ?? 2);
        }
        console.log(`  Firing ${concurrentCount} concurrent vote updates (each at current nonce + 1)…`);

        const startTime = performance.now();

        const promises = concurrentVoters.map(async (voter, i) => {
            const nextNonce = (voterVersions.get(voter.drepId) ?? 2) + 1;
            const votes = [{ questionId: 'q1', selection: [2] }]; // Abstain
            const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: nextNonce, votes };
            const merkleRoot = computeMerkleRoot(payload);
            const signature = buildVoteSignature(voter, merkleRoot);

            try {
                const { status, json, durationMs } = await api('POST', '/vote', {
                    voterId: voter.drepId,
                    nonce: nextNonce,
                    ballotId: prepareTxHash,
                    votes,
                    signature,
                    responderRole: voter.role,
                });
                return { index: i, status, durationMs, message: json.message?.slice(0, 80), code: json.code };
            } catch (err: any) {
                return { index: i, status: -1, durationMs: 0, message: err.message?.slice(0, 80) ?? 'fetch error', code: 'FETCH_ERROR' };
            }
        });

        const concurrentResults = await Promise.all(promises);
        const elapsed = Math.round(performance.now() - startTime);

        const succeeded = concurrentResults.filter(r => r.status === 200);
        const failed = concurrentResults.filter(r => r.status !== 200);
        const fetchErrors = concurrentResults.filter(r => r.status === -1);

        const successTimes = succeeded.map(r => r.durationMs).sort((a, b) => a - b);
        burstResults.push({
            phase: '2b (10% concurrent votes)',
            total: concurrentCount,
            succeeded: succeeded.length,
            failed: failed.length,
            fetchErrors: fetchErrors.length,
            elapsedMs: elapsed,
            times: successTimes,
        });

        console.log(`  Concurrent burst completed in ${elapsed}ms`);
        console.log(`  Succeeded: ${succeeded.length}/${concurrentCount}`);
        console.log(`  Failed: ${failed.length}/${concurrentCount}${fetchErrors.length ? ` (${fetchErrors.length} fetch errors)` : ''}`);

        if (failed.length > 0) {
            // Group failures by status code
            const byStatus = new Map<number, number>();
            for (const r of failed) {
                byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
            }
            for (const [status, count] of byStatus) {
                const example = failed.find(r => r.status === status);
                console.log(`    ${status}: ${count} (e.g. ${example?.code ?? ''} — ${example?.message ?? ''})`);
            }
        }

        // At least one should succeed (the first to hit TRP)
        expect(succeeded.length).toBeGreaterThan(0);

        // None should crash the server (no 500s from uncaught exceptions)
        const serverErrors = concurrentResults.filter(r => r.status >= 500);
        if (serverErrors.length > 0) {
            console.log(`  SERVER ERRORS (${serverErrors.length}):`);
            for (const r of serverErrors) {
                console.log(`    [${r.index}] ${r.status}: ${r.message}`);
            }
        }
        expect(serverErrors.length).toBe(0);

        // Sequentially retry the failed ones so all voters advance
        if (failed.length > 0) {
            console.log(`  Retrying ${failed.length} failed concurrent votes sequentially…`);
            let retried = 0;
            for (const r of failed) {
                const voter = concurrentVoters[r.index];
                // Re-query current version in case it changed
                const { json: voterState } = await api('GET', `/voter/${voter.drepId}`);
                const retryNonce = (voterState.data?.version ?? 2) + 1;
                const votes = [{ questionId: 'q1', selection: [2] }];
                const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: retryNonce, votes };
                const merkleRoot = computeMerkleRoot(payload);
                const signature = buildVoteSignature(voter, merkleRoot);

                const { status } = await api('POST', '/vote', {
                    voterId: voter.drepId, nonce: retryNonce, ballotId: prepareTxHash, votes, signature, responderRole: voter.role,
                });
                if (status === 200) retried++;
            }
            console.log(`  Retried: ${retried}/${failed.length} succeeded`);
        }
    }, VOTER_COUNT * 30_000);

    // ===== Phase 2c: Concurrent vote update burst (voter-owned UTxOs) =====
    //
    // Each voter's cast_vote spends their OWN UTxO, not the shared ballot token.
    // Hydra should batch non-contending transactions into the next snapshot.
    // This tests that theory — 50%+ of voters updating simultaneously.

    it('should handle concurrent vote updates without contention', async () => {
        const concurrentCount = Math.max(5, Math.floor(VOTER_COUNT * 0.5)); // 50% of voters
        // Use voters from the second half to avoid overlap with Phase 2b
        const phase2bCount = Math.max(5, Math.floor(VOTER_COUNT * 0.1));
        const startIdx = phase2bCount;
        const concurrentVoters = voters.slice(startIdx, startIdx + concurrentCount);

        // Query each voter's current version for correct nonce
        const voterVersions = new Map<string, number>();
        for (const voter of concurrentVoters) {
            const { json } = await api('GET', `/voter/${voter.drepId}`);
            voterVersions.set(voter.drepId, json.data?.version ?? 2);
        }
        console.log(`  Firing ${concurrentCount} concurrent vote updates (voters ${startIdx}-${startIdx + concurrentCount - 1}, each at current nonce + 1)…`);

        const startTime = performance.now();

        const promises = concurrentVoters.map(async (voter, i) => {
            const nextNonce = (voterVersions.get(voter.drepId) ?? 2) + 1;
            const votes = [{ questionId: 'q1', selection: [1] }]; // Back to Yes
            const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: nextNonce, votes };
            const merkleRoot = computeMerkleRoot(payload);
            const signature = buildVoteSignature(voter, merkleRoot);

            try {
                const { status, json, durationMs } = await api('POST', '/vote', {
                    voterId: voter.drepId,
                    nonce: nextNonce,
                    ballotId: prepareTxHash,
                    votes,
                    signature,
                    responderRole: voter.role,
                });
                return { index: i, status, durationMs, message: json.message?.slice(0, 80), code: json.code };
            } catch (err: any) {
                return { index: i, status: -1, durationMs: 0, message: err.message?.slice(0, 80) ?? 'fetch error', code: 'FETCH_ERROR' };
            }
        });

        const concurrentResults = await Promise.all(promises);
        const elapsed = Math.round(performance.now() - startTime);

        const succeeded = concurrentResults.filter(r => r.status === 200);
        const failed = concurrentResults.filter(r => r.status !== 200);
        const fetchErrors = concurrentResults.filter(r => r.status === -1);
        const serverErrors = concurrentResults.filter(r => r.status >= 500);
        const times = succeeded.map(r => r.durationMs).sort((a, b) => a - b);

        burstResults.push({
            phase: '2c (50% concurrent votes)',
            total: concurrentCount,
            succeeded: succeeded.length,
            failed: failed.length,
            fetchErrors: fetchErrors.length,
            elapsedMs: elapsed,
            times,
        });

        console.log(`  Concurrent vote update burst completed in ${elapsed}ms`);
        console.log(`  Succeeded: ${succeeded.length}/${concurrentCount} (${Math.round(succeeded.length / concurrentCount * 100)}%)`);
        if (times.length > 0) {
            const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
            const p50 = times[Math.floor(times.length * 0.5)];
            const p95 = times[Math.floor(times.length * 0.95)];
            console.log(`  Response times: avg=${avg}ms p50=${p50}ms p95=${p95}ms min=${times[0]}ms max=${times[times.length - 1]}ms`);
        }

        if (failed.length > 0) {
            console.log(`  Failed: ${failed.length}/${concurrentCount}`);
            const byStatus = new Map<number, number>();
            for (const r of failed) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
            for (const [status, count] of byStatus) {
                const example = failed.find(r => r.status === status);
                console.log(`    ${status}: ${count} (e.g. ${example?.code ?? ''} — ${example?.message ?? ''})`);
            }
        }

        // No server crashes
        expect(serverErrors.length).toBe(0);

        // Sequentially retry the failed ones so all voters advance
        if (failed.length > 0) {
            console.log(`  Retrying ${failed.length} failed concurrent votes sequentially…`);
            let retried = 0;
            for (const r of failed) {
                const voter = concurrentVoters[r.index];
                const { json: voterState } = await api('GET', `/voter/${voter.drepId}`);
                const retryNonce = (voterState.data?.version ?? 2) + 1;
                const votes = [{ questionId: 'q1', selection: [1] }];
                const payload: SignedVotePayload = { ballotId: prepareTxHash, nonce: retryNonce, votes };
                const merkleRoot = computeMerkleRoot(payload);
                const signature = buildVoteSignature(voter, merkleRoot);

                const { status } = await api('POST', '/vote', {
                    voterId: voter.drepId, nonce: retryNonce, ballotId: prepareTxHash, votes, signature, responderRole: voter.role,
                });
                if (status === 200) retried++;
            }
            console.log(`  Retried: ${retried}/${failed.length} succeeded`);
        }

        // With voter-owned UTxOs, we expect high success rate
        const successRate = succeeded.length / concurrentCount;
        console.log(`  Success rate: ${Math.round(successRate * 100)}%`);
        expect(successRate).toBeGreaterThan(0.5);
    }, VOTER_COUNT * 30_000);

    // ===== Phase 3: Adversarial input testing =====
    //
    // Fixed test matrix — every case runs exactly once.
    // Covers: missing/malformed fields, replay attacks, identity spoofing,
    // invalid selections, bad signatures, type confusion, and injection attempts.

    it('should reject all adversarial inputs', async () => {
        const voter = voters[0];
        const otherVoter = voters[1 % VOTER_COUNT];

        // Query actual current version so nonces are correct after earlier phases
        const { json: voterState } = await api('GET', `/voter/${voter.drepId}`);
        const currentVersion = voterState.data?.version ?? 2;
        const nextNonce = currentVersion + 1; // valid nonce for deeper validation tests

        // Valid signature helper — produces a real sig so we can test deeper validation layers
        const validVotes = [{ questionId: 'q1', selection: [1] }];
        const validPayload: SignedVotePayload = { ballotId: prepareTxHash, nonce: nextNonce, votes: validVotes };
        const validMerkleRoot = computeMerkleRoot(validPayload);
        const validSig = signMerkleRoot(validMerkleRoot, voter.secretKey, voter.drepId);

        // Wrong-content signature (signed different data than what's submitted)
        const wrongPayload: SignedVotePayload = { ballotId: 'wrong', nonce: 99, votes: validVotes };
        const wrongMerkleRoot = computeMerkleRoot(wrongPayload);
        const wrongContentSig = signMerkleRoot(wrongMerkleRoot, voter.secretKey, voter.drepId);

        // Cross-voter signature (voter A signs, submitted as voter B)
        const crossSig = signMerkleRoot(validMerkleRoot, voter.secretKey, voter.drepId);

        const cases: Array<{
            name: string;
            endpoint: string;
            body: any;
            expectedStatus: number;
            expectedCode?: string;
        }> = [
            // --- Missing / malformed fields ---
            {
                name: 'empty body',
                endpoint: '/vote',
                body: {},
                expectedStatus: 400,
                expectedCode: 'MISSING_FIELDS',
            },
            {
                name: 'null body',
                endpoint: '/vote',
                body: null,
                expectedStatus: 400,
            },
            {
                name: 'only voterId (missing nonce, ballotId, votes, signature)',
                endpoint: '/vote',
                body: { voterId: voter.drepId },
                expectedStatus: 400,
                expectedCode: 'MISSING_FIELDS',
            },
            {
                name: 'missing signature',
                endpoint: '/vote',
                body: { voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash, votes: validVotes },
                expectedStatus: 400,
                expectedCode: 'MISSING_FIELDS',
            },
            {
                name: 'missing votes array',
                endpoint: '/vote',
                body: { voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash, signature: validSig },
                expectedStatus: 400,
                expectedCode: 'MISSING_FIELDS',
            },
            {
                name: 'empty string voterId',
                endpoint: '/vote',
                body: { voterId: '', nonce: nextNonce, ballotId: prepareTxHash, votes: validVotes, signature: validSig },
                expectedStatus: 400,
                expectedCode: 'MISSING_FIELDS',
            },

            // --- Invalid voter IDs (bech32 attacks) ---
            {
                name: 'invalid bech32 checksum',
                endpoint: '/vote',
                body: {
                    voterId: 'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4e87a0',
                    nonce: 1, ballotId: prepareTxHash, votes: validVotes,
                    signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },
            {
                name: 'invalid bech32 checksum (vote-and-register)',
                endpoint: '/vote-and-register',
                body: {
                    voterId: 'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4e87a0',
                    ballotId: prepareTxHash, votes: validVotes,
                    signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },
            {
                name: 'invalid bech32 checksum (register)',
                endpoint: '/register',
                body: { voterId: 'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4e87a0' },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },
            {
                name: 'completely garbage voterId',
                endpoint: '/vote',
                body: {
                    voterId: 'not-a-bech32-string-at-all!!!',
                    nonce: nextNonce, ballotId: prepareTxHash, votes: validVotes,
                    signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },
            {
                name: 'wrong bech32 prefix (addr instead of drep)',
                endpoint: '/vote',
                body: {
                    voterId: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
                    nonce: nextNonce, ballotId: prepareTxHash, votes: validVotes,
                    signature: { coseSign1Hex: 'dead', coseKeyHex: 'beef', key: '', signature: '' },
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },

            // --- Replay / nonce attacks ---
            {
                name: `stale nonce (nonce=1, current version=${currentVersion})`,
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: 1, ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                expectedStatus: 409,
                expectedCode: 'CONFLICT',
            },
            {
                name: `same nonce as current (nonce=${currentVersion}, current=${currentVersion})`,
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: currentVersion, ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                expectedStatus: 409,
                expectedCode: 'CONFLICT',
            },
            {
                name: 'nonce zero',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: 0, ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                expectedStatus: 400,
                // nonce: 0 is falsy → caught by !nonce in MISSING_FIELDS check
            },
            {
                name: 'negative nonce',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: -1, ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                expectedStatus: 409,
                // -1 <= 2, caught by replay protection
            },

            // --- Duplicate registration ---
            {
                name: 'vote-and-register for already registered voter',
                endpoint: '/vote-and-register',
                body: {
                    voterId: voter.drepId, ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                expectedStatus: 409,
                expectedCode: 'CONFLICT',
            },

            // --- Invalid vote selections ---
            {
                name: 'option value not in ballot (99)',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'q1', selection: [99] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },
            {
                name: 'unknown questionId',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'nonexistent_question', selection: [1] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },
            {
                name: 'empty votes array',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [],
                    signature: validSig,
                },
                // [] is truthy → passes !votes. validateSelections([]) returns null
                // (no questions to check). Proceeds to sig verification → SIGNATURE_INVALID
                // (merkle root of empty votes won't match what was signed)
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'multiple selections on binary question',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'q1', selection: [1, 0] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },
            {
                name: 'no selection on binary question',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'q1', selection: [] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },
            {
                name: 'missing selection field entirely',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'q1' }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },

            // --- Signature attacks ---
            {
                name: 'garbage signature bytes',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: validVotes,
                    signature: { coseSign1Hex: 'deadbeef', coseKeyHex: 'cafebabe', key: 'bad', signature: 'bad' },
                },
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'empty signature fields',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: validVotes,
                    signature: { coseSign1Hex: '', coseKeyHex: '', key: '', signature: '' },
                },
                // Empty strings are falsy → falls through to 'No valid signature data provided'
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'valid signature but wrong content (signed different payload)',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: validVotes,
                    signature: wrongContentSig,
                },
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'cross-voter: voter A signature submitted as voter B',
                endpoint: '/vote',
                body: {
                    voterId: otherVoter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: validVotes,
                    signature: crossSig, // signed by voter A
                },
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },

            // --- Type confusion / injection ---
            {
                name: 'nonce as string instead of number',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: String(nextNonce), ballotId: prepareTxHash,
                    votes: validVotes, signature: validSig,
                },
                // String '3' is truthy → passes !nonce. JS coerces '3' to 3 for <= check
                // → passes replay. Proceeds to sig verification → SIGNATURE_INVALID
                // (merkle root computed from string nonce won't match what was signed)
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'selection as string instead of number',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: 'q1', selection: ['1'] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT',
            },
            {
                name: 'votes as object instead of array',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: { questionId: 'q1', selection: [1] },
                    signature: validSig,
                },
                // {} is truthy → passes !votes. for..of on object throws
                // "is not iterable" → caught by outer try/catch → 400
                expectedStatus: 400,
            },
            {
                name: 'extremely long voterId (buffer overflow attempt)',
                endpoint: '/vote',
                body: {
                    voterId: 'drep1' + 'q'.repeat(10000),
                    nonce: nextNonce, ballotId: prepareTxHash, votes: validVotes,
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_VOTER_ID',
            },
            {
                name: 'SQL injection in ballotId',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce,
                    ballotId: "'; DROP TABLE votes; --",
                    votes: validVotes, signature: validSig,
                },
                // Merkle root computed from injected ballotId won't match signed payload
                expectedStatus: 401,
                expectedCode: 'SIGNATURE_INVALID',
            },
            {
                name: 'XSS in questionId',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: [{ questionId: '<script>alert(1)</script>', selection: [1] }],
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT', // Unknown questionId
            },
            {
                name: 'enormous payload (1000 vote entries)',
                endpoint: '/vote',
                body: {
                    voterId: voter.drepId, nonce: nextNonce, ballotId: prepareTxHash,
                    votes: Array.from({ length: 1000 }, (_, i) => ({ questionId: `q${i}`, selection: [1] })),
                    signature: validSig,
                },
                expectedStatus: 400,
                expectedCode: 'INVALID_INPUT', // Unknown questionIds
            },

            // --- Auth / endpoint abuse ---
            {
                name: 'register already-registered voter',
                endpoint: '/register',
                body: { voterId: voter.drepId },
                // Caught by cache check before reaching TRP
                expectedStatus: 409,
                expectedCode: 'CONFLICT',
            },
        ];

        console.log(`  Running ${cases.length} adversarial test cases…`);
        const badResults: Array<{ name: string; status: number; expected: number; code?: string; pass: boolean; durationMs: number }> = [];
        let passed = 0;
        let failed = 0;

        for (const tc of cases) {
            const { status, json, durationMs } = await api('POST', tc.endpoint, tc.body);
            const rejected = status >= 400;
            const statusMatch = tc.expectedStatus ? status === tc.expectedStatus : rejected;
            const codeMatch = !tc.expectedCode || json.code === tc.expectedCode;
            const pass = rejected && statusMatch && codeMatch;

            badResults.push({ name: tc.name, status, expected: tc.expectedStatus, code: json.code, pass, durationMs });

            if (pass) {
                passed++;
                console.log(`  ✓ ${tc.name} → ${status} ${json.code ?? ''} (${durationMs}ms)`);
            } else {
                failed++;
                console.log(`  ✗ ${tc.name} → ${status} ${json.code ?? ''} (expected ${tc.expectedStatus}${tc.expectedCode ? ' ' + tc.expectedCode : ''}) (${durationMs}ms): ${json.message?.slice(0, 100) ?? ''}`);
            }
        }

        adversarialResults = badResults;
        console.log(`\n  Adversarial results: ${passed}/${cases.length} passed, ${failed} failed`);

        // Every bad request must be rejected (status >= 400)
        const allRejected = badResults.every(r => r.status >= 400);
        expect(allRejected).toBe(true);

        // Log any unexpected acceptances for investigation
        const unexpected = badResults.filter(r => !r.pass);
        if (unexpected.length > 0) {
            console.log('\n  Unexpected results:');
            for (const r of unexpected) {
                console.log(`    ${r.name}: got ${r.status} ${r.code}, expected ${r.expected}`);
            }
        }
    }, 120_000);

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

        // --- Step 1: Burn all voter tokens ---
        // Call /settle/burn until remaining === 0 (retries handle partial failures)
        let burnTotal = 0;
        let burnAttempts = 0;
        let lastRemaining = Infinity;
        while (burnAttempts < 10) {
            burnAttempts++;
            const { status: burnStatus, json: burnJson } = await api('POST', '/settle/burn', {}, 600_000);
            if (burnStatus !== 200) {
                console.log(`  Burn FAILED (${burnStatus}): ${JSON.stringify(burnJson).slice(0, 300)}`);
                break;
            }
            burnTotal += burnJson.data?.burned ?? 0;
            const remaining = burnJson.data?.remaining ?? 0;
            console.log(`  Burn pass ${burnAttempts}: burned=${burnJson.data?.burned}, failed=${burnJson.data?.failed}, remaining=${remaining}`);
            if (remaining === 0) break;
            // Safety: if remaining isn't decreasing, stop to avoid infinite loop
            if (remaining >= lastRemaining) {
                console.log(`  Burn stalled — remaining not decreasing (${remaining} >= ${lastRemaining})`);
                break;
            }
            lastRemaining = remaining;
        }

        // --- Step 2: Finalize (tally + evidence + datum update) ---
        const { status: finalizeStatus, json: finalizeJson, durationMs: finalizeDurationMs } = await api('POST', '/settle/finalize', {
            ballotId: prepareTxHash,
            ballotName: instanceAssetName,
            ballotPolicy: policyId,
        }, 300_000);

        if (finalizeStatus !== 200) {
            console.log(`  Finalize FAILED (${finalizeStatus}): ${JSON.stringify(finalizeJson).slice(0, 500)}`);
        }
        expect(finalizeStatus).toBe(200);
        console.log(`  Finalized in ${finalizeDurationMs}ms: ${finalizeJson.data?.totalVoters} voters, ${finalizeJson.data?.excludedVoters?.length ?? 0} excluded`);

        // --- Step 3: Close head ---
        const { status: closeStatus, json: closeJson, durationMs: closeDurationMs } = await api('POST', '/settle/close', {
            closeToken: CLOSE_TOKEN,
        }, 660_000);

        if (closeStatus !== 200) {
            console.log(`  Close FAILED (${closeStatus}): ${JSON.stringify(closeJson).slice(0, 300)}`);
        }
        expect(closeStatus).toBe(200);

        const totalDurationMs = Math.round(performance.now() - settleStart);
        console.log(`  Settle completed in ${totalDurationMs}ms (burn: ${burnAttempts} passes, finalize: ${finalizeDurationMs}ms, close: ${closeDurationMs}ms)`);

        results.push({
            operation: 'settle',
            voterIndex: -1,
            utxoCount: 1 + VOTER_COUNT,
            durationMs: totalDurationMs,
            status: closeStatus,
            success: closeStatus === 200,
        });
    }, 1260_000); // 21 min vitest timeout

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
        log(`Voters: ${VOTER_COUNT} | Pipeline: ${txMode} (TRP resolve + WS submit + queue worker)`);
        log(`Key generation: ${Math.round(keyGenDurationMs / 1000)}s (concurrent with setup)`);
        log(`Setup (sweep → prepare → L1 confirm → head open): ${Math.round(setupDurationMs / 1000)}s`);
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

        // --- Retry stats ---
        log('');
        log('Retry stats (queue worker):');
        for (const op of ['vote-and-register', 'cast_vote'] as const) {
            const subset = results.filter(r => r.operation === op && r.success && r.attempts);
            if (subset.length === 0) continue;
            const withRetries = subset.filter(r => (r.attempts ?? 1) > 1);
            const totalRetries = withRetries.reduce((s, r) => s + ((r.attempts ?? 1) - 1), 0);
            const maxAttempts = subset.length > 0 ? Math.max(...subset.map(r => r.attempts ?? 1)) : 1;
            log(`  ${op}: ${withRetries.length}/${subset.length} needed retry, ${totalRetries} total retries, max ${maxAttempts} attempts`);
        }

        // --- Concurrent burst results ---
        if (burstResults.length > 0) {
            log('');
            log('Concurrent burst results:');
            for (const b of burstResults) {
                const successRate = b.total > 0 ? Math.round(b.succeeded / b.total * 100) : 0;
                log(`  ${b.phase}: ${b.succeeded}/${b.total} succeeded (${successRate}%) in ${b.elapsedMs}ms${b.fetchErrors ? `, ${b.fetchErrors} fetch errors` : ''}`);
                if (b.times && b.times.length > 0) {
                    const avg = Math.round(b.times.reduce((s, t) => s + t, 0) / b.times.length);
                    const p50 = b.times[Math.floor(b.times.length * 0.5)];
                    const p95 = b.times[Math.floor(b.times.length * 0.95)];
                    log(`    Response times: avg=${avg}ms p50=${p50}ms p95=${p95}ms min=${b.times[0]}ms max=${b.times[b.times.length - 1]}ms`);
                }
            }
        }

        // --- Adversarial test results ---
        if (adversarialResults.length > 0) {
            const advPassed = adversarialResults.filter(r => r.pass).length;
            const advFailed = adversarialResults.filter(r => !r.pass).length;
            log('');
            log(`Adversarial inputs: ${advPassed}/${adversarialResults.length} passed, ${advFailed} failed`);
            for (const r of adversarialResults) {
                const mark = r.pass ? 'PASS' : 'FAIL';
                const detail = r.pass
                    ? `${r.status} ${r.code ?? ''}`
                    : `got ${r.status} ${r.code ?? ''}, expected ${r.expected}`;
                log(`  [${mark}] ${r.name} — ${detail} (${r.durationMs}ms)`);
            }
        }

        // --- Evidence package sizes ---
        log('');
        log('Evidence package sizes:');
        try {
            // Fetch audit bundle to measure total evidence payload
            const { json: auditJson, durationMs: auditMs } = await api('GET', '/audit');
            const auditSize = JSON.stringify(auditJson).length;
            log(`  Audit bundle: ${(auditSize / 1024).toFixed(1)} KB (${auditMs}ms)`);

            // Fetch single voter evidence to measure per-voter size
            if (voters.length > 0) {
                const { json: voterJson } = await api('GET', `/audit/vote/${voters[0].drepId}`);
                const voterSize = JSON.stringify(voterJson).length;
                log(`  Single voter evidence: ${(voterSize / 1024).toFixed(1)} KB`);
                log(`  Estimated total evidence: ${(voterSize * VOTER_COUNT / 1024).toFixed(1)} KB (${VOTER_COUNT} voters)`);
            }

            // Fetch votes list to measure cache payload
            const { json: votesJson } = await api('GET', '/votes');
            const votesSize = JSON.stringify(votesJson).length;
            log(`  Votes index: ${(votesSize / 1024).toFixed(1)} KB`);
        } catch (e: any) {
            log(`  (Evidence sizes unavailable — head may be closed: ${e.message?.slice(0, 60)})`);
        }

        const registrations = results.filter(r => r.operation === 'vote-and-register' && r.success);
        if (registrations.length > 5) {
            log('');
            log('Response time by UTxO count:');
            const brackets = [
                { label: '  1-10', filter: (r: TimedResult) => r.utxoCount <= 10 },
                { label: '  11-50', filter: (r: TimedResult) => r.utxoCount > 10 && r.utxoCount <= 50 },
                { label: '  51-100', filter: (r: TimedResult) => r.utxoCount > 50 && r.utxoCount <= 100 },
                { label: '  101-250', filter: (r: TimedResult) => r.utxoCount > 100 && r.utxoCount <= 250 },
                { label: '  251-500', filter: (r: TimedResult) => r.utxoCount > 250 && r.utxoCount <= 500 },
                { label: '  501-750', filter: (r: TimedResult) => r.utxoCount > 500 && r.utxoCount <= 750 },
                { label: '  751-1000', filter: (r: TimedResult) => r.utxoCount > 750 && r.utxoCount <= 1000 },
                { label: '  1001+', filter: (r: TimedResult) => r.utxoCount > 1000 },
            ];
            for (const b of brackets) {
                const subset = registrations.filter(b.filter);
                if (subset.length > 0) {
                    const avg = Math.round(subset.reduce((s, r) => s + r.durationMs, 0) / subset.length);
                    log(`${b.label} UTxOs: avg=${avg}ms (n=${subset.length})`);
                }
            }
        }

        if (softFailures.length > 0) {
            log('');
            log('Soft failures (did not block settlement):');
            for (const name of softFailures) {
                log(`  - ${name}`);
            }
        }

        if (hardBail) {
            log('');
            log('HARD BAIL: Head setup or registration failed — settlement was skipped');
        }

        log('');
        log('==========================================');

        // --- Write raw results as JSON ---
        const jsonPath = path.join(reportDir, `load-${VOTER_COUNT}v-${timestamp}.json`);
        await fs.writeFile(jsonPath, JSON.stringify({
            config: { voters: VOTER_COUNT, txMode, timestamp: new Date().toISOString() },
            summary: lines,
            softFailures,
            hardBail,
            burstResults,
            adversarialResults,
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
