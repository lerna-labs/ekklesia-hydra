import { Router } from 'express';
import { Wrangler } from '@lerna-labs/hydra-sdk';
import type { MeshWallet } from '@meshsdk/core';
import { CLOSE_TOKEN, ipfs, voteCache, IPFS_STAGING_DIR, success, error, hydraMonitor, txQueue, enqueueAndWait, driveHeadToFinal, initialize, HEAD_OPEN_TIMEOUT_MS, DEPOSIT_FINALIZE_TIMEOUT_MS, DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS, DEPOSIT_FINALIZE_BUFFER_MS, DEPOSIT_CONFIRM_TIMEOUT_MS, DEPOSIT_CONFIRM_POLL_INTERVAL_MS, DEPOSIT_SUBMIT_RETRIES, DEPOSIT_SUBMIT_RETRY_DELAY_MS } from '../helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BallotDefinition } from '../types.js';
import { validateBallotDefinition } from '../ballot-validation.js';
import { buildPrimeSnapshotTx, hydraValueToAmounts, type Amount } from '../tx-builder.js';

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
let cachedBallotIpfsCid: string | null = null;

/**
 * Lifecycle of the Hydra v2 (ADR-33) ballot-token deposit.
 *
 *   PENDING — head is Open; the (601) deposit has been (or is being) submitted
 *             to L1 and is maturing for `deposit-period` before the node pulls
 *             it into the head. Voting is NOT yet allowed.
 *   READY   — the (601) is present and spendable in the head's CONFIRMED L2
 *             ledger (`GET /snapshot/utxo`, no longer pending in `GET /commits`).
 *             CommitFinalized firing is necessary but NOT sufficient — the
 *             increment can lag into the confirmed ledger, and the TRP resolves
 *             vote inputs against that confirmed ledger. Voting is allowed.
 *   FAILED  — the deposit could not be finalized or never became spendable
 *             (e.g. stranded by a deep L1 reorg, or CommitFinalized fired but
 *             the confirmed ledger never incorporated the increment). Voting
 *             stays blocked; operator must investigate.
 */
export type DepositStatus = 'PENDING' | 'READY' | 'FAILED';

let cachedDepositStatus: DepositStatus | null = null;
/** UTxO refs handed to /start that must be deposited into the head. */
let cachedDepositInputs: Array<{ txHash: string; outputIndex: number }> = [];
/** L1 tx ids of deposits that finalized into the head (the increment tx ids). */
let cachedDepositTxIds: string[] = [];
let cachedDepositSubmittedAt: string | null = null;
/** When the deposit was first observed on L1 (CommitRecorded/DepositActivated). */
let cachedDepositObservedAt: string | null = null;
/** When the (601) became spendable in the confirmed ledger (≙ READY moment). */
let cachedDepositReadyAt: string | null = null;
let cachedDepositError: string | null = null;
/** Node's `deposit-period` (seconds) captured at /start, for ETA reporting. */
let cachedDepositPeriodSec: number | null = null;
/**
 * Whether to prime a confirmed snapshot (self-spend the (601)) after the deposit
 * lands, before marking READY. Defaults true. Set false via
 * `POST /start { "prime": false }` to test whether the TRP can resolve in-head
 * txs against an unprimed deposit (e.g. after a TRP update). Persisted so a
 * restart honours the same choice.
 */
let cachedDepositPrime = true;

/**
 * Path of the on-disk ballot session record. Written on /start (atomic
 * tmp + rename), read at boot by rehydrateBallotSession(), and wiped only
 * by the fresh-start cleanup branch of /start. The file is the single
 * source of truth that lets the middleware survive process restarts
 * against a live Hydra head without operators having to re-call /start.
 */
const BALLOT_SESSION_PATH = path.join(IPFS_STAGING_DIR, 'ballot-session.json');

interface BallotSessionFile {
    ballotIpfsCid: string | null;
    ballotPolicy: string;
    ballotToken: string;
    ballotId: string;
    resultsAddress: string | null;
    // Deposit lifecycle (Hydra v2). Optional for backward-compatibility with
    // session files written before the async-deposit change — a missing
    // depositStatus on an Open head is reconciled against the snapshot at boot.
    depositStatus?: DepositStatus;
    depositInputs?: Array<{ txHash: string; outputIndex: number }>;
    depositTxIds?: string[];
    depositSubmittedAt?: string | null;
    depositObservedAt?: string | null;
    depositReadyAt?: string | null;
    depositError?: string | null;
    depositPeriodSec?: number | null;
    depositPrime?: boolean;
}

async function writeBallotSession(session: BallotSessionFile): Promise<void> {
    await fs.mkdir(path.dirname(BALLOT_SESSION_PATH), { recursive: true });
    const tmpPath = `${BALLOT_SESSION_PATH}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(session, null, 2));
    await fs.rename(tmpPath, BALLOT_SESSION_PATH);
}

async function readBallotSession(): Promise<BallotSessionFile | null> {
    try {
        const raw = await fs.readFile(BALLOT_SESSION_PATH, 'utf-8');
        return JSON.parse(raw) as BallotSessionFile;
    } catch (err: any) {
        if (err?.code === 'ENOENT') return null;
        throw err;
    }
}

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

/**
 * Current ballot-token deposit status, or null if no head session is active.
 * READY means the (601) token is live in the head and voting is allowed.
 */
export function getDepositStatus(): DepositStatus | null {
    return cachedDepositStatus;
}

/** Full deposit lifecycle detail for status/health responses. */
export function getDepositInfo(): {
    status: DepositStatus | null;
    inputs: Array<{ txHash: string; outputIndex: number }>;
    txIds: string[];
    submittedAt: string | null;
    /** When the deposit was first observed on L1 — reveals L1 observation latency. */
    observedAt: string | null;
    readyAt: string | null;
    error: string | null;
    depositPeriodSec: number | null;
    /** Whether a confirmed snapshot is primed after the deposit lands. */
    prime: boolean;
    /** ISO estimate of when the deposit should finalize (submittedAt + deposit-period). */
    estimatedReadyAt: string | null;
} {
    let estimatedReadyAt: string | null = null;
    if (cachedDepositStatus === 'PENDING' && cachedDepositSubmittedAt && cachedDepositPeriodSec != null) {
        estimatedReadyAt = new Date(
            new Date(cachedDepositSubmittedAt).getTime() + cachedDepositPeriodSec * 1000,
        ).toISOString();
    }
    return {
        status: cachedDepositStatus,
        inputs: cachedDepositInputs,
        txIds: cachedDepositTxIds,
        submittedAt: cachedDepositSubmittedAt,
        observedAt: cachedDepositObservedAt,
        readyAt: cachedDepositReadyAt,
        error: cachedDepositError,
        depositPeriodSec: cachedDepositPeriodSec,
        prime: cachedDepositPrime,
        estimatedReadyAt,
    };
}

/**
 * Persist the current in-memory session (identity + deposit lifecycle) to
 * disk. Only writes when full ballot identity is present — a partial session
 * is worse than none at boot. Best-effort: a write failure is logged, not
 * thrown, so it never fails the request that triggered it.
 */
async function persistSession(): Promise<void> {
    if (!cachedBallotPolicy || !cachedBallotToken || !cachedBallotId) return;
    try {
        await writeBallotSession({
            ballotIpfsCid: cachedBallotIpfsCid,
            ballotPolicy: cachedBallotPolicy,
            ballotToken: cachedBallotToken,
            ballotId: cachedBallotId,
            resultsAddress: cachedResultsAddress,
            depositStatus: cachedDepositStatus ?? undefined,
            depositInputs: cachedDepositInputs,
            depositTxIds: cachedDepositTxIds,
            depositSubmittedAt: cachedDepositSubmittedAt,
            depositObservedAt: cachedDepositObservedAt,
            depositReadyAt: cachedDepositReadyAt,
            depositError: cachedDepositError,
            depositPeriodSec: cachedDepositPeriodSec,
            depositPrime: cachedDepositPrime,
        });
    } catch (writeErr: any) {
        console.warn(`Warning: Failed to persist ballot session to disk: ${writeErr?.message ?? writeErr}`);
    }
}

/**
 * Rehydrate the in-memory ballot session from disk. Called once at boot
 * by index.ts before app.listen(), so callers hitting /vote, /register,
 * /finalize, etc. immediately after a restart see the same cached identity
 * the previous process had.
 *
 * Returns true when a session file was found and the identity cache was
 * populated; false when the file is absent (first boot or post-archive).
 * IPFS unavailability on boot is non-fatal — the identity is still seeded;
 * only `cachedBallot` (the definition body) is left null and can be
 * re-fetched lazily.
 */
export async function rehydrateBallotSession(): Promise<{
    rehydrated: boolean;
    ballotFetched: boolean;
}> {
    const session = await readBallotSession();
    if (!session) return { rehydrated: false, ballotFetched: false };

    cachedBallotPolicy = session.ballotPolicy;
    cachedBallotToken = session.ballotToken;
    cachedBallotId = session.ballotId;
    cachedResultsAddress = session.resultsAddress;
    cachedBallotIpfsCid = session.ballotIpfsCid;

    // Restore deposit lifecycle. A session written before the async-deposit
    // change has no depositStatus; on a live Open head that is reconciled
    // against the snapshot by reconcileDepositReadiness() at boot.
    cachedDepositStatus = session.depositStatus ?? null;
    cachedDepositInputs = session.depositInputs ?? [];
    cachedDepositTxIds = session.depositTxIds ?? [];
    cachedDepositSubmittedAt = session.depositSubmittedAt ?? null;
    cachedDepositObservedAt = session.depositObservedAt ?? null;
    cachedDepositReadyAt = session.depositReadyAt ?? null;
    cachedDepositError = session.depositError ?? null;
    cachedDepositPeriodSec = session.depositPeriodSec ?? null;
    cachedDepositPrime = session.depositPrime ?? true;

    let ballotFetched = false;
    if (session.ballotIpfsCid) {
        try {
            const fetched = await ipfs.fetchJson<BallotDefinition>(session.ballotIpfsCid);
            const validationError = validateBallotDefinition(fetched);
            if (validationError) {
                // A malformed ballot must never be cached — it would feed voting
                // and the tally with an invalid definition. Leave cachedBallot
                // null (degraded mode); identity is still restored.
                console.error(
                    `[rehydrate] Ballot definition at ${session.ballotIpfsCid} is invalid: ${validationError}. ` +
                    `NOT cached — re-/start with a valid ballot.`,
                );
            } else {
                cachedBallot = fetched;
                ballotFetched = true;
            }
        } catch (err: any) {
            console.warn(
                `[rehydrate] Could not fetch ballot definition from IPFS (${session.ballotIpfsCid}): ${err?.message ?? err}. ` +
                `Identity is restored; ballot body will be re-fetched on next /start or remains null.`,
            );
        }
    }

    return { rehydrated: true, ballotFetched };
}

/** Test-only: reset all in-memory ballot session state. Not exported via public surface. */
export function __resetBallotSessionForTests(): void {
    cachedBallot = null;
    cachedBallotPolicy = null;
    cachedBallotToken = null;
    cachedBallotId = null;
    cachedResultsAddress = null;
    cachedBallotIpfsCid = null;
    cachedDepositStatus = null;
    cachedDepositInputs = [];
    cachedDepositTxIds = [];
    cachedDepositSubmittedAt = null;
    cachedDepositObservedAt = null;
    cachedDepositReadyAt = null;
    cachedDepositError = null;
    cachedDepositPeriodSec = null;
    cachedDepositPrime = true;
}

/** Test-only: path of the ballot session file. */
export const __BALLOT_SESSION_PATH_FOR_TESTS = BALLOT_SESSION_PATH;

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
        const deposit = getDepositInfo();
        return success(res, {
            headStatus: info?.headStatus ?? 'Unknown',
            headId: info?.headId ?? null,
            nodeVersion: info?.nodeVersion ?? null,
            connected: hydraMonitor.connected,
            // Hydra v2: the (601) deposit matures asynchronously after /start.
            // `ballotActive` is the single flag callers should gate on before
            // voting; `deposit` carries the detail + ETA for progress display.
            depositStatus: deposit.status,
            ballotActive: deposit.status === 'READY',
            deposit: {
                status: deposit.status,
                submittedAt: deposit.submittedAt,
                // L1 deposit-observation timing — lets operators size
                // `deposit-period` to the measured latency rather than guessing.
                observedAt: deposit.observedAt,
                readyAt: deposit.readyAt,
                estimatedReadyAt: deposit.estimatedReadyAt,
                depositPeriodSec: deposit.depositPeriodSec,
                // Whether the snapshot-priming self-spend runs before READY.
                prime: deposit.prime,
                // L1 tx ids of the finalized deposit/increment(s).
                txIds: deposit.txIds,
                error: deposit.error,
            },
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
 * POST /prime
 *
 * Manually prime a confirmed snapshot for a head whose (601) deposit landed but
 * never got primed — e.g. the middleware restarted mid-deposit, the automated
 * start-process prime was missed, or a head is sitting Open-but-unprimed and the
 * first /vote keeps failing with `input not resolved: gas`.
 *
 * Spends the (601) back to its own address in a single zero-fee tx to force a
 * SnapshotConfirmed, after which the TRP can resolve in-head register/vote txs.
 * Built directly with MeshTxBuilder (the TRP is exactly what can't resolve yet),
 * admin-signed, dispatched through the queue worker, and awaited to APPLIED.
 *
 * Identity is read from the /start cache (one head, one ballot) — no body.
 * Idempotent: each call spends the current (601) UTxO and produces a fresh
 * confirmed snapshot. Marks the deposit READY on success.
 */
router.post('/prime', async (_req, res) => {
    try {
        if (hydraMonitor.headStatus !== 'OPEN') {
            return error(res, 'CONFLICT', `Head is not OPEN (status: ${hydraMonitor.headStatus}) — nothing to prime.`, 409);
        }
        if (!cachedBallotPolicy || !cachedBallotToken) {
            return error(res, 'CONFLICT', 'No ballot identity cached — call POST /start first (or restart to rehydrate the session) before priming.', 409);
        }
        const { admin_wallet } = await initialize();
        if (!admin_wallet) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet to sign the prime tx', 503);
        }
        const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);
        // The /prime endpoint always primes, regardless of the /start prime flag.
        const primeTxHash = await primeAndMarkReady(wrangler, admin_wallet, DEPOSIT_CONFIRM_TIMEOUT_MS, true);
        const deposit = getDepositInfo();
        return success(res, {
            status: 'PRIMED',
            primeTxHash,
            depositStatus: deposit.status,
            ballotActive: deposit.status === 'READY',
        });
    } catch (err: any) {
        console.error('Prime failed:', err);
        return error(res, 'INTERNAL_ERROR', err?.message || 'Failed to prime snapshot', 500);
    }
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
    // Whether to prime a confirmed snapshot after the deposit lands (default
    // true). `{ prime: false }` marks READY on ledger presence alone — a testing
    // lever to check whether the TRP can resolve without the priming self-spend.
    const shouldPrime = req.body.prime !== false;

    if (!utxos || !Array.isArray(utxos) || utxos.length === 0) {
        return error(res, 'MISSING_FIELDS', 'Missing or empty utxos array. Provide [{txHash, outputIndex}, ...]', 400);
    }

    for (const u of utxos) {
        if (!u.txHash || u.outputIndex === undefined || u.outputIndex < 0) {
            return error(res, 'INVALID_INPUT', `Bad UTxO ref: ${JSON.stringify(u)}`, 400);
        }
    }

    try {
        // /start opens a NEW voting period only. A head that is already OPEN is
        // never re-seeded: silently re-seeding a running head let a second /start
        // overwrite the cached ballot identity (the ballotid-clobbered-on-reseed
        // bug, which corrupted the settled (601) ballotId in production — and
        // poisoned the persisted session too). Read current state via
        // GET /head-info / GET /ballot; the in-memory cache is restored from disk
        // on restart, so a re-seed path is no longer needed for recovery.
        if (hydraMonitor.headStatus === 'OPEN') {
            return error(
                res,
                'CONFLICT',
                'Head is already OPEN — /start opens a new voting period and will not re-seed a running head. Use GET /head-info and GET /ballot to read current state.',
                409,
            );
        }

        // Fetch + validate the ballot up front. If a ballot CID was provided it
        // MUST fetch and pass validation BEFORE we wipe any prior session state
        // or open a head — Ekklesia never opens a head for a missing or malformed
        // ballot (the same gate /prepare applies before minting). On failure we
        // return without opening; the staging directory and any prior session are
        // left untouched.
        let fetchedBallot: BallotDefinition | null = null;
        if (ballotIpfsCid) {
            try {
                fetchedBallot = await ipfs.fetchJson<BallotDefinition>(ballotIpfsCid);
            } catch (fetchErr: any) {
                return error(res, 'IPFS_UNAVAILABLE', `Could not fetch ballot definition from IPFS (${ballotIpfsCid}): ${fetchErr?.message ?? fetchErr}. Refusing to /start.`, 503);
            }
            const validationError = validateBallotDefinition(fetchedBallot);
            if (validationError) {
                return error(res, 'INVALID_INPUT', `Ballot definition at ${ballotIpfsCid} is invalid: ${validationError}. Refusing to /start.`, 400);
            }
        }

        // Fresh-open path — an already-OPEN head was rejected above. The block
        // scope keeps the prior session-wipe + open-wait grouped together.
        {
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
            cachedBallotIpfsCid = null;
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
            // Remove stale ballot session file — a fresh head gets a fresh
            // identity, and leaving the previous one would let the boot
            // rehydrator load wrong values on the next restart.
            try { await fs.rm(BALLOT_SESSION_PATH, { force: true }); } catch { /* ignore */ }
            await voteCache.rehydrate(); // rebuilds in-memory map from now-empty latest/
            await txQueue.clear(); // clear stale queue entries from previous session
            console.log('Vote cache, history, and ballot cache cleared for new head session.');

            // Hydra v2 (ADR-33): `Init` opens the head with an EMPTY UTxO set —
            // there is no opening commit / CollectCom. We open here, then add
            // the (601) ballot instance token (+gas ADA) as a signed deposit
            // *asynchronously* below — the deposit matures for `deposit-period`
            // (up to ~1h on mainnet), far too long to hold an HTTP request open.
            await wrangler.waitForHeadOpen(HEAD_OPEN_TIMEOUT_MS);
        }

        // Cache the ballot definition that was fetched and validated up front
        // (before the head opened). Guaranteed present + valid when a CID was given.
        if (fetchedBallot) {
            cachedBallotIpfsCid = ballotIpfsCid!;
            cachedBallot = fetchedBallot;
            console.log(`Ballot definition cached from IPFS: ${ballotIpfsCid}`);
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

        // The deposit must be signed by the owner of the committed UTxO.
        // /prepare minted the (601) token to the admin's enterprise address,
        // so the admin wallet signs the drafted deposit tx. Init it (and fail
        // fast) BEFORE returning 202 — a wallet failure here is the operator's
        // to fix, not something to bury in the background task.
        const { admin_wallet } = await initialize();
        if (!admin_wallet) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet to sign the ballot-token deposit', 503);
        }

        // Mark the deposit PENDING and record the inputs + the node's live
        // deposit-period (for ETA reporting) BEFORE kicking off the async
        // deposit, then persist so a restart can reconcile.
        cachedDepositInputs = utxos.map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex }));
        cachedDepositTxIds = [];
        cachedDepositReadyAt = null;
        cachedDepositError = null;
        cachedDepositPeriodSec = hydraMonitor.headInfo?.depositPeriod ?? null;
        cachedDepositObservedAt = null;
        cachedDepositPrime = shouldPrime;
        cachedDepositSubmittedAt = new Date().toISOString();
        cachedDepositStatus = 'PENDING';
        if (!shouldPrime) {
            console.warn('[deposit] /start called with prime=false — the (601) deposit will be marked READY on ledger presence alone, WITHOUT priming a confirmed snapshot. The TRP may fail to resolve in-head txs until POST /prime is called.');
        }
        await persistSession();

        // Kick off the deposit in the background and return immediately. The
        // background task drafts → signs → submits each deposit to L1, waits for
        // CommitFinalized (which only fires after `deposit-period` matures), then
        // confirms the (601) is actually spendable in the confirmed ledger before
        // flipping depositStatus to READY (or FAILED). Callers poll GET /health
        // (`ballotActive`) until READY before voting. Fire-and-forget: the task
        // owns all its errors and never rejects to here.
        const finalizeTimeoutMs = computeFinalizeTimeoutMs(cachedDepositPeriodSec);
        void runDeposits(cachedDepositInputs, admin_wallet, finalizeTimeoutMs);

        const deposit = getDepositInfo();
        return success(res, {
            status: 'OPENING',
            ballotCached: cachedBallot !== null,
            ballotId: cachedBallotId,
            // Hydra v2: the head is Open but the (601) token is still maturing
            // into it. Poll GET /health until `ballotActive` (depositStatus
            // READY) before voting.
            depositStatus: deposit.status,
            ballotActive: false,
            estimatedReadyAt: deposit.estimatedReadyAt,
            depositPeriodSec: deposit.depositPeriodSec,
            prime: deposit.prime,
            // Retained for response-shape compatibility.
            alreadyOpen: false,
        }, 202);
    } catch (err: any) {
        console.error('Failed to start head:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to start head', 500);
    }
});

/** Sleep helper for the confirmed-ledger spendability poll. */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The (601) ballot UTxO located in a head snapshot — enough to self-spend it. */
interface LocatedBallotUtxo {
    ref: { txHash: string; outputIndex: number };
    /** Full value (token + gas ADA) as MeshTxBuilder amounts. */
    value: Amount[];
    /** Raw inline-datum CBOR to preserve verbatim, or null if the UTxO has none. */
    inlineDatumCborHex: string | null;
    /** Address the UTxO sits at (admin enterprise address) — spend back to it. */
    address: string;
}

/**
 * Locate the (601) ballot instance token in a head UTxO set (`GET /snapshot/utxo`),
 * returning everything needed to self-spend it, or null if it is not (yet)
 * present. Returns null until both ballot policy + token are cached.
 */
function locateBallotTokenUtxo(snapshot: Record<string, any>): LocatedBallotUtxo | null {
    if (!cachedBallotPolicy || !cachedBallotToken) return null;
    for (const [outRef, u] of Object.entries(snapshot)) {
        const entry = u as any;
        const assets = entry?.value?.[cachedBallotPolicy as string];
        if (assets && typeof assets === 'object' && cachedBallotToken in assets) {
            const hashIdx = outRef.lastIndexOf('#');
            return {
                ref: { txHash: outRef.slice(0, hashIdx), outputIndex: parseInt(outRef.slice(hashIdx + 1), 10) },
                value: hydraValueToAmounts(entry.value),
                inlineDatumCborHex: entry.inlineDatumRaw ?? null,
                address: entry.address,
            };
        }
    }
    return null;
}

/**
 * Attach a one-shot listener that records the L1 deposit-observation timestamp
 * (`cachedDepositObservedAt`) from the first CommitRecorded / DepositActivated
 * event. Surfacing observedAt is what lets operators size `deposit-period` to
 * the measured L1 latency. Returns a detach function for use in a `finally`.
 */
function armDepositObservedListener(): () => void {
    const onMessage = (msg: any): void => {
        if (cachedDepositObservedAt) return;
        if (msg?.tag === 'CommitRecorded' || msg?.tag === 'DepositActivated') {
            cachedDepositObservedAt = new Date().toISOString();
            void persistSession();
            console.log(`[deposit] (601) deposit observed on L1 (${msg.tag}) at ${cachedDepositObservedAt}.`);
        }
    };
    hydraMonitor.on('message', onMessage);
    return () => hydraMonitor.off('message', onMessage);
}

/**
 * Poll `GET /snapshot/utxo` until the (601) deposit has landed in the head
 * ledger, then return the located UTxO. Throws on timeout. This only proves the
 * increment is in the ledger — making it *resolvable by the TRP* additionally
 * requires a confirmed snapshot, which {@link primeSnapshot} forces next.
 */
async function waitForBallotTokenInLedger(wrangler: Wrangler, timeoutMs: number): Promise<LocatedBallotUtxo> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'token not yet in head ledger';
    while (Date.now() < deadline) {
        try {
            const snapshot = await wrangler.http.getSnapshotUtxo();
            const located = locateBallotTokenUtxo(snapshot);
            if (located) return located;
        } catch (err: any) {
            lastState = err?.message ?? String(err);
        }
        await delay(DEPOSIT_CONFIRM_POLL_INTERVAL_MS);
    }
    throw new Error(`(601) token did not appear in the head ledger within ${timeoutMs}ms (last state: ${lastState})`);
}

/**
 * Force a confirmed L2 snapshot carrying the (601) by self-spending it back to
 * its own address in a single zero-fee tx. The opening deposit/increment lands
 * in the head ledger but does NOT by itself advance a confirmed signed snapshot,
 * and the TRP resolves in-head tx inputs against that confirmed snapshot — so
 * until one exists the very first /vote fails with `input not resolved: gas`.
 * Built directly with MeshTxBuilder (NOT via the TRP — the TRP is exactly what
 * can't resolve yet), admin-signed, dispatched through the queue worker, and
 * awaited to APPLIED (SnapshotConfirmed). Returns the prime tx hash.
 */
async function primeSnapshot(located: LocatedBallotUtxo, admin_wallet: MeshWallet): Promise<string> {
    const unsignedCborHex = buildPrimeSnapshotTx({
        address: located.address,
        inputRef: located.ref,
        inputValue: located.value,
        inlineDatumCborHex: located.inlineDatumCborHex,
    });
    const signedCborHex = await admin_wallet.signTx(unsignedCborHex);
    // Id keyed on the spent UTxO ref so a re-prime after a restart (which spends
    // a *different* (601) UTxO) gets a distinct WAL entry rather than colliding.
    const id = `prime:${located.ref.txHash}#${located.ref.outputIndex}`;
    await enqueueAndWait({ id, type: 'prime', unsignedCborHex, signedCborHex });
    const { txHash } = await txQueue.waitForApplied(id);
    console.log(`[deposit] Snapshot primed via (601) self-spend (tx ${txHash.slice(0, 12)}…) — TRP can now resolve in-head txs.`);
    return txHash;
}

/**
 * Final leg of bringing a ballot online: wait for the (601) to land in the head
 * ledger, optionally prime a confirmed snapshot, then flip the deposit READY.
 * Shared by the /start background driver and both boot-reconcile paths so they
 * agree on what "votable" means. Throws on failure (callers record FAILED).
 *
 * `prime` defaults to the /start choice. When false the snapshot is NOT primed —
 * READY is set on ledger presence alone — so the TRP may not resolve until a
 * snapshot is forced (e.g. via POST /prime). Returns the prime tx hash, or null
 * when priming was skipped.
 */
async function primeAndMarkReady(wrangler: Wrangler, admin_wallet: MeshWallet, timeoutMs: number, prime: boolean): Promise<string | null> {
    const located = await waitForBallotTokenInLedger(wrangler, timeoutMs);
    let primeTxHash: string | null = null;
    if (prime) {
        primeTxHash = await primeSnapshot(located, admin_wallet);
    } else {
        console.warn('[deposit] Priming skipped (prime=false) — marking READY on ledger presence only. The TRP may fail to resolve in-head txs until POST /prime is called.');
    }
    cachedDepositStatus = 'READY';
    cachedDepositReadyAt = new Date().toISOString();
    cachedDepositError = null;
    await persistSession();
    console.log(`[deposit] (601) live in head${prime ? ' + snapshot primed' : ' (unprimed)'} — ballot token votable. Voting is now open.`);
    return primeTxHash;
}

