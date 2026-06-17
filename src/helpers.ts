import { getAdmin, createIpfsClient, createDiskCache, HydraMonitor } from '@lerna-labs/hydra-sdk';
import type { IpfsClient, DiskCache } from '@lerna-labs/hydra-sdk';
import { MeshWallet } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { TRPClientLogged as Client } from './trp-client.js';
import { bech32 } from 'bech32';
import { blake2b } from 'blakejs';
import { CREDENTIAL_PREFIX } from './types.js';
import type { VoteCacheEntry, VoteHistoryEntry } from './types.js';
import { TxQueue } from './tx-queue.js';
import type { TxType } from './tx-queue.js';
import { QueueWorker } from './queue-worker.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

export const TRP_URL = process.env.TRP_URL as string;
export const HYDRA_NETWORK = parseInt(process.env.HYDRA_NETWORK || '0', 10);
export const CLOSE_TOKEN = process.env.CLOSE_TOKEN || 'shutitdown';
export const IPFS_API_URL = process.env.IPFS_API_URL || 'http://localhost:5001';
export const IPFS_STAGING_DIR = process.env.IPFS_STAGING_DIR || '/ipfs-staging';
export const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

/**
 * Cap on how many TRP resolve calls run concurrently during bulk settlement
 * (the burn fan-out). Resolving one countVoteTx per voter all at once
 * overwhelms the TRP gateway (HTTP 429) and its backing Hydra UTxO lookups
 * ("input not resolved: voter_token"). The queue worker's in-flight throttle
 * only governs dispatch, not this resolve phase, so it is bounded here.
 */
export const TRP_RESOLVE_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.TRP_RESOLVE_CONCURRENCY || '12', 10),
);

/** Log only when VERBOSE mode is enabled. Errors always log regardless. */
export function debug(...args: unknown[]): void {
    if (VERBOSE) console.log(...args);
}

// ---------------------------------------------------------------------------
// Hydra Monitor (singleton)
// ---------------------------------------------------------------------------

export const hydraMonitor = new HydraMonitor({
    wsUrl: process.env.HYDRA_WS_URL as string,
    reconnect: { enabled: true, maxAttempts: Infinity },
    eventBufferSize: 200,
});

/** Get the on-chain Hydra head ID from the monitor's Greetings. */
export function getHeadId(): string | null {
    return hydraMonitor.headInfo?.headId ?? null;
}

// ---------------------------------------------------------------------------
// Tx hash helper (blake2b-256 of the tx body — invariant across signing)
// ---------------------------------------------------------------------------

/**
 * Compute the Cardano transaction hash from unsigned or signed CBOR.
 * The tx hash is blake2b-256 of the tx body, which doesn't change after signing.
 */
function computeTxHash(cborHex: string): string {
    return deserializeTx(cborHex).body().hash();
}

// ---------------------------------------------------------------------------
// IPFS Client (singleton)
// ---------------------------------------------------------------------------

export const ipfs: IpfsClient = createIpfsClient({ apiUrl: IPFS_API_URL });

// ---------------------------------------------------------------------------
// Disk-backed Vote Cache (singleton)
// ---------------------------------------------------------------------------

export const voteCache: DiskCache<VoteCacheEntry> = createDiskCache<VoteCacheEntry>(
    {
        stagingDir: IPFS_STAGING_DIR,
        documentsSubdir: 'votes',
        latestSubdir: 'latest',
    },
    (entry) => entry.voterId,
);

// ---------------------------------------------------------------------------
// Transaction Queue (singleton) + Queue Worker
// ---------------------------------------------------------------------------

export const txQueue = new TxQueue(IPFS_STAGING_DIR);

/**
 * Background dispatcher for the WAL. Submits BUILT entries to the head via
 * WebSocket, listens for TxValid/TxInvalid/SnapshotConfirmed, and enforces
 * ordering rules (per-voter sequencing + ballot-token contention).
 *
 * Started in `index.ts` after `hydraMonitor.start()` succeeds.
 */
export const queueWorker = new QueueWorker(txQueue, hydraMonitor);

// ---------------------------------------------------------------------------
// enqueueAndWait — single-call: sign + WAL enqueue + await TxValid
// ---------------------------------------------------------------------------

