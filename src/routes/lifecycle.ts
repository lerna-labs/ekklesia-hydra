import { Router } from 'express';
import { Wrangler } from '@lerna-labs/hydra-sdk';
import { CLOSE_TOKEN, ipfs, voteCache, IPFS_STAGING_DIR, success, error } from '../helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BallotDefinition } from '../types.js';

const router = Router();

/**
 * Cached ballot definition for the current head session.
 * Populated after head opens if a (601) ballot instance token is found.
 */
let cachedBallot: BallotDefinition | null = null;
let cachedBallotPolicy: string | null = null;
let cachedBallotToken: string | null = null;

/** Get the cached ballot definition (used by other routes). */
export function getCachedBallot(): BallotDefinition | null {
    return cachedBallot;
}

/** Get the cached ballot policy ID and instance asset name (set during /start). */
export function getCachedBallotIdentity(): { ballotPolicy: string; ballotToken: string } | null {
    if (!cachedBallotPolicy || !cachedBallotToken) return null;
    return { ballotPolicy: cachedBallotPolicy, ballotToken: cachedBallotToken };
}

router.get('/health', async (_, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    try {
        const headStatus = await wrangler.getHeadStatus(5000);
        return success(res, { headStatus });
    } catch (e: any) {
        console.error('Health check failed:', e);
        return error(res, 'HYDRA_UNREACHABLE', 'Could not connect to Hydra node', 503);
    }
});

/**
 * POST /start
 *
 * Open a Hydra head by committing the (601) ballot instance token + gas UTxOs.
 *
 * Body:
 *   utxos: Array<{ txHash: string, outputIndex: number }>
 *     — UTxO refs to commit (the (601) token output + gas output from /prepare)
 *   ballotIpfsCid?: string
 *     — IPFS CID of the ballot definition (returned by /prepare). If provided,
 *       the ballot is fetched and cached for use by voting/query endpoints.
 *   ballotPolicy: string
 *     — hex policy ID of the ballot tokens (returned by /prepare as policyId)
 *   ballotToken: string
 *     — hex instance asset name of the (601) token (returned by /prepare as instanceAssetName)
 */
router.post('/start', async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const utxos = req.body.utxos as Array<{ txHash: string; outputIndex: number }> | undefined;
    const ballotIpfsCid = req.body.ballotIpfsCid as string | undefined;
    const ballotPolicy = req.body.ballotPolicy as string | undefined;
    const ballotToken = req.body.ballotToken as string | undefined;

    if (!utxos || !Array.isArray(utxos) || utxos.length === 0) {
        return error(res, 'MISSING_FIELDS', 'Missing or empty utxos array. Provide [{txHash, outputIndex}, ...]', 400);
    }

    for (const u of utxos) {
        if (!u.txHash || u.outputIndex === undefined || u.outputIndex < 0) {
            return error(res, 'INVALID_INPUT', `Bad UTxO ref: ${JSON.stringify(u)}`, 400);
        }
    }

    try {
        // Flush stale vote cache from any previous head session.
        // DiskCache doesn't expose clear(), so wipe disk dirs + rehydrate (loads 0 entries).
        cachedBallot = null;
        cachedBallotPolicy = null;
        cachedBallotToken = null;
        const votesDir = path.join(IPFS_STAGING_DIR, 'votes');
        const latestDir = path.join(IPFS_STAGING_DIR, 'latest');
        const historyDir = path.join(IPFS_STAGING_DIR, 'history');
        for (const dir of [votesDir, latestDir, historyDir]) {
            try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        await voteCache.rehydrate(); // rebuilds in-memory map from now-empty latest/
        console.log('Vote cache, history, and ballot cache cleared for new head session.');

        // Simple commit — single UTxO (ballot token + gas ADA).
        // The SDK fetches UTxO details from Blockfrost and builds the commit
        // automatically for single-UTxO commits (no blueprint needed).
        await wrangler.waitForHeadOpen({ utxos }, 600000); // 10 min — init + L1 commit can be slow

        // Cache the ballot definition from IPFS if CID was provided
        if (ballotIpfsCid) {
            try {
                cachedBallot = await ipfs.fetchJson<BallotDefinition>(ballotIpfsCid);
                console.log(`Ballot definition cached from IPFS: ${ballotIpfsCid}`);
            } catch (fetchErr: any) {
                console.warn(`Warning: Could not fetch ballot from IPFS (${ballotIpfsCid}):`, fetchErr.message);
            }
        }

        // Cache ballot identity for voting routes
        if (ballotPolicy && ballotToken) {
            cachedBallotPolicy = ballotPolicy;
            cachedBallotToken = ballotToken;
            console.log(`Ballot identity cached: policy=${ballotPolicy.slice(0, 16)}… token=${ballotToken.slice(0, 16)}…`);
        }

        return success(res, { ballotCached: cachedBallot !== null });
    } catch (err: any) {
        console.error('Failed to start head:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to start head', 500);
    }
});

router.post('/close', async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const close_token = req.body.closeToken;

    if (!close_token || close_token !== CLOSE_TOKEN) {
        console.error('Request to close w/o correct token!', close_token);
        return error(res, 'CLOSE_TOKEN_INVALID', 'Incorrect close token', 400);
    }

    try {
        await wrangler.waitForHeadClose(180000);
        return success(res, { closed: true });
    } catch (err: any) {
        console.error('Failed to close head?', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to close head', 500);
    }
});

export default router;
