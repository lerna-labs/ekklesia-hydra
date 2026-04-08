/**
 * Shared test utilities for Ekklesia Hydra integration tests.
 *
 * These helpers are extracted from the proven E2E baseline (tests/e2e.test.ts)
 * and must stay in sync with those patterns. Do NOT modify the E2E test to
 * import from here without Adam's explicit permission.
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, setGlobalDispatcher } from 'undici';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import type { SignedVotePayload } from '../src/types.js';

// Raise test client connection limits to match middleware's capacity.
// Without this, 500 concurrent fetch() calls from the test process
// exhaust the default ~10 connections per origin and get EPIPE/socket errors.
setGlobalDispatcher(new Agent({
    connections: 1024,
    pipelining: 1,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    headersTimeout: 660_000,     // settle can take 10+ min with 1000 voters
    bodyTimeout: 660_000,
}));

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
    drepId: string;         // bech32 voter ID (drep1..., pool1..., stake_test1...)
    role: string;           // 'DRep' | 'SPO' | 'Stakeholder'
    /** For CIP-151 calidus-based SPO votes: the calidus bech32 ID (calidus1...). */
    calidusId?: string;
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
    return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.drepIdBech, role: 'DRep' };
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
                        return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.drepIdBech, role: 'DRep' } as DRepKeys;
                    })
            ),
        );
        results.push(...batch);
    }
    return results;
}

/**
 * Generate SPO (pool) key pairs concurrently.
 * Uses cardano-signer --path pool. The pool bech32 ID uses `pool` HRP.
 */
export async function generateSPOKeysBatch(count: number, concurrency = 50): Promise<DRepKeys[]> {
    const results: DRepKeys[] = [];
    for (let i = 0; i < count; i += concurrency) {
        const batchSize = Math.min(concurrency, count - i);
        const batch = await Promise.all(
            Array.from({ length: batchSize }, () =>
                execAsync('cardano-signer keygen --path pool --json-extended')
                    .then(({ stdout }) => {
                        const json = JSON.parse(stdout);
                        return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: json.poolIdBech, role: 'SPO' } as DRepKeys;
                    })
            ),
        );
        results.push(...batch);
    }
    return results;
}

/**
 * Generate Calidus-based SPO key pairs concurrently.
 * Each entry has a pool ID (voter identity) + calidus key (signing key).
 * The voter ID is pool1... but the signature comes from the calidus hot key.
 */
export async function generateCalidusSPOKeysBatch(count: number, concurrency = 50): Promise<DRepKeys[]> {
    const results: DRepKeys[] = [];
    for (let i = 0; i < count; i += concurrency) {
        const batchSize = Math.min(concurrency, count - i);
        const batch = await Promise.all(
            Array.from({ length: batchSize }, async () => {
                // Generate both a pool key (for identity) and a calidus key (for signing)
                const [poolResult, calidusResult] = await Promise.all([
                    execAsync('cardano-signer keygen --path pool --json-extended'),
                    execAsync('cardano-signer keygen --path calidus --json-extended'),
                ]);
                const poolJson = JSON.parse(poolResult.stdout);
                const calidusJson = JSON.parse(calidusResult.stdout);
                return {
                    secretKey: calidusJson.secretKey,      // sign with calidus key
                    publicKey: calidusJson.publicKey,
                    drepId: poolJson.poolIdBech,            // voter ID is the pool
                    role: 'SPO',
                    calidusId: calidusJson.calidusIdBech,   // for evidence
                } as DRepKeys;
            })
        );
        results.push(...batch);
    }
    return results;
}

/**
 * Generate Stakeholder (stake) key pairs concurrently.
 * Uses cardano-signer --path stake. Constructs testnet stake address from public key
 * using blake2b-224 (via blakejs) for proper Cardano key hash derivation.
 */
export async function generateStakeKeysBatch(count: number, concurrency = 50): Promise<DRepKeys[]> {
    const { blake2b } = await import('blakejs');
    const { bech32 } = await import('bech32');
    const results: DRepKeys[] = [];
    for (let i = 0; i < count; i += concurrency) {
        const batchSize = Math.min(concurrency, count - i);
        const batch = await Promise.all(
            Array.from({ length: batchSize }, () =>
                execAsync('cardano-signer keygen --path stake --json-extended')
                    .then(({ stdout }) => {
                        const json = JSON.parse(stdout);
                        // blake2b-224(pubkey) = proper Cardano key hash (28 bytes)
                        const pubKeyBytes = Buffer.from(json.publicKey, 'hex');
                        const keyHash = blake2b(pubKeyBytes, undefined, 28);
                        // Testnet stake address: 0xe0 header + 28-byte key hash
                        const addrBytes = Buffer.concat([Buffer.from([0xe0]), Buffer.from(keyHash)]);
                        const words = bech32.toWords(addrBytes);
                        const stakeAddr = bech32.encode('stake_test', words);
                        return { secretKey: json.secretKey, publicKey: json.publicKey, drepId: stakeAddr, role: 'Stakeholder' } as DRepKeys;
                    })
            ),
        );
        results.push(...batch);
    }
    return results;
}

/** Sign a merkle root with CIP-8 using cardano-signer. */
export function signMerkleRoot(merkleRoot: string, secretKey: string, drepAddress: string): CoseWitness {
    // Testnet addresses (stake_test, addr_test) require --testnet-magic
    const isTestnet = drepAddress.includes('_test');
    const testnetFlag = isTestnet ? ' --testnet-magic 1' : '';
    // pool/calidus addresses can't be validated against the key by cardano-signer
    // when signing with a different key (e.g., calidus key for pool address)
    const needsNoHashCheck = drepAddress.startsWith('pool') || drepAddress.startsWith('calidus');
    const noHashCheckFlag = needsNoHashCheck ? ' --nohashcheck' : '';
    const raw = execSync(
        `cardano-signer sign --cip8 --data "${merkleRoot}" --secret-key "${secretKey}" --address "${drepAddress}"${testnetFlag}${noHashCheckFlag} --json-extended`,
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