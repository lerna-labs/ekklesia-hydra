import { Router } from 'express';
import { Wrangler } from '@lerna-labs/hydra-sdk';
import { CLOSE_TOKEN, ipfs, success, error } from '../helpers.js';
import type { BallotDefinition } from '../types.js';

const router = Router();

/**
 * Cached ballot definition for the current head session.
 * Populated after head opens if a (601) ballot instance token is found.
 */
let cachedBallot: BallotDefinition | null = null;

/** Get the cached ballot definition (used by other routes). */
export function getCachedBallot(): BallotDefinition | null {
    return cachedBallot;
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
 */
router.post('/start', async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const utxos = req.body.utxos as Array<{ txHash: string; outputIndex: number }> | undefined;
    const ballotIpfsCid = req.body.ballotIpfsCid as string | undefined;

    if (!utxos || !Array.isArray(utxos) || utxos.length === 0) {
        return error(res, 'MISSING_FIELDS', 'Missing or empty utxos array. Provide [{txHash, outputIndex}, ...]', 400);
    }

    for (const u of utxos) {
        if (!u.txHash || u.outputIndex === undefined || u.outputIndex < 0) {
            return error(res, 'INVALID_INPUT', `Bad UTxO ref: ${JSON.stringify(u)}`, 400);
        }
    }

    try {
        await wrangler.waitForHeadOpen({ utxos }, 180000);

        // Cache the ballot definition from IPFS if CID was provided
        if (ballotIpfsCid) {
            try {
                cachedBallot = await ipfs.fetchJson<BallotDefinition>(ballotIpfsCid);
                console.log(`Ballot definition cached from IPFS: ${ballotIpfsCid}`);
            } catch (fetchErr: any) {
                console.warn(`Warning: Could not fetch ballot from IPFS (${ballotIpfsCid}):`, fetchErr.message);
            }
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