export interface EnqueueArgs {
    /** Stable, idempotent ID — `voterId:nonce` for votes, `burn:tokenName` for burns. */
    id: string;
    type: TxType;
    /** Unsigned CBOR (from TRP resolve) — used to compute the tx hash before signing. */
    unsignedCborHex: string;
    /** Signed CBOR (admin signature applied) — what the worker submits to the head. */
    signedCborHex: string;
    /** Optional voter ID for per-voter ordering enforcement in the worker. */
    voterId?: string;
    /** Per-entry timeout (default 120s). */
    timeoutMs?: number;
}

/**
 * Enqueue a signed transaction to the WAL and wait for the queue worker to
 * report TxValid. The tx hash is computed from the **unsigned** CBOR — it
 * is invariant across signing because it's blake2b-256 of the tx body only.
 */
export async function enqueueAndWait(args: EnqueueArgs): Promise<{ txHash: string }> {
    const txHash = computeTxHash(args.unsignedCborHex);

    await txQueue.enqueue({
        id: args.id,
        type: args.type,
        state: 'BUILT',
        txHash,
        signedCborHex: args.signedCborHex,
        voterId: args.voterId,
        attempts: 0,
    });

    return txQueue.waitForAcceptance(args.id, args.timeoutMs);
}

/** Re-export computeTxHash for callers that need the hash before enqueue. */
export { computeTxHash };

/** Recursively convert BigInt values to strings for JSON serialization. */
export function sanitizeBigInts(obj: any): any {
    if (typeof obj === 'bigint') {
        return obj.toString();
    } else if (Array.isArray(obj)) {
        return obj.map(sanitizeBigInts);
    } else if (obj && typeof obj === 'object') {
        const newObj: any = {};
        for (const key of Object.keys(obj)) {
            newObj[key] = sanitizeBigInts(obj[key]);
        }
        return newObj;
    } else {
        return obj;
    }
}

/**
 * Drop-in replacement for `Promise.allSettled(items.map(fn))` that caps the
 * number of `fn` invocations in flight at `limit`. Results preserve input
 * order so callers can index back into `items` for per-item error reporting.
 *
 * Used to throttle the TRP resolve fan-out during settlement — see
 * {@link TRP_RESOLVE_CONCURRENCY}.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
        for (let i = next++; i < items.length; i = next++) {
            try {
                results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
            } catch (reason) {
                results[i] = { status: 'rejected', reason };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Parse a bech32 voter ID into the credential prefix byte and 28-byte hash
 * used as the voter token asset name (29 bytes total).
 *
 * The bech32 HRP (e.g., "drep", "stake", "pool") determines the prefix byte.
 * The decoded data is hashed with blake2b-224 to produce a fixed 28-byte identifier.
 *
 * @returns 58-char hex string (1-byte prefix + 28-byte hash)
 */
export function voterIdToTokenName(voterId: string): string {
    if (!voterId) {
        throw new Error('Invalid voter ID');
    }

    const decoded = bech32.decode(voterId);
    const hrp = decoded.prefix;

    // A calidus key is a signing witness, not a voter identity. Minting a token
    // for `calidus1...` would give an SPO a second voter token alongside their
    // pool token (a double vote). SPOs vote as the pool with a calidusDeclaration.
    if (hrp === 'calidus') {
        throw new Error(
            'Calidus keys are signing witnesses, not voter identities — submit voterId as the pool (pool1...) with a calidusDeclaration in the signature.',
        );
    }

    const prefixByte = CREDENTIAL_PREFIX[hrp];
    if (prefixByte === undefined) {
        const allowed = Object.keys(CREDENTIAL_PREFIX).join(', ');
        throw new Error(`Unrecognized bech32 prefix: "${hrp}" — voter IDs must use one of: ${allowed}`);
    }

    const bytes = bech32.fromWords(decoded.words);

    // blake2b-224: proper 28-byte output (standard Cardano key hash derivation)
    const hashBytes = blake2b(Buffer.from(bytes), undefined, 28);
    const hashHex = Buffer.from(hashBytes).toString('hex');

    const prefixHex = prefixByte.toString(16).padStart(2, '0');
    return (prefixHex + hashHex).toLowerCase();
}

/**
 * Extract the bech32 HRP from a voter ID.
 * Used to store the credential type in cache entries.
 */
export function voterIdHrp(voterId: string): string {
    const decoded = bech32.decode(voterId);
    return decoded.prefix;
}

export type InitializePayload = {
    admin_wallet?: MeshWallet;
    address?: string;
    scriptCbor?: string;
    client?: Client;
};

// Singleton cache for admin wallet + TRP client.
// Avoids re-deriving the wallet key and re-constructing the client on every request.
let _cachedPayload: InitializePayload | null = null;

/** Set up admin wallet and TRP client. Cached after first successful call. */
export async function initialize(): Promise<InitializePayload> {
    if (_cachedPayload) return _cachedPayload;

    let admin_wallet: MeshWallet;
    try {
        admin_wallet = await getAdmin();
    } catch (error: any) {
        console.error(`Failed to initialize...`, error);
        return {};
    }

    const client = new Client({
        endpoint: TRP_URL as string,
    });

    _cachedPayload = { admin_wallet, client };
    return _cachedPayload;
}

// ---------------------------------------------------------------------------
// Vote History — append-only chain per voter
// ---------------------------------------------------------------------------

const HISTORY_DIR = path.join(IPFS_STAGING_DIR, 'history');

/** Ensure the history directory exists. */
async function ensureHistoryDir(): Promise<void> {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
}

/** Append a history entry for a voter. */
export async function appendVoteHistory(voterId: string, entry: VoteHistoryEntry): Promise<void> {
    await ensureHistoryDir();
    const filePath = path.join(HISTORY_DIR, `${voterId}.json`);
    let history: VoteHistoryEntry[] = [];
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        history = JSON.parse(raw);
    } catch {
        // File doesn't exist yet — start fresh
    }
    history.push(entry);
    await fs.writeFile(filePath, JSON.stringify(history, null, 2));
}

/** Read the full vote history chain for a voter. */
export async function getVoteHistory(voterId: string): Promise<VoteHistoryEntry[]> {
    const filePath = path.join(HISTORY_DIR, `${voterId}.json`);
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Standardized API Response Helpers
// ---------------------------------------------------------------------------

/** Error codes for machine-readable error identification. */
export type ErrorCode =
    | 'MISSING_FIELDS'
    | 'INVALID_INPUT'
    | 'INVALID_VOTE'
    | 'INVALID_VOTER_ID'
    | 'UNAUTHORIZED'
    | 'INELIGIBLE_VOTER'
    | 'SIGNATURE_INVALID'
    | 'CONFLICT'
    | 'NOT_FOUND'
    | 'WALLET_INIT_FAILED'
    | 'CLIENT_INIT_FAILED'
    | 'IPFS_UNAVAILABLE'
    | 'HYDRA_UNREACHABLE'
    | 'NO_BALLOT_CACHED'
    | 'CLOSE_TOKEN_INVALID'
    | 'INTERNAL_ERROR';

/** Send a standardized success response. */
export function success(res: Response, data: Record<string, any>, statusCode = 200) {
    return res.status(statusCode).json({ status: 'SUCCESS', data });
}

/** Send a standardized error response with machine-readable code. */
export function error(res: Response, code: ErrorCode, message: string, statusCode: number) {
    return res.status(statusCode).json({ status: 'ERROR', code, message });
}

// ---------------------------------------------------------------------------
// Ballot Modification Guardrail
// ---------------------------------------------------------------------------

/**
 * Head states that block ballot modification (update or cancel). When the
 * head is in any of these states the (601) token is either already committed,
 * in-flight, or has left the middleware's control — the ballot must not be
 * mutated under us.
 *
 * `Unknown`, `Idle`, and `Final` are considered safe: pre-init or fully
 * settled. Anything else is active.
 */
const ACTIVE_HEAD_STATES = new Set([
    'INITIALIZING',
    'OPEN',
    'CLOSED',
    'FANOUT_POSSIBLE',
]);

export interface ModifyCheckArgs {
    /** Absolute slot at which the minting policy timelocks. */
    votingOpenSlot: number;
    /** Current tip slot (fetched by the caller from Blockfrost). */
    currentSlot: number;
    /** Safety buffer in slots before the timelock — reject if within this window. */
    bufferSlots?: number;
}

export type ModifyCheckResult =
    | { ok: true }
    | { ok: false; code: 'INVALID_INPUT' | 'CONFLICT'; message: string; statusCode: 400 | 409 };

/**
 * Shared precondition for /prepare/update and /prepare/cancel.
 * Checks head status and timelock headroom. UTxO existence must be verified
 * separately by the caller (it needs the Blockfrost fetcher already in scope).
 */
export function checkBallotModifiable(args: ModifyCheckArgs): ModifyCheckResult {
    const buffer = args.bufferSlots ?? 60;
    const status = hydraMonitor.headStatus;

    if (status && ACTIVE_HEAD_STATES.has(status)) {
        return {
            ok: false,
            code: 'CONFLICT',
            message: `Ballot cannot be modified: Hydra head is ${status}. Modifications are only allowed before /start.`,
            statusCode: 409,
        };
    }

    if (args.currentSlot >= args.votingOpenSlot - buffer) {
        return {
            ok: false,
            code: 'CONFLICT',
            message: `Ballot cannot be modified: current slot ${args.currentSlot} is at or past the minting policy timelock (${args.votingOpenSlot}, buffer ${buffer}).`,
            statusCode: 409,
        };
    }

    return { ok: true };
}

/**
 * Drive the shared HydraMonitor through the Close → FanoutPossible → Fanout
 * → Final lifecycle, starting from whatever the current status is.
 *
 * Idempotent: short-circuits on FINAL, picks up mid-sequence from CLOSED or
 * FANOUT_POSSIBLE. Safe to re-invoke after a transient error.
 *
 * Fails fast (instead of hanging 10 minutes on waitForStatus) when:
 *   - the head is in a non-closeable state (IDLE / INITIALIZING / UNKNOWN)
 *   - Hydra responds CommandFailed to the Close or Fanout command we send
 *
 * Replaces the per-route close ladder that used to live in /close,
 * /settle/close, and /settle's final step.
 *
 * @param label - Short identifier for debug logs (e.g. "settle/close").
 */
export async function driveHeadToFinal(label: string): Promise<void> {
    const currentStatus = hydraMonitor.headStatus;
    debug(`[${label}] Current status: ${currentStatus}`);

    if (currentStatus === 'FINAL') return;

    if (currentStatus !== 'OPEN'
        && currentStatus !== 'CLOSED'
        && currentStatus !== 'FANOUT_POSSIBLE') {
        const e = new Error(
            `Cannot close head: status is "${currentStatus}" — expected OPEN, CLOSED, FANOUT_POSSIBLE, or FINAL. ` +
            `The head must be fully open (post-/start) before it can be closed.`,
        ) as Error & { code?: string };
        e.code = 'HEAD_NOT_CLOSEABLE';
        throw e;
    }

    // Surface Hydra's CommandFailed rejections on Close/Fanout as a thrown
    // error so we don't silently wait out the full timeout on a rejected
    // command. Filter by clientInput.tag to ignore unrelated command
    // failures that might fire concurrently (e.g., from the tx worker).
    let commandFailure: Error | null = null;
    const onCommandFailed = (msg: any) => {
        const failedTag = msg?.clientInput?.tag;
        if (failedTag === 'Close' || failedTag === 'Fanout') {
            commandFailure = new Error(
                `Hydra rejected ${failedTag}: ${JSON.stringify(msg)}`,
            );
        }
    };
    hydraMonitor.on('error:command', onCommandFailed);

    try {
        if (currentStatus === 'FANOUT_POSSIBLE') {
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
            if (commandFailure) throw commandFailure;
            return;
        }

        if (currentStatus === 'CLOSED') {
            await hydraMonitor.waitForStatus('FANOUT_POSSIBLE', 300_000);
            if (commandFailure) throw commandFailure;
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
            if (commandFailure) throw commandFailure;
            return;
        }

        // currentStatus === 'OPEN' — send Close and drive the full lifecycle.
        hydraMonitor.ws.send({ tag: 'Close' });

        const onStatus = (status: string) => {
            if (status === 'FANOUT_POSSIBLE') {
                debug(`[${label}] Fanout possible, sending Fanout…`);
                hydraMonitor.ws.send({ tag: 'Fanout' });
            }
        };
        hydraMonitor.on('status', onStatus);

        try {
            await hydraMonitor.waitForStatus('FINAL', 600_000);
        } finally {
            hydraMonitor.removeListener('status', onStatus);
        }

        if (commandFailure) throw commandFailure;
    } finally {
        hydraMonitor.removeListener('error:command', onCommandFailed);
    }
}
