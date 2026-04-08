import { getAdmin, createIpfsClient, createDiskCache, submitTx, HydraMonitor } from '@lerna-labs/hydra-sdk';
import type { IpfsClient, DiskCache } from '@lerna-labs/hydra-sdk';
import { MeshWallet } from '@meshsdk/core';
import { TRPClientLogged as Client } from './trp-client.js';
import { bech32 } from 'bech32';
import { createHash } from 'crypto';
import { CREDENTIAL_PREFIX } from './types.js';
import type { VoteCacheEntry, VoteHistoryEntry } from './types.js';
import { TxQueue } from './tx-queue.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

export const TRP_URL = process.env.TRP_URL as string;
export const HYDRA_NETWORK = parseInt(process.env.HYDRA_NETWORK || '0', 10);
export const CLOSE_TOKEN = process.env.CLOSE_TOKEN || 'shutitdown';
export const IPFS_API_URL = process.env.IPFS_API_URL || 'http://localhost:5001';
export const IPFS_STAGING_DIR = process.env.IPFS_STAGING_DIR || '/ipfs-staging';
export const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';
export const TX_MODE = (process.env.TX_MODE || 'trp') as 'trp' | 'direct';

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
// UTxO Reference Cache (for direct tx pipeline)
// ---------------------------------------------------------------------------

import type { UtxoRef, Amount } from './tx-builder.js';
import { hydraValueToAmounts } from './tx-builder.js';

export interface CachedUtxo {
    ref: UtxoRef;
    value: Amount[];
    datum?: any;
    address: string;
}

/** Ballot token UTxO — shared gas input for register/finalize. */
let _ballotUtxo: CachedUtxo | null = null;

/** Per-voter token UTxOs — keyed by userId (hex asset name). */
const _voterUtxos = new Map<string, CachedUtxo>();

export function getBallotUtxo(): CachedUtxo | null { return _ballotUtxo; }
export function setBallotUtxo(u: CachedUtxo | null): void { _ballotUtxo = u; }
export function getVoterUtxo(userId: string): CachedUtxo | undefined { return _voterUtxos.get(userId); }
export function setVoterUtxo(userId: string, u: CachedUtxo): void { _voterUtxos.set(userId, u); }
export function deleteVoterUtxo(userId: string): void { _voterUtxos.delete(userId); }
export function clearUtxoCache(): void { _ballotUtxo = null; _voterUtxos.clear(); }

/**
 * Seed the ballot UTxO cache from the head snapshot.
 * Called once after head opens and on reconnect.
 */
