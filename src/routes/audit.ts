import { Router } from 'express';
import { ipfs, voteCache, getVoteHistory, success, error } from '../helpers.js';
import { getCachedBallot } from './lifecycle.js';
import type { VoteEvidence } from '../types.js';

const router = Router();

/**
 * GET /audit
 *
 * Full verification bundle for the current ballot.
 * Returns everything an auditor needs to independently verify the vote:
 *   - Ballot definition
 *   - All voter IDs with their vote hashes and IPFS CIDs
 *   - Total voter count
 *
 * Can be called during voting (live audit) or after finalization (retroactive).
 */
router.get('/audit', (_, res) => {
    const ballot = getCachedBallot();
    const allVotes = voteCache.getAll();

    return success(res, {
        ballot: ballot ?? null,
        ballotCached: ballot !== null,
        totalVoters: allVotes.length,
        voters: allVotes.map((v) => ({
            voterId: v.voterId,
            credentialHrp: v.credentialHrp,
            voteHash: v.voteHash,
            ipfsCid: v.ipfsCid,
            version: v.version,
            txHash: v.txHash,
            timestamp: v.timestamp,
        })),
    });
});

/**
 * GET /audit/vote/:voterId
 *
 * Full verification bundle for a single voter.
 * Fetches the complete vote evidence from IPFS and returns it
 * alongside the cache entry for cross-referencing.
 *
 * An auditor can use this to:
 *   1. Verify the COSE signature against the voter's credential
 *   2. Verify blake2b_256(evidence JSON) == on-chain voteHash
 *   3. Verify the signed payload contains the correct nonce and votes
 */
router.get('/audit/vote/:voterId', async (req, res) => {
    const voterId = req.params.voterId;
    const cacheEntry = voteCache.get(voterId);

    if (!cacheEntry) {
        return error(res, 'INVALID_INPUT', `Voter not found: ${voterId}`, 404);
    }

    // Fetch full evidence from IPFS
    let evidence: VoteEvidence | null = null;
    try {
        evidence = await ipfs.fetchJson<VoteEvidence>(cacheEntry.ipfsCid);
    } catch (err: any) {
        console.warn(`Could not fetch evidence from IPFS for ${voterId}:`, err.message);
    }

    // Fetch vote history chain
    const history = await getVoteHistory(voterId);

    return success(res, {
        cacheEntry,
        evidence,
        history,
        verification: {
            ipfsCid: cacheEntry.ipfsCid,
            expectedVoteHash: cacheEntry.voteHash,
            historyLength: history.length,
            instructions: [
                'Fetch evidence JSON from IPFS using the ipfsCid above',
                'Compute blake2b_256(evidence JSON) and compare to expectedVoteHash',
                'Verify the COSE_Sign1_hex signature in evidence.ekklesia using the COSE_Key_hex',
                'Confirm the signing key hash matches the voterId credential',
                'Check that evidence.ekklesia.nonce matches cacheEntry.version',
                'Verify votes against the ballot definition questions and options',
                'Verify the history chain: each entry.prevTxHash should match the previous entry.txHash',
                'Verify nonces are strictly increasing across the history chain',
            ],
        },
    });
});

export default router;
