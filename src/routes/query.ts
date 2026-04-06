import { Router } from 'express';
import { getUtxoSet } from '@lerna-labs/hydra-sdk';
import { initialize, voteCache, IPFS_STAGING_DIR, success, error } from '../helpers.js';
import { getCachedBallot } from './lifecycle.js';

const router = Router();

router.get('/', (_, res) => {
    return success(res, { message: 'Hydra SDK API is running' });
});

router.post('/ledger', async (req, res) => {
    try {
        const { admin_wallet } = await initialize();

        if (!admin_wallet) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet', 503);
        }

        const utxo_set = await getUtxoSet();
        return success(res, {
            utxos: utxo_set,
            admin_wallet: admin_wallet.addresses.enterpriseAddressBech32,
        });
    } catch (err: any) {
        console.error('Failed to fetch ledger:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to fetch ledger', 500);
    }
});

/**
 * GET /ballot
 *
 * Return the current ballot definition from the in-memory cache.
 * Available after /start is called with a ballotIpfsCid.
 */
router.get('/ballot', (_, res) => {
    const ballot = getCachedBallot();
    if (!ballot) {
        return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached. Call POST /start with ballotIpfsCid first.', 400);
    }
    return success(res, ballot);
});

/**
 * GET /votes
 *
 * List all current votes from the disk-backed cache.
 * Returns slim summaries (no full evidence — use /audit/vote/:voterId for that).
 */
router.get('/votes', (_, res) => {
    const allVotes = voteCache.getAll();
    return success(res, {
        totalVoters: allVotes.length,
        votes: allVotes.map((v) => ({
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
 * GET /voter/:voterId
 *
 * Lookup a specific voter by their bech32 ID.
 * Returns cache data if the voter has voted, or 404 if not found.
 */
router.get('/voter/:voterId', (req, res) => {
    const voterId = req.params.voterId;
    const vote = voteCache.get(voterId);

    if (!vote) {
        return error(res, 'INVALID_INPUT', `Voter not found: ${voterId}`, 404);
    }

    return success(res, vote);
});

/**
 * POST /flush-cache
 *
 * Clear the in-memory vote cache and wipe the disk staging directories.
 * Used between E2E test runs to prevent stale votes from previous sessions
 * interfering with the current test.
 */
router.post('/flush-cache', async (_, res) => {
    try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');

        const before = voteCache.getAll().length;

        // Wipe the staging subdirectories
        const votesDir = path.join(IPFS_STAGING_DIR, 'votes');
        const latestDir = path.join(IPFS_STAGING_DIR, 'latest');
        const historyDir = path.join(IPFS_STAGING_DIR, 'history');
        const proofsDir = path.join(IPFS_STAGING_DIR, 'votes', 'proofs');

        for (const dir of [votesDir, latestDir, historyDir, proofsDir]) {
            try {
                await fs.rm(dir, { recursive: true, force: true });
                await fs.mkdir(dir, { recursive: true });
            } catch {
                // Directory may not exist yet
            }
        }

        // Rehydrate the cache (which will now find nothing on disk)
        const after = await voteCache.rehydrate();

        console.log(`[flush-cache] Cleared ${before} entries, rehydrated ${after}`);
        return success(res, { cleared: before, remaining: after });
    } catch (err: any) {
        console.error('[flush-cache] FULL ERROR:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to flush cache', 500);
    }
});

export default router;