export async function seedBallotUtxoFromSnapshot(
    snapshotUtxos: Record<string, any>,
    ballotInstancePrefix: string,
): Promise<CachedUtxo | null> {
    for (const [ref, utxo] of Object.entries(snapshotUtxos)) {
        const u = utxo as any;
        for (const [pid, assets] of Object.entries(u.value)) {
            if (pid === 'lovelace' || typeof assets !== 'object') continue;
            for (const name of Object.keys(assets as Record<string, number>)) {
                if (name.startsWith(ballotInstancePrefix)) {
                    const [txHash, idx] = ref.split('#');
                    const cached: CachedUtxo = {
                        ref: { txHash, outputIndex: parseInt(idx) },
                        value: hydraValueToAmounts(u.value),
                        datum: u.inlineDatum,
                        address: u.address,
                    };
                    _ballotUtxo = cached;
                    debug(`[utxo-cache] Ballot UTxO seeded: ${ref}`);
                    return cached;
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Direct WebSocket submission (bypass TRP)
// ---------------------------------------------------------------------------

/**
 * Submit a signed transaction directly to the Hydra head via WebSocket.
 *
 * Sends `NewTx` on the monitor's existing WebSocket connection and waits
 * for `TxValid` (success) or `TxInvalid` (failure).
 *
 * No HTTP overhead, no TRP rate limiting.
 */
import { deserializeTx } from '@meshsdk/core-cst';

/**
 * Compute the Cardano transaction hash from unsigned or signed CBOR.
 * The tx hash is blake2b-256 of the tx body, which doesn't change after signing.
 */
function computeTxHash(cborHex: string): string {
    return deserializeTx(cborHex).body().hash();
}

export interface SubmitDirectOptions {
    timeoutMs?: number;
    /** Wait for SnapshotConfirmed before resolving. Default true.
     *  Set to false for non-contending operations (cast_vote, burns)
     *  where the tx spends a unique UTxO and no other tx depends on it. */
    awaitSnapshot?: boolean;
}

export async function submitDirect(
    signedCborHex: string,
    unsignedCborHex?: string,
    options?: SubmitDirectOptions,
): Promise<{ hash: string }> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const awaitSnapshot = options?.awaitSnapshot ?? true;
    const ws = hydraMonitor.ws;

    if (ws.connectionState !== 'CONNECTED') {
        debug('[submitDirect] WebSocket not connected, reconnecting…');
        await ws.waitForGreetings();
    }

    const expectedTxId = computeTxHash(unsignedCborHex ?? signedCborHex);
    debug(`[submitDirect] Submitting tx ${expectedTxId.slice(0, 16)}… (awaitSnapshot=${awaitSnapshot})`);

    return new Promise((resolve, reject) => {
        let settled = false;
        let txAccepted = false;

        const settle = (fn: Function, value: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.removeListener('message', onMsg);
            fn(value);
        };

        const timer = setTimeout(
            () => settle(reject, new Error(`submitDirect timed out for tx ${expectedTxId.slice(0, 16)}…`)),
            timeoutMs,
        );

        const onMsg = (msg: any) => {
            if (msg.tag === 'TxValid' && msg.transactionId === expectedTxId) {
                debug(`[submitDirect] TxValid accepted: ${expectedTxId.slice(0, 16)}…`);
                if (!awaitSnapshot) {
                    // Non-contending: resolve immediately on TxValid
                    settle(resolve, { hash: expectedTxId });
                    return;
                }
                txAccepted = true;
            } else if (msg.tag === 'TxInvalid') {
                const invalidTxId = msg.transaction?.txId ?? msg.txId ?? '';
                if (invalidTxId === expectedTxId) {
                    const reason = msg.validationError?.reason ?? JSON.stringify(msg);
                    debug(`[submitDirect] TxInvalid for ${expectedTxId.slice(0, 16)}…: ${reason.slice(0, 200)}`);
                    settle(reject, new Error(`TxInvalid: ${reason}`));
                }
            } else if (msg.tag === 'SnapshotConfirmed' && txAccepted) {
                const confirmed: any[] = msg.snapshot?.confirmed ?? msg.confirmed ?? [];
                const found = confirmed.some((tx: any) => tx.txId === expectedTxId);
                if (found) {
                    debug(`[submitDirect] SnapshotConfirmed for ${expectedTxId.slice(0, 16)}…`);
                    settle(resolve, { hash: expectedTxId });
                }
            }
        };

        ws.on('message', onMsg);

        ws.send({
            tag: 'NewTx',
            transaction: {
                type: 'Witnessed Tx ConwayEra' as const,
                description: '',
                cborHex: signedCborHex,
            },
        });
    });
}

/**
 * Submit a batch of transactions concurrently via WebSocket.
 * Resolves on TxValid for each tx (no SnapshotConfirmed wait — batched burns are non-contending).
 * Returns results keyed by the provided `id` for each tx.
 */
export async function submitDirectBatch(
    txs: Array<{ signedCborHex: string; unsignedCborHex: string; id: string }>,
    timeoutMs = 120_000,
): Promise<{ succeeded: Map<string, string>; failed: Map<string, string> }> {
    const ws = hydraMonitor.ws;

    if (ws.connectionState !== 'CONNECTED') {
        debug('[submitDirectBatch] WebSocket not connected, reconnecting…');
        await ws.waitForGreetings();
    }

    // Compute tx hashes upfront and build lookup maps
    const hashToId = new Map<string, string>();
    const txEntries: Array<{ id: string; hash: string; signedCborHex: string }> = [];
    for (const tx of txs) {
        const hash = computeTxHash(tx.unsignedCborHex);
        hashToId.set(hash, tx.id);
        txEntries.push({ id: tx.id, hash, signedCborHex: tx.signedCborHex });
    }

    debug(`[submitDirectBatch] Submitting ${txs.length} txs…`);

    return new Promise((resolve, reject) => {
        const succeeded = new Map<string, string>(); // id → txHash
        const failed = new Map<string, string>();     // id → reason
        let settled = false;
        const total = txEntries.length;

        const checkDone = () => {
            if (succeeded.size + failed.size >= total) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                ws.removeListener('message', onMsg);
                resolve({ succeeded, failed });
            }
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ws.removeListener('message', onMsg);
            // Mark remaining as timed out
            for (const entry of txEntries) {
                if (!succeeded.has(entry.id) && !failed.has(entry.id)) {
                    failed.set(entry.id, 'timeout');
                }
            }
            resolve({ succeeded, failed });
        }, timeoutMs);

        const onMsg = (msg: any) => {
            if (msg.tag === 'TxValid') {
                const txId = msg.transactionId;
                const id = hashToId.get(txId);
                if (id && !succeeded.has(id)) {
                    succeeded.set(id, txId);
                    checkDone();
                }
            } else if (msg.tag === 'TxInvalid') {
                const txId = msg.transaction?.txId ?? msg.txId ?? '';
                const id = hashToId.get(txId);
                if (id && !failed.has(id)) {
                    const reason = msg.validationError?.reason ?? 'unknown';
                    failed.set(id, reason);
                    checkDone();
                }
            }
        };

        ws.on('message', onMsg);

        // Fire all NewTx messages
        for (const entry of txEntries) {
            ws.send({
                tag: 'NewTx',
                transaction: {
                    type: 'Witnessed Tx ConwayEra' as const,
                    description: '',
                    cborHex: entry.signedCborHex,
                },
            });
        }
    });
}

/**
 * Check if a TxInvalid error is retryable (stale UTxO ref).
 * When this returns true, the caller should rehydrate the UTxO cache
 * from the head snapshot and rebuild the transaction.
 */
export function isDirectRetryable(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('badinputsutxo') || lower.includes('bad inputs');
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
// Transaction Queue (singleton)
// ---------------------------------------------------------------------------

export const txQueue = new TxQueue(IPFS_STAGING_DIR);

/**
 * Parse a TRP submitTx response. Throws on JSON-RPC errors so the caller
 * doesn't silently treat a rejected transaction as success.
 */
export function parseTrpSubmitResponse(responseText: string): { hash?: string } {
    const parsed = JSON.parse(responseText);
    if (parsed.error) {
        const detail = typeof parsed.error.data === 'string'
            ? parsed.error.data
            : JSON.stringify(parsed.error.data);
        throw new Error(`TRP submit rejected: ${parsed.error.message} — ${detail}`);
    }
    return { hash: parsed.result?.hash ?? parsed.hash };
}

/**
 * Check if a TRP error is retryable.
 *
 * Retryable conditions:
 * - UTxO contention (BadInputsUTxO, stale snapshot)
 * - Rate limiting (HTTP 429 from TRP/Dolos)
 * - Failed to resolve (TRP behind head state)
 *
 * Non-retryable errors (validation, script errors) should fail immediately.
 */
export function isRetryableError(err: { message?: string; statusCode?: number }): boolean {
    // HTTP 429 — TRP rate limit
    if (err.statusCode === 429) return true;

    const lower = (err.message ?? '').toLowerCase();
    return (
        lower.includes('429') ||
        lower.includes('too many requests') ||
        lower.includes('badinputsutxo') ||
        lower.includes('bad inputs') ||
        lower.includes('utxo') && lower.includes('not found') ||
        lower.includes('failed to resolve')
    );
}

export interface RetryOptions {
    maxAttempts?: number;    // default: 5
    baseDelayMs?: number;   // default: 150
    maxDelayMs?: number;    // default: 2000
    timeoutMs?: number;     // default: 60000 (60s total budget)
}

/**
 * Resolve, sign, and submit a transaction with automatic retry on UTxO contention.
 *
 * When the Hydra head snapshot updates between resolve and submit (or TRP is
 * behind the head), the transaction references a stale UTxO. This function
 * re-resolves against the latest snapshot and retries.
 *
 * Only retries on contention errors (BadInputsUTxO, Failed to resolve).
 * Validation errors, script errors, etc. fail immediately.
 */
export async function submitWithRetry(
    resolveFn: () => Promise<{ tx: string }>,
    signFn: (tx: string) => Promise<string>,
    submitId: string,
    options?: RetryOptions,
): Promise<{ hash: string; attempts: number }> {
    const maxAttempts = options?.maxAttempts ?? 5;
    const baseDelayMs = options?.baseDelayMs ?? 150;
    const maxDelayMs = options?.maxDelayMs ?? 2000;
    const timeoutMs = options?.timeoutMs ?? 60_000;

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Check total time budget
        if (Date.now() - startTime > timeoutMs) {
            throw lastError ?? new Error(`submitWithRetry timed out after ${timeoutMs}ms`);
        }

        try {
            // 1. Resolve against latest snapshot
            const { tx } = await resolveFn();

            // 2. Sign locally
            const signedTx = await signFn(tx);

            // 3. Submit to TRP
            const submitResponse = await submitTx(TRP_URL, signedTx, submitId);
            const submitText = await submitResponse.text();

            // 4. Parse — throws on error
            const { hash } = parseTrpSubmitResponse(submitText);

            if (attempt > 1) {
                debug(`[submitWithRetry] Succeeded on attempt ${attempt} for ${submitId}`);
            }

            return { hash: hash ?? '', attempts: attempt };
        } catch (err: any) {
            lastError = err;

            // Don't retry non-retryable errors
            if (!isRetryableError(err)) {
                throw err;
            }

            // Don't retry if we've exhausted attempts
            if (attempt >= maxAttempts) {
                throw err;
            }

            // Don't retry if we've exceeded the time budget
            const elapsed = Date.now() - startTime;
            if (elapsed > timeoutMs) {
                throw err;
            }

            // Exponential backoff with jitter
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            const jitter = Math.floor(Math.random() * delay * 0.3);
            debug(`[submitWithRetry] Attempt ${attempt} failed for ${submitId} (${err.message?.slice(0, 60)}), retrying in ${delay + jitter}ms`);
            await new Promise(r => setTimeout(r, delay + jitter));
        }
    }

    // Should never reach here, but just in case
    throw lastError ?? new Error('submitWithRetry exhausted all attempts');
}

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
        throw new Error(`Unrecognized bech32 prefix: "${hrp}"`);
    }

    const bytes = bech32.fromWords(decoded.words);

    // blake2b-224: hash to 28 bytes via hex truncation
    const fullHash = createHash('blake2b512')
        .update(Buffer.from(bytes))
        .digest('hex');
    const hashHex = fullHash.substring(0, 56); // 28 bytes = 56 hex chars

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
