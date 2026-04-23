import { Router } from 'express';
import { Wrangler } from '@lerna-labs/hydra-sdk';
import { CLOSE_TOKEN, ipfs, voteCache, IPFS_STAGING_DIR, success, error, hydraMonitor, txQueue, driveHeadToFinal } from '../helpers.js';
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
let cachedBallotId: string | null = null;
let cachedResultsAddress: string | null = null;

/** Get the cached ballot definition (used by other routes). */
export function getCachedBallot(): BallotDefinition | null {
    return cachedBallot;
}

/** Get the cached ballot policy ID and instance asset name (set during /start). */
export function getCachedBallotIdentity(): { ballotPolicy: string; ballotToken: string } | null {
    if (!cachedBallotPolicy || !cachedBallotToken) return null;
    return { ballotPolicy: cachedBallotPolicy, ballotToken: cachedBallotToken };
}

/**
 * Cached ballot identifier — the opaque bytes stored in the finalized (601)
 * datum's `ballotId` field. Set during /start; defaults to the 28-byte
 * fingerprint (the suffix of ballotToken) if the caller doesn't supply one.
 */
export function getCachedBallotId(): string | null {
    return cachedBallotId;
}

/**
 * Destination address for the (601) token after finalize. Set during /start
 * from the `resultsAddress` body field. Null means "send to admin address"
 * (the default behaviour before this was wired through).
 */
export function getCachedResultsAddress(): string | null {
    return cachedResultsAddress;
}

router.get('/health', async (_, res) => {
    try {
        // If monitor isn't connected, try to connect with a short timeout
        if (!hydraMonitor.connected) {
            try {
                await hydraMonitor.start();
            } catch {
                return error(res, 'HYDRA_UNREACHABLE', 'Could not connect to Hydra node', 503);
            }
        }
        const info = hydraMonitor.headInfo;
        return success(res, {
            headStatus: info?.headStatus ?? 'Unknown',
            headId: info?.headId ?? null,
            nodeVersion: info?.nodeVersion ?? null,
            connected: hydraMonitor.connected,
        });
    } catch (e: any) {
        console.error('Health check failed:', e);
        return error(res, 'HYDRA_UNREACHABLE', 'Could not get head status', 503);
    }
});

router.get('/head-info', async (_, res) => {
    const info = hydraMonitor.headInfo;
    if (!info) {
        return error(res, 'HYDRA_UNREACHABLE', 'No Greetings received yet', 503);
    }
    return success(res, info);
});

/**
 * POST /start
 *
 * Open a Hydra head by committing the (601) ballot instance token + gas UTxOs.
 *
 * All identity fields (ballotPolicy, ballotToken, ballotId, resultsAddress)
 * are cached at this point. Downstream settlement endpoints read them from
 * the cache — they are NOT accepted as request bodies on /finalize,
 * /settle/finalize, or /settle. One head, one ballot.
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
 *   ballotId?: string
 *     — hex bytes written into the finalized (601) datum's ballotId field.
 *       Defaults to the 28-byte fingerprint (the 56-hex-char suffix of ballotToken).
 *   resultsAddress?: string
 *     — destination for the (601) token after finalize (defaults to admin).
 *
 * Recovery / idempotency:
 *   If the head is already Open when this is called, the handler skips the
 *   cache wipe and the open-wait and simply seeds the identity/ballot cache
 *   from the body. This handles the case where a previous /start timed out
 *   on the middleware side but the underlying Hydra open succeeded on L1 —
 *   re-calling /start with the same body rebuilds the in-memory caches
 *   without disturbing any in-head state. Response includes `alreadyOpen: true`.
 */