/**
 * Background deposit driver. Deposits each input UTxO (the (601) ballot token
 * + gas) into the open head, waits for CommitFinalized, then lands the token in
 * the ledger and primes a confirmed snapshot (so the TRP can resolve in-head
 * txs) before flipping the in-memory + persisted deposit status to READY. On
 * failure it records FAILED with the error. Never throws — it is invoked
 * fire-and-forget from /start (and re-armed at boot by reconcileDepositReadiness()).
 *
 * maxAttempts:1 — the (601) token lives in one specific UTxO that cannot be
 * substituted for a "fresh" one (that retry mode is for fungible ADA top-ups).
 * Transient stale-input submit errors are still re-drafted up to
 * DEPOSIT_SUBMIT_RETRIES times inside depositResilient.
 */
async function runDeposits(
    inputs: Array<{ txHash: string; outputIndex: number }>,
    admin_wallet: MeshWallet,
    finalizeTimeoutMs: number,
): Promise<void> {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);
    const detachObserved = armDepositObservedListener();
    const txIds: string[] = [];
    try {
        for (const ref of inputs) {
            const l1TxId = await wrangler.depositResilient(
                async () => ({ txHash: ref.txHash, outputIndex: ref.outputIndex }),
                (cborHex) => admin_wallet.signTx(cborHex, true),
                {
                    maxAttempts: 1,
                    finalizeTimeoutMs,
                    submitRetries: DEPOSIT_SUBMIT_RETRIES,
                    submitRetryDelayMs: DEPOSIT_SUBMIT_RETRY_DELAY_MS,
                },
            );
            txIds.push(l1TxId);
            cachedDepositTxIds = [...txIds];
            await persistSession();
            console.log(`[deposit] CommitFinalized for ${ref.txHash.slice(0, 12)}…#${ref.outputIndex} (L1 tx ${l1TxId.slice(0, 12)}…).`);
        }
        // CommitFinalized fired for every deposit — but that does NOT make the
        // (601) resolvable by the TRP yet (no confirmed snapshot carries it).
        // Land it in the ledger, prime a confirmed snapshot, then mark READY.
        console.log(`[deposit] All ${inputs.length} deposit(s) reached CommitFinalized — landing (601)${cachedDepositPrime ? ' + priming a confirmed snapshot' : ' (prime=false, skipping snapshot prime)'}…`);
        await primeAndMarkReady(wrangler, admin_wallet, DEPOSIT_CONFIRM_TIMEOUT_MS, cachedDepositPrime);
    } catch (err: any) {
        cachedDepositStatus = 'FAILED';
        cachedDepositError = err?.message ?? String(err);
        await persistSession();
        console.error(`[deposit] Deposit did not finalize — ballot is NOT active: ${cachedDepositError}`);
    } finally {
        detachObserved();
    }
}

