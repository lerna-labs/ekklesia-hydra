/**
 * Operational detail for the keyed GET /health: dependency probes and the
 * registered-voter count. Everything here is bounded by PROBE_TIMEOUT_MS,
 * cached, single-flight, and never throws, so a slow or failing dependency
 * cannot change the status code of /health or hold it open past the timeout.
 * No URL, key or upstream text is ever returned; failures map to a closed
 * list of reasons.
 */

import { IPFS_API_URL } from './helpers.js';
import { BALLOT_DEFINITION_PREFIX, BALLOT_INSTANCE_PREFIX } from './types.js';

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_CACHE_MS = 15_000;
export const REGISTERED_CACHE_MS = 30_000;

export type ProbeReason =
    | 'provider_unreachable'
    | 'provider_auth_failed'
    | 'provider_rate_limited'
    | 'provider_error'
    | 'timeout'
    | 'not_configured';

export interface ProbeResult {
    state: 'ok' | 'down' | 'not_configured';
    reason?: ProbeReason;
    checkedAt: string;
}

export interface HealthProbes {
    ipfs: ProbeResult;
    trp: ProbeResult;
    blockfrost: ProbeResult;
}

// ---------------------------------------------------------------------------
// Cache with single-flight
// ---------------------------------------------------------------------------

interface Memo<T> {
    value: T | undefined;
    at: number;
    inflight: Promise<T> | null;
}

const memos: Array<Memo<unknown>> = [];

function createMemo<T>(): Memo<T> {
    const memo: Memo<T> = { value: undefined, at: 0, inflight: null };
    memos.push(memo as Memo<unknown>);
    return memo;
}

async function memoized<T>(memo: Memo<T>, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (memo.value !== undefined && Date.now() - memo.at < ttlMs) return memo.value;
    if (memo.inflight) return memo.inflight;
    memo.inflight = load()
        .then((value) => {
            memo.value = value;
            memo.at = Date.now();
            return value;
        })
        .finally(() => { memo.inflight = null; });
    return memo.inflight;
}

/** Test-only: drop every cached probe and count. */
export function __resetHealthDetailForTests(): void {
    for (const memo of memos) {
        memo.value = undefined;
        memo.at = 0;
        memo.inflight = null;
    }
    blockfrostBaseOverride = null;
    registeredHeadId = null;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const ok = (): ProbeResult => ({ state: 'ok', checkedAt: new Date().toISOString() });
const down = (reason: ProbeReason): ProbeResult => ({ state: 'down', reason, checkedAt: new Date().toISOString() });

function statusReason(status: number): ProbeReason {
    if (status === 401 || status === 403) return 'provider_auth_failed';
    if (status === 429) return 'provider_rate_limited';
    return 'provider_error';
}

/**
 * Send one bounded request and reduce the outcome to an HTTP status or a
 * closed reason. The body is never read and the error text never leaves here.
 */
async function request(url: string, init: RequestInit): Promise<{ status: number } | { reason: ProbeReason }> {
    try {
        const res = await fetch(url, {
            ...init,
            redirect: 'manual',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        void res.body?.cancel().catch(() => {});
        return { status: res.status };
    } catch (err: any) {
        const name = err?.name;
        return { reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_unreachable' };
    }
}

async function probeIpfs(): Promise<ProbeResult> {
    const base = IPFS_API_URL.replace(/\/+$/, '');
    const res = await request(`${base}/api/v0/id`, { method: 'POST' });
    if ('reason' in res) return down(res.reason);
    return res.status >= 200 && res.status < 300 ? ok() : down(statusReason(res.status));
}

async function probeTrp(): Promise<ProbeResult> {
    const url = process.env.TRP_URL;
    if (!url) return { state: 'not_configured', reason: 'not_configured', checkedAt: new Date().toISOString() };
    const res = await request(url, { method: 'GET' });
    if ('reason' in res) return down(res.reason);
    if (res.status === 401 || res.status === 403) return down('provider_auth_failed');
    return res.status < 500 ? ok() : down('provider_error');
}

let blockfrostBaseOverride: string | null = null;

/** Test-only: point the Blockfrost probe at a local server. */
export function __setBlockfrostBaseForTests(base: string): void {
    blockfrostBaseOverride = base;
}

async function probeBlockfrost(): Promise<ProbeResult> {
    const key = process.env.BLOCKFROST_API_KEY;
    if (!key) return { state: 'not_configured', reason: 'not_configured', checkedAt: new Date().toISOString() };
    // Resolved as Mesh's BlockfrostProvider does: a value starting with http or /
    // is the base URL itself (no project_id header); anything else is a project
    // id whose first seven characters name the network.
    const isBase = key.startsWith('http') || key.startsWith('/');
    const base = isBase
        ? key.replace(/\/+$/, '')
        : blockfrostBaseOverride ?? `https://cardano-${key.slice(0, 7)}.blockfrost.io/api/v0`;
    const res = await request(`${base}/blocks/latest`, { method: 'GET', headers: isBase ? {} : { project_id: key } });
    if ('reason' in res) return down(res.reason);
    return res.status >= 200 && res.status < 300 ? ok() : down(statusReason(res.status));
}

const ipfsMemo = createMemo<ProbeResult>();
const trpMemo = createMemo<ProbeResult>();
const blockfrostMemo = createMemo<ProbeResult>();

/** All three probes in parallel; each is cached for 15 seconds and shared by concurrent callers. */
export async function getHealthProbes(): Promise<HealthProbes> {
    const guard = (load: () => Promise<ProbeResult>) => async (): Promise<ProbeResult> => {
        try { return await load(); } catch { return down('provider_error'); }
    };
    const [ipfs, trp, blockfrost] = await Promise.all([
        memoized(ipfsMemo, PROBE_CACHE_MS, guard(probeIpfs)),
        memoized(trpMemo, PROBE_CACHE_MS, guard(probeTrp)),
        memoized(blockfrostMemo, PROBE_CACHE_MS, guard(probeBlockfrost)),
    ]);
    return { ipfs, trp, blockfrost };
}

// ---------------------------------------------------------------------------
// Registered voters
// ---------------------------------------------------------------------------

/**
 * Count voter tokens in a head snapshot: assets under the voter policy,
 * excluding the ballot definition and instance tokens that share it. Distinct asset
 * names are counted, so a voter holding two tokens of one name counts once.
 */
export function countVoterTokens(snapshot: Record<string, any>, voterPolicy: string): number {
    const names = new Set<string>();
    for (const utxo of Object.values(snapshot)) {
        const assets = utxo?.value?.[voterPolicy];
        if (!assets || typeof assets !== 'object') continue;
        for (const name of Object.keys(assets)) {
            if (name.startsWith(BALLOT_INSTANCE_PREFIX) || name.startsWith(BALLOT_DEFINITION_PREFIX)) continue;
            names.add(name);
        }
    }
    return names.size;
}

const registeredMemo = createMemo<number | null>();
let registeredHeadId: string | null = null;

/**
 * Registered-voter count from `read`, cached for 30 seconds with a single
 * snapshot read shared by concurrent callers. A failed or slow read yields
 * null (and is cached like any other result).
 */
export function getRegisteredVoters(headId: string | null, read: () => Promise<number | null>): Promise<number | null> {
    // A count belongs to the head it was read from; a different head starts afresh.
    if (headId !== registeredHeadId) {
        registeredHeadId = headId;
        registeredMemo.value = undefined;
        registeredMemo.at = 0;
        registeredMemo.inflight = null;
    }
    return memoized(registeredMemo, REGISTERED_CACHE_MS, async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                read(),
                new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS); }),
            ]);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    });
}