router.post('/start', async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);
    const utxos = req.body.utxos as Array<{ txHash: string; outputIndex: number }> | undefined;
    const ballotIpfsCid = req.body.ballotIpfsCid as string | undefined;
    const ballotPolicy = req.body.ballotPolicy as string | undefined;
    const ballotToken = req.body.ballotToken as string | undefined;
    const ballotId = req.body.ballotId as string | undefined;
    const resultsAddress = req.body.resultsAddress as string | undefined;

    if (!utxos || !Array.isArray(utxos) || utxos.length === 0) {
        return error(res, 'MISSING_FIELDS', 'Missing or empty utxos array. Provide [{txHash, outputIndex}, ...]', 400);
    }

    for (const u of utxos) {
        if (!u.txHash || u.outputIndex === undefined || u.outputIndex < 0) {
            return error(res, 'INVALID_INPUT', `Bad UTxO ref: ${JSON.stringify(u)}`, 400);
        }
    }

    try {
        // If the head is already Open, treat this as a cache-seeding call and
        // skip both the cache wipe and the open-wait. The SDK's waitForHeadOpen
        // only resolves on a HeadIsOpen transition event — if the head is
        // already Open, the Greetings replay logs "Open → already ready,
        // proceeding" but never resolves, so the call would otherwise hang
        // for the full 10-minute timeout. This path recovers a stuck session
        // (e.g. L1 commit succeeded on the Hydra side after the original
        // /start timed out) without disturbing any in-head state.
        const alreadyOpen = hydraMonitor.headStatus === 'OPEN';

        if (!alreadyOpen) {
            // Refuse to open a new head while a finalized head's artifacts are
            // still sitting in the staging directory. Once `finalize-response.json`
            // exists the staging directory holds the complete, audit-grade
            // record of a completed ballot (evidence files, per-voter merkle
            // proofs, history chains, pre-burn ledger, pinned results.json). A
            // fresh /start that clobbers any of that would silently destroy
            // the local copy of that audit record — and because Ekklesia
            // never reuses a head for a second ballot, there is no legitimate
            // reason to reopen this directory. Operators should archive the
            // staging directory (or point IPFS_STAGING_DIR at a fresh path)
            // before starting the next head.
            const finalizeResponsePath = path.join(IPFS_STAGING_DIR, 'finalize-response.json');
            try {
                await fs.access(finalizeResponsePath);
                return error(
                    res,
                    'CONFLICT',
                    `Refusing to /start: ${finalizeResponsePath} already exists, which means this staging directory still holds a finalized ballot's audit record. Archive the staging directory (or set IPFS_STAGING_DIR to a fresh path) and retry.`,
                    409,
                );
            } catch {
                // finalize-response.json absent — a prior session either
                // never ran or aborted before finalize. Safe to wipe its
                // session-scoped artifacts and start fresh.
            }

            // Flush stale vote cache from an aborted previous head session.
            // Only reached when no finalize-response.json is present — i.e.
            // the prior session never produced a committed audit record.
            // DiskCache doesn't expose clear(), so wipe disk dirs + rehydrate
            // (loads 0 entries).
            cachedBallot = null;
            cachedBallotPolicy = null;
            cachedBallotToken = null;
            cachedBallotId = null;
            cachedResultsAddress = null;
            const votesDir = path.join(IPFS_STAGING_DIR, 'votes');
            const latestDir = path.join(IPFS_STAGING_DIR, 'latest');
            const historyDir = path.join(IPFS_STAGING_DIR, 'history');
            for (const dir of [votesDir, latestDir, historyDir]) {
                try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            // Remove stale pre-burn ledger from an aborted prior session —
            // no finalize-response.json is present so any pre-burn snapshot
            // here is orphaned intermediate state.
            try { await fs.rm(path.join(IPFS_STAGING_DIR, 'pre-burn-ledger.json'), { force: true }); } catch { /* ignore */ }
            await voteCache.rehydrate(); // rebuilds in-memory map from now-empty latest/
            await txQueue.clear(); // clear stale queue entries from previous session
            console.log('Vote cache, history, and ballot cache cleared for new head session.');

            // Simple commit — single UTxO (ballot token + gas ADA).
            // The SDK fetches UTxO details from Blockfrost and builds the commit
            // automatically for single-UTxO commits (no blueprint needed).
            await wrangler.waitForHeadOpen({ utxos }, 600000); // 10 min — init + L1 commit can be slow
        } else {
            console.log('/start called against an already-Open head — seeding identity/ballot cache without wiping existing state.');
        }

        // Cache the ballot definition from IPFS if CID was provided
        if (ballotIpfsCid) {
            try {
                cachedBallot = await ipfs.fetchJson<BallotDefinition>(ballotIpfsCid);
                console.log(`Ballot definition cached from IPFS: ${ballotIpfsCid}`);
            } catch (fetchErr: any) {
                console.warn(`Warning: Could not fetch ballot from IPFS (${ballotIpfsCid}):`, fetchErr.message);
            }
        }

        // Cache ballot identity for voting + settlement routes
        if (ballotPolicy && ballotToken) {
            cachedBallotPolicy = ballotPolicy;
            cachedBallotToken = ballotToken;
            // Default ballotId = the 28-byte fingerprint (suffix of ballotToken,
            // after the 4-byte CIP-67 label prefix → 8 hex chars).
            cachedBallotId = ballotId ?? ballotToken.slice(8);
            console.log(`Ballot identity cached: policy=${ballotPolicy.slice(0, 16)}… token=${ballotToken.slice(0, 16)}… ballotId=${cachedBallotId.slice(0, 16)}…`);
        }

        // Cache results address — where the finalized (601) is sent at settlement.
        // Null means "fall back to admin address" downstream in settlement.ts.
        if (resultsAddress) {
            cachedResultsAddress = resultsAddress;
            console.log(`Results address cached: ${resultsAddress}`);
        }

        return success(res, {
            ballotCached: cachedBallot !== null,
            ballotId: cachedBallotId,
            alreadyOpen,
        });
    } catch (err: any) {
        console.error('Failed to start head:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to start head', 500);
    }
});

