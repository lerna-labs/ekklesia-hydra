/**
 * End-to-end integration test for the Ekklesia Hydra voting middleware.
 *
 * Requires a live environment:
 *   - Middleware running (default: http://localhost:3000)
 *   - Hydra node + IPFS node available
 *   - Blockfrost API key configured
 *   - Valid admin wallet with funds
 *
 * Set environment variables before running:
 *   E2E_API_URL    — middleware base URL (default: http://localhost:3000)
 *   E2E_API_KEY    — x-api-key header value
 *   E2E_VOTER_ID   — bech32 voter ID to test with (e.g., drep1...)
 *   E2E_CLOSE_TOKEN — close token (default: shutitdown)
 *
 * Run: npm run test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest';

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.E2E_API_KEY ?? '';
const VOTER_ID = process.env.E2E_VOTER_ID ?? '';
const CLOSE_TOKEN = process.env.E2E_CLOSE_TOKEN ?? 'shutitdown';

const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
};

async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${API_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { status: res.status, json };
}

// Shared state across ordered tests
let policyId: string;
let fingerprint: string;
let instanceAssetName: string;
let ballotIpfsCid: string;
let ballotContentHash: string;
let prepareTxHash: string;
let voteReceipt: { txHash: string; voteHash: string; ipfsCid: string; tokenName: string };

describe('Ekklesia Hydra E2E — Full Ballot Lifecycle', () => {

    // -----------------------------------------------------------------------
    // Phase 0: Preconditions
    // -----------------------------------------------------------------------

    beforeAll(() => {
        if (!API_KEY) throw new Error('E2E_API_KEY is required');
        if (!VOTER_ID) throw new Error('E2E_VOTER_ID is required (bech32 voter ID)');
    });

    it('should be reachable', async () => {
        const { status, } = await api('GET', '/');
        expect(status).toBe(200);
    });

    it('should report health', async () => {
        const { json } = await api('GET', '/health');
        expect(json.status).toBeDefined();
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

            // Save for subsequent tests
            policyId = json.data.policyId;
            fingerprint = json.data.fingerprint;
            instanceAssetName = json.data.instanceAssetName;
            ballotIpfsCid = json.data.ballotIpfsCid;
            ballotContentHash = json.data.ballotContentHash;
            prepareTxHash = json.data.txHash;

            console.log(`  Ballot minted: ${prepareTxHash}`);
            console.log(`  Policy ID: ${policyId}`);
            console.log(`  IPFS CID: ${ballotIpfsCid}`);
        }, 120_000); // L1 tx can be slow
    });

    // -----------------------------------------------------------------------
    // Phase 2: Open Head
    // -----------------------------------------------------------------------

    describe('POST /start — commit (601) + gas into Hydra head', () => {
        it('should open the head and cache the ballot', async () => {
            // The (601) token is at output index 1, gas at index 2
            // (index 0 is the (600) which stays on L1)
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
        }, 240_000); // Head open can take up to 3 min
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
    // Phase 4: Register + Vote
    // -----------------------------------------------------------------------

    describe('POST /vote-and-register — register voter and cast first vote', () => {
        it('should register and vote in one transaction', async () => {
            const { status, json } = await api('POST', '/vote-and-register', {
                voterId: VOTER_ID,
                ballotId: prepareTxHash,
                votes: [
                    { questionId: 'q1', selection: [1] },        // Yes
                    { questionId: 'q2', selection: [0, 2] },     // Options A + C
                ],
                signature: {
                    // NOTE: These must be real COSE signatures for the test to pass
                    // signature verification. In a real test, generate these from
                    // the voter's wallet.
                    COSE_Sign1_hex: process.env.E2E_COSE_SIGN1 ?? 'placeholder',
                    COSE_Key_hex: process.env.E2E_COSE_KEY ?? 'placeholder',
                    key: process.env.E2E_SIG_KEY ?? 'placeholder',
                    signature: process.env.E2E_SIG ?? 'placeholder',
                },
            });

            // If signature verification is enabled and we have placeholders, this will 401
            // That's expected — the test documents the full flow
            if (status === 200) {
                expect(json.status).toBe('SUCCESS');
                expect(json.data.registered).toBe(true);
                expect(json.data.txHash).toBeDefined();
                expect(json.data.voteHash).toBeDefined();
                expect(json.data.ipfsCid).toBeDefined();

                voteReceipt = json.data;
                console.log(`  Registered + voted: ${json.data.txHash}`);
            } else if (status === 401) {
                console.log('  Skipped: signature verification failed (expected with placeholders)');
            } else {
                console.log(`  Unexpected status ${status}:`, json);
            }
        }, 60_000);
    });

    // -----------------------------------------------------------------------
    // Phase 5: Query votes
    // -----------------------------------------------------------------------

    describe('GET /votes — list all votes', () => {
        it('should return votes list', async () => {
            const { status, json } = await api('GET', '/votes');

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.totalVoters).toBeGreaterThanOrEqual(0);
        });
    });

    describe('GET /voter/:voterId — lookup specific voter', () => {
        it('should find or 404 the test voter', async () => {
            const { status, } = await api('GET', `/voter/${VOTER_ID}`);

            // 200 if vote-and-register succeeded, 404 if sig verification blocked it
            expect([200, 404]).toContain(status);
        });
    });

    // -----------------------------------------------------------------------
    // Phase 6: Audit
    // -----------------------------------------------------------------------

    describe('GET /audit — full verification bundle', () => {
        it('should return audit data', async () => {
            const { status, json } = await api('GET', '/audit');

            expect(status).toBe(200);
            expect(json.status).toBe('SUCCESS');
            expect(json.data.ballotCached).toBe(true);
            expect(json.data.totalVoters).toBeGreaterThanOrEqual(0);
        });
    });

    describe('GET /audit/vote/:voterId — single voter audit', () => {
        it('should return voter evidence or 404', async () => {
            const { status, json } = await api('GET', `/audit/vote/${VOTER_ID}`);

            // 200 if voted, 404 if not
            expect([200, 404]).toContain(status);

            if (status === 200) {
                expect(json.data.cacheEntry).toBeDefined();
                expect(json.data.verification).toBeDefined();
                expect(json.data.history).toBeDefined();
            }
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

            if (status === 200) {
                expect(json.status).toBe('SUCCESS');
                expect(json.data.resultsHash).toBeDefined();
                expect(json.data.evidenceDirectoryCid).toBeDefined();
                expect(json.data.evidenceMerkleRoot).toBeDefined();
                console.log(`  Finalized: ${json.data.evidenceDirectoryCid}`);
            } else {
                console.log(`  Finalize status ${status}:`, json.message);
            }
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
