/**
 * Shared test utilities for Ekklesia Hydra integration tests.
 *
 * These helpers are extracted from the proven E2E baseline (tests/e2e.test.ts)
 * and must stay in sync with those patterns. Do NOT modify the E2E test to
 * import from here without Adam's explicit permission.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import type { SignedVotePayload } from '../src/types.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Config — read from environment, shared across all test files
// ---------------------------------------------------------------------------

export const API_URL = process.env.E2E_API_URL ?? '';
export const API_KEY = process.env.E2E_API_KEY ?? '';
export const CLOSE_TOKEN = process.env.E2E_CLOSE_TOKEN ?? 'shutitdown';
export const BLOCKFROST_KEY = process.env.E2E_BLOCKFROST_KEY ?? '';
export const DUMP_ADDRESS = process.env.E2E_DUMP_ADDRESS ?? '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DRepKeys {
    secretKey: string;
    publicKey: string;
    drepId: string;
}

export interface CoseWitness {
    coseSign1Hex: string;
    coseKeyHex: string;
    key: string;
    signature: string;
}

export interface ApiResponse {
    status: number;
    json: any;
    durationMs: number;
}

// ---------------------------------------------------------------------------
// Cardano-signer CLI wrappers
// ---------------------------------------------------------------------------

/** Generate a fresh DRep key pair via cardano-signer. */
export function generateDRepKeys(): DRepKeys {
    const raw = execSync('cardano-signer keygen --path drep --json-extended', { encoding: 'utf-8' });
    const json = JSON.parse(raw);
    return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.drepIdBech };
}

/**
 * Generate multiple DRep key pairs concurrently.
 * Spawns up to `concurrency` processes at a time to avoid overwhelming the OS.
 * Much faster than sequential execSync for large voter counts.
 */
export async function generateDRepKeysBatch(count: number, concurrency = 50): Promise<DRepKeys[]> {
    const results: DRepKeys[] = [];
    for (let i = 0; i < count; i += concurrency) {
        const batchSize = Math.min(concurrency, count - i);
        const batch = await Promise.all(
            Array.from({ length: batchSize }, () =>
                execAsync('cardano-signer keygen --path drep --json-extended')
                    .then(({ stdout }) => {
                        const json = JSON.parse(stdout);
                        return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.drepIdBech } as DRepKeys;
                    })
            ),
        );
        results.push(...batch);
    }
    return results;
}

/** Sign a merkle root with CIP-8 using cardano-signer. */
export function signMerkleRoot(merkleRoot: string, secretKey: string, drepAddress: string): CoseWitness {
    const raw = execSync(
        `cardano-signer sign --cip8 --data "${merkleRoot}" --secret-key "${secretKey}" --address "${drepAddress}" --json-extended`,
        { encoding: 'utf-8' },
    );
    const json = JSON.parse(raw);
    return {
        coseSign1Hex: json.output.COSE_Sign1_hex,
        coseKeyHex: json.output.COSE_Key_hex,
        key: json.publicKey,
        signature: json.signature,
    };
}

/** Compute blake2b-256 hash of a signed vote payload. */
export function computeMerkleRoot(payload: SignedVotePayload): string {
    return bytesToHex(blake2b256(JSON.stringify(payload)));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

const headers = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });

/**
 * Make an API call to the middleware. Returns status, parsed JSON, and
 * elapsed time in milliseconds.
 */
export async function api(method: string, path: string, body?: unknown, timeoutMs = 300_000): Promise<ApiResponse> {
    const start = performance.now();
    const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = performance.now() - start;
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, durationMs: Math.round(elapsed) };
}

// ---------------------------------------------------------------------------
// L1 confirmation polling
// ---------------------------------------------------------------------------

/**
 * Poll Blockfrost until a transaction reaches the required confirmation depth.
 * Logs depth at each attempt for diagnostics.
 */
export async function waitForL1Confirmation(txHash: string, minDepth = 2, maxAttempts = 15) {
    if (!BLOCKFROST_KEY) throw new Error('E2E_BLOCKFROST_KEY is required');
    const networkPrefix = BLOCKFROST_KEY.startsWith('mainnet') ? 'cardano-mainnet'
        : BLOCKFROST_KEY.startsWith('preprod') ? 'cardano-preprod' : 'cardano-preview';
    const bfBase = `https://${networkPrefix}.blockfrost.io/api/v0`;
    const bfHeaders = { project_id: BLOCKFROST_KEY };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const txRes = await fetch(`${bfBase}/txs/${txHash}`, { headers: bfHeaders });
        if (txRes.ok) {
            const txData = await txRes.json() as { block_height: number };
            const tipRes = await fetch(`${bfBase}/blocks/latest`, { headers: bfHeaders });
            const tipData = await tipRes.json() as { height: number };
            const depth = tipData.height - txData.block_height;
            console.log(`  L1 depth: ${depth} (height ${txData.block_height}, tip ${tipData.height})`);
            if (depth >= minDepth) return;
        }
        if (attempt === maxAttempts - 1) throw new Error(`Tx ${txHash} not confirmed after ${maxAttempts * 40}s`);
        await new Promise(r => setTimeout(r, 40_000));
    }
}