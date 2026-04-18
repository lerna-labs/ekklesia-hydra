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
    | 'SIGNATURE_INVALID'
    | 'CONFLICT'
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
