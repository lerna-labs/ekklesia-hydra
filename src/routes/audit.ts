import { Router } from 'express';
import { ipfs, voteCache, getVoteHistory, success, error, IPFS_STAGING_DIR, voterIdToTokenName } from '../helpers.js';
import { getCachedBallot } from './lifecycle.js';
import type { VoteEvidence } from '../types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

/**
 * GET /audit/full
 *
 * Complete audit package in a single response. Reads all evidence files
 * and vote history chains from disk (no IPFS fetches). Suitable for
 * post-settlement bulk audit without keeping the middleware alive for
 * per-voter queries.
 *
 * Returns:
 *   - Ballot definition
 *   - Per-voter: cache entry + full evidence JSON + vote history chain
 *   - Total voter count
 *   - IPFS evidence directory CID (if available from finalization)
 */
router.get('/audit/full', async (_, res) => {
    const ballot = getCachedBallot();
    const allVotes = voteCache.getAll();
    const evidenceDir = voteCache.getDocumentsDir();

    const voters: Array<{
        voterId: string;
        credentialHrp: string;
        voteHash: string;
        ipfsCid: string;
        version: number;
        txHash: string;
        evidence: VoteEvidence | null;
        history: any[];
        proof: any | null;
    }> = [];

    for (const v of allVotes) {
        let tokenName: string;
        try { tokenName = voterIdToTokenName(v.voterId); } catch { tokenName = ''; }

        // Read evidence from disk: vote-{tokenName}-v{version}.json
        let evidence: VoteEvidence | null = null;
        if (tokenName) {
            try {
                const raw = await fs.readFile(path.join(evidenceDir, `vote-${tokenName}-v${v.version}.json`), 'utf-8');
                evidence = JSON.parse(raw);
            } catch { /* evidence file may not exist */ }
        }

        // Read vote history chain from disk
        const history = await getVoteHistory(v.voterId);

        // Read merkle proof: proofs/{tokenName}.json
        let proof: any = null;
        if (tokenName) {
            try {
                const raw = await fs.readFile(path.join(evidenceDir, 'proofs', `${tokenName}.json`), 'utf-8');
                proof = JSON.parse(raw);
            } catch { /* proof may not exist yet (pre-finalization) */ }
        }

        voters.push({
            voterId: v.voterId,
            credentialHrp: v.credentialHrp,
            voteHash: v.voteHash,
            ipfsCid: v.ipfsCid,
            version: v.version,
            txHash: v.txHash,
            evidence,
            history,
            proof,
        });
    }

    return success(res, {
        ballot: ballot ?? null,
        totalVoters: allVotes.length,
        voters,
    });
});

export default router;