/**
 * Per-attempt deposit-finalize timeout, resolved in priority order:
 *
 *   1. DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS (operator escape hatch) when > 0,
 *   2. the node's live `deposit-period` (Greetings / head-info) + buffer,
 *   3. the static DEPOSIT_FINALIZE_TIMEOUT_MS fallback, used only when the node
 *      has not reported a period yet.
 *
 * The captured period from /start is preferred but we re-read the live monitor
 * value if it was null at capture, so a Greetings that arrived late still sizes
 * the wait correctly instead of silently dropping to the fallback. Logs which
 * path was taken and the resolved value.
 */
function computeFinalizeTimeoutMs(capturedPeriodSec: number | null): number {
    if (DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS > 0) {
        console.log(`[deposit] Finalize wait ${DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS}ms (DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS operator override).`);
        return DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS;
    }
    const depositPeriodSec = capturedPeriodSec ?? hydraMonitor.headInfo?.depositPeriod ?? null;
    if (depositPeriodSec != null && depositPeriodSec > 0) {
        const finalizeMs = depositPeriodSec * 1000 + DEPOSIT_FINALIZE_BUFFER_MS;
        console.log(`[deposit] Finalize wait ${finalizeMs}ms (deposit-period ${depositPeriodSec}s + buffer ${DEPOSIT_FINALIZE_BUFFER_MS}ms).`);
        return finalizeMs;
    }
    console.warn(`[deposit] Finalize wait ${DEPOSIT_FINALIZE_TIMEOUT_MS}ms — node has not reported a deposit-period; using DEPOSIT_FINALIZE_TIMEOUT_MS fallback. Set DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS if this is mis-sized for your L1 latency.`);
    return DEPOSIT_FINALIZE_TIMEOUT_MS;
}

