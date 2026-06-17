/**
 * Restart-persistence regression coverage.
 *
 * The middleware caches the ballot session (policy, token, ballotId,
 * resultsAddress, and the IPFS CID of the ballot definition) in memory
 * after /start. Before this was made durable, a process restart against
 * a live Hydra head left voters hitting `Ballot identity not cached. Was
 * /start called?` until an operator manually re-/start-ed.
 *
 * These tests exercise the persistence layer in isolation — they do not
 * spin up Hydra, Blockfrost, IPFS, or the Express server. They cover:
 *
 *   1. Round-trip: write file shape on disk → rehydrate → getters return
 *      the same values.
 *   2. Identity restored even when IPFS is unreachable on boot (degraded
 *      mode: ballot definition body is left null, but voting routes can
 *      still build /register and /vote-and-register transactions).
 *   3. Absent file → no-op rehydrate, all getters null.
 *   4. Malformed JSON → rehydrate throws (caller in index.ts is wrapped
 *      in try/catch and logs a warning rather than crashing the process).
 *   5. Source-code assertion: the /start handler writes the session file
 *      and the fresh-start cleanup branch removes it.
 *
 * `tests/e2e.test.ts` exercises the full live integration and is the
 * authoritative end-to-end check; these tests guard the unit contract.
 */

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Env must be set BEFORE the lifecycle module loads — IPFS_STAGING_DIR is
// captured into a module-level constant at first import. We use a per-run
// tmpdir so parallel test workers don't collide.
const TMP_STAGING = path.join(
    os.tmpdir(),
    `ekklesia-restart-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.IPFS_STAGING_DIR = TMP_STAGING;
process.env.HYDRA_WS_URL ??= 'ws://localhost:9999';
process.env.HYDRA_API_URL ??= 'http://localhost:9999';
process.env.TRP_URL ??= 'http://localhost:9999';
process.env.HYDRA_NETWORK ??= '0';

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Dynamic import so the env mutation above lands first.
const lifecycle = await import('../src/routes/lifecycle.js');
const helpers = await import('../src/helpers.js');

const here = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE_TS = resolve(here, '../src/routes/lifecycle.ts');

const SESSION_PATH = lifecycle.__BALLOT_SESSION_PATH_FOR_TESTS;

const SAMPLE_SESSION = {
    ballotIpfsCid: 'QmTestCid000000000000000000000000000000000000000',
    ballotPolicy: 'a'.repeat(56),
    ballotToken: '00259a20' + 'b'.repeat(56),
    ballotId: 'b'.repeat(56),
    resultsAddress: 'addr_test1qztest',
};

const SAMPLE_BALLOT_DEFINITION = {
    title: 'Test Ballot',
    namespace: 'vote.test.restart',
    questions: [],
} as any;

async function writeSessionFile(payload: unknown): Promise<void> {
    await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
    await fs.writeFile(SESSION_PATH, JSON.stringify(payload, null, 2));
}

async function rmSessionFile(): Promise<void> {
    try { await fs.rm(SESSION_PATH, { force: true }); } catch { /* ignore */ }
}

beforeAll(async () => {
    await fs.mkdir(TMP_STAGING, { recursive: true });
});

beforeEach(async () => {
    await rmSessionFile();
    lifecycle.__resetBallotSessionForTests();
    vi.restoreAllMocks();
});

afterAll(async () => {
    await fs.rm(TMP_STAGING, { recursive: true, force: true });
});

describe('rehydrateBallotSession', () => {
    it('returns { rehydrated: false } when no session file exists', async () => {
        const result = await lifecycle.rehydrateBallotSession();
        expect(result).toEqual({ rehydrated: false, ballotFetched: false });
        expect(lifecycle.getCachedBallot()).toBeNull();
        expect(lifecycle.getCachedBallotIdentity()).toBeNull();
        expect(lifecycle.getCachedBallotId()).toBeNull();
        expect(lifecycle.getCachedResultsAddress()).toBeNull();
    });

    it('restores all identity fields when the file exists and IPFS responds', async () => {
        await writeSessionFile(SAMPLE_SESSION);
        const fetchSpy = vi.spyOn(helpers.ipfs, 'fetchJson')
            .mockResolvedValue(SAMPLE_BALLOT_DEFINITION);

        const result = await lifecycle.rehydrateBallotSession();

        expect(result).toEqual({ rehydrated: true, ballotFetched: true });
        expect(fetchSpy).toHaveBeenCalledWith(SAMPLE_SESSION.ballotIpfsCid);
        expect(lifecycle.getCachedBallotIdentity()).toEqual({
            ballotPolicy: SAMPLE_SESSION.ballotPolicy,
            ballotToken: SAMPLE_SESSION.ballotToken,
        });
        expect(lifecycle.getCachedBallotId()).toBe(SAMPLE_SESSION.ballotId);
        expect(lifecycle.getCachedResultsAddress()).toBe(SAMPLE_SESSION.resultsAddress);
        expect(lifecycle.getCachedBallot()).toEqual(SAMPLE_BALLOT_DEFINITION);
    });

    it('degrades gracefully when IPFS is unreachable (identity restored, body null)', async () => {
        await writeSessionFile(SAMPLE_SESSION);
        const fetchSpy = vi.spyOn(helpers.ipfs, 'fetchJson')
            .mockRejectedValue(new Error('ECONNREFUSED'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await lifecycle.rehydrateBallotSession();

        expect(result).toEqual({ rehydrated: true, ballotFetched: false });
        expect(fetchSpy).toHaveBeenCalledWith(SAMPLE_SESSION.ballotIpfsCid);
        // Identity is what voting routes need to build txs — must be present.
        expect(lifecycle.getCachedBallotIdentity()).toEqual({
            ballotPolicy: SAMPLE_SESSION.ballotPolicy,
            ballotToken: SAMPLE_SESSION.ballotToken,
        });
        expect(lifecycle.getCachedBallotId()).toBe(SAMPLE_SESSION.ballotId);
        expect(lifecycle.getCachedResultsAddress()).toBe(SAMPLE_SESSION.resultsAddress);
        // Body is the only thing that should be missing in degraded mode.
        expect(lifecycle.getCachedBallot()).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('handles a session with null ballotIpfsCid (no IPFS lookup attempted)', async () => {
        const sessionNoCid = { ...SAMPLE_SESSION, ballotIpfsCid: null };
        await writeSessionFile(sessionNoCid);
        const fetchSpy = vi.spyOn(helpers.ipfs, 'fetchJson');

        const result = await lifecycle.rehydrateBallotSession();

        expect(result).toEqual({ rehydrated: true, ballotFetched: false });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(lifecycle.getCachedBallotIdentity()).toEqual({
            ballotPolicy: SAMPLE_SESSION.ballotPolicy,
            ballotToken: SAMPLE_SESSION.ballotToken,
        });
        expect(lifecycle.getCachedBallot()).toBeNull();
    });

    it('handles a session with null resultsAddress', async () => {
        const sessionNoAddr = { ...SAMPLE_SESSION, resultsAddress: null };
        await writeSessionFile(sessionNoAddr);
        vi.spyOn(helpers.ipfs, 'fetchJson').mockResolvedValue(SAMPLE_BALLOT_DEFINITION);

        const result = await lifecycle.rehydrateBallotSession();

        expect(result.rehydrated).toBe(true);
        expect(lifecycle.getCachedResultsAddress()).toBeNull();
    });

    it('throws on malformed JSON so the caller can log and continue', async () => {
        await fs.mkdir(path.dirname(SESSION_PATH), { recursive: true });
        await fs.writeFile(SESSION_PATH, '{ this is not valid json');
        await expect(lifecycle.rehydrateBallotSession()).rejects.toThrow();
    });
});

describe('source-code contract: /start writes, fresh-start wipes', () => {
    const lifecycleSource = readFileSync(LIFECYCLE_TS, 'utf-8');

    it('/start handler calls writeBallotSession with the full identity tuple', () => {
        // Persistence call must reference all five session fields by name.
        expect(lifecycleSource).toMatch(/writeBallotSession\(/);
        // Check the call site enumerates the persisted fields. Catches a
        // refactor that drops one of them (e.g. forgets resultsAddress).
        const writeCallMatch = lifecycleSource.match(
            /writeBallotSession\(\{[\s\S]*?ballotIpfsCid:[\s\S]*?ballotPolicy:[\s\S]*?ballotToken:[\s\S]*?ballotId:[\s\S]*?resultsAddress:[\s\S]*?\}\)/,
        );
        expect(writeCallMatch, 'writeBallotSession call must pass all five fields').not.toBeNull();
    });

    it('fresh-start cleanup branch removes the session file', () => {
        // BALLOT_SESSION_PATH is referenced inside an fs.rm call in the
        // same cleanup block that nukes pre-burn-ledger.json. Without
        // this, a fresh /start against a stale staging directory would
        // leave a misleading file behind for the next boot to read.
        expect(lifecycleSource).toMatch(/fs\.rm\(BALLOT_SESSION_PATH/);
    });

    it('atomic write goes through tmp + rename, not direct overwrite', () => {
        // Guards against future "simplifications" that introduce a torn
        // write hazard on process kill between open() and close().
        expect(lifecycleSource).toMatch(/fs\.rename\(tmpPath, BALLOT_SESSION_PATH\)/);
    });
});