/**
 * POST /close — DEPRECATED. Prefer `POST /settle/close`.
 *
 * Drives the head through Close → Contesting → Closed → FanoutPossible →
 * Fanout → Final using the shared HydraMonitor (not a fresh Wrangler with
 * its own WebSocket). Functionally identical to /settle/close. Kept here
 * so existing integrations keep working; new callers should hit
 * `/settle/close` directly to make the intent clear.
 *
 * Body: { closeToken: string }
 */
router.post('/close', async (req, res) => {
    const close_token = req.body.closeToken;

    if (!close_token || close_token !== CLOSE_TOKEN) {
        console.error('Request to close w/o correct token!', close_token);
        return error(res, 'CLOSE_TOKEN_INVALID', 'Incorrect close token', 400);
    }

    try {
        const wasAlreadyFinal = hydraMonitor.headStatus === 'FINAL';
        await driveHeadToFinal('close');
        return success(res, wasAlreadyFinal
            ? { status: 'FINAL', message: 'Head already finalized' }
            : { status: 'FINAL' });
    } catch (err: any) {
        if (err?.code === 'HEAD_NOT_CLOSEABLE') {
            return error(res, 'CONFLICT', err.message, 409);
        }
        console.error('Failed to close head?', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to close head', 500);
    }
});

// ---------------------------------------------------------------------------
// Transaction Queue endpoints
// ---------------------------------------------------------------------------

/** GET /queue/status — current queue state. */
router.get('/queue/status', (_, res) => {
    return success(res, txQueue.status());
});

/** POST /queue/drain — block until queue is empty. */
router.post('/queue/drain', async (req, res) => {
    const timeoutMs = (req.body?.timeoutMs as number) ?? 600_000;
    try {
        if (txQueue.isDrained()) {
            return success(res, { drained: true, message: 'Queue already empty' });
        }
        await txQueue.drain(timeoutMs);
        return success(res, { drained: true });
    } catch (err: any) {
        return error(res, 'INTERNAL_ERROR', err.message, 500);
    }
});

export default router;