/**
 * Reconcile deposit readiness at boot (called from index.ts after the monitor
 * connects). Only acts when a session was rehydrated with depositStatus
 * PENDING (or a pre-async session with no status on an Open head). If the (601)
 * is already in the head ledger it primes a confirmed snapshot (a prior process
 * may have crashed between CommitFinalized and priming, leaving the token in the
 * ledger but no confirmed snapshot for the TRP) and marks READY; otherwise it
 * re-arms a passive wait for CommitFinalized (no re-submit; the deposit is
 * already on L1) followed by the same prime step. Best-effort; never throws.
 */
export async function reconcileDepositReadiness(): Promise<void> {
    try {
        if (hydraMonitor.headStatus !== 'OPEN') return;
        if (!cachedBallotPolicy || !cachedBallotToken) return;
        // Nothing to do once READY/FAILED was already persisted (READY implies a
        // snapshot was primed in the prior process — no need to prime again).
        if (cachedDepositStatus === 'READY' || cachedDepositStatus === 'FAILED') return;

        const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);
        const snapshot = await wrangler.http.getSnapshotUtxo();
        const located = locateBallotTokenUtxo(snapshot);

        // Both paths need the admin wallet to prime the confirmed snapshot.
        const { admin_wallet } = await initialize();
        if (!admin_wallet) {
            console.warn('[deposit] Boot reconcile: admin wallet unavailable to prime snapshot — leaving status PENDING for operator review.');
            return;
        }

        if (located) {
            try {
                await primeAndMarkReady(wrangler, admin_wallet, DEPOSIT_CONFIRM_TIMEOUT_MS, cachedDepositPrime);
                console.log(`[deposit] Reconciled at boot: (601) already in head — ${cachedDepositPrime ? 'primed a confirmed snapshot' : 'marked READY unprimed (prime=false)'}.`);
            } catch (err: any) {
                cachedDepositStatus = 'FAILED';
                cachedDepositError = err?.message ?? String(err);
                await persistSession();
                console.error(`[deposit] Boot reconcile prime failed — ballot is NOT active: ${cachedDepositError}`);
            }
            return;
        }

        // Token not yet in head and we have inputs to wait on: re-arm a passive
        // wait for CommitFinalized (the deposit was already submitted to L1 by
        // the prior process — do NOT re-submit). If we have no recorded inputs,
        // leave the status as-is for the operator to inspect.
        if (cachedDepositInputs.length === 0) {
            console.warn('[deposit] Boot reconcile: head Open, token not yet in head, and no recorded deposit inputs — leaving status PENDING for operator review.');
            return;
        }
        cachedDepositStatus = 'PENDING';
        await persistSession();
        const finalizeTimeoutMs = computeFinalizeTimeoutMs(cachedDepositPeriodSec);
        console.log('[deposit] Boot reconcile: deposit still maturing — re-arming wait for CommitFinalized.');
        void (async () => {
            const detachObserved = armDepositObservedListener();
            try {
                await hydraMonitor.waitForMessage('CommitFinalized', finalizeTimeoutMs);
                // Same readiness path as runDeposits: CommitFinalized alone is not
                // enough — land the (601) and (unless prime=false) prime a snapshot.
                await primeAndMarkReady(wrangler, admin_wallet, DEPOSIT_CONFIRM_TIMEOUT_MS, cachedDepositPrime);
            } catch (err: any) {
                cachedDepositStatus = 'FAILED';
                cachedDepositError = err?.message ?? String(err);
                await persistSession();
                console.error(`[deposit] Re-armed wait failed — ballot is NOT active: ${cachedDepositError}`);
            } finally {
                detachObserved();
            }
        })();
    } catch (err: any) {
        console.warn(`[deposit] Boot reconcile failed (continuing): ${err?.message ?? err}`);
    }
}

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
