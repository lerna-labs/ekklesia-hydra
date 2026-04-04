import { getAdmin, createIpfsClient, createDiskCache } from '@lerna-labs/hydra-sdk';
import type { IpfsClient, DiskCache } from '@lerna-labs/hydra-sdk';
import { MeshWallet } from '@meshsdk/core';
import { TRPClientLogged as Client } from './trp-client.js';
import { bech32 } from 'bech32';
import { createHash } from 'crypto';
import { CREDENTIAL_PREFIX } from './types.js';
import type { VoteCacheEntry, VoteHistoryEntry } from './types.js';
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

/** Set up admin wallet and TRP client. Returns empty object on failure. */
export async function initialize(): Promise<InitializePayload> {
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

    return { admin_wallet, client };
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
