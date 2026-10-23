/**
 * GET /health operational detail: ballot identity, voter and vote counts,
 * queue state, snapshot number and dependency probes, against fake IPFS, TRP
 * and Blockfrost servers.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

const SNAPSHOT_GET = vi.hoisted(() => vi.fn());

vi.mock('@lerna-labs/hydra-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@lerna-labs/hydra-sdk')>();
    class FakeWrangler {
        http = { getSnapshotUtxo: SNAPSHOT_GET };
    }
    return {
        ...actual,
        Wrangler: FakeWrangler,
        getAdmin: async () => ({ addresses: { enterpriseAddressBech32: 'addr_test1admin' } }),
        createNativeScript: () => ({ scriptHash: VOTER_POLICY }),
    };
});

const API_KEY = 'health-enrichment-key';
const BLOCKFROST_KEY = 'preprodSECRETBLOCKFROSTKEY';
const TRP_SECRET = 'secret-trp-path-key';
const VOTER_POLICY = 'a'.repeat(56);
const BALLOT_POLICY = 'b'.repeat(56);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Fake {
    server: Server;
    hits: number;
    handler: Handler;
    url: string;
}

async function fake(initial: Handler): Promise<Fake> {
    const f = { hits: 0, handler: initial } as Fake;
    f.server = createServer((req, res) => {
        f.hits++;
        f.handler(req, res);
    });
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', () => r()));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
    return f;
}

const answer = (status: number): Handler => (_req, res) => { res.statusCode = status; res.end('upstream says SECRETTEXT'); };
const hang: Handler = () => {};

let ipfsFake: Fake;
let trpFake: Fake;
let bfFake: Fake;
let app: Server;
let appPort: number;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};

let helpers: typeof import('../src/helpers.js');
let lifecycle: typeof import('../src/routes/lifecycle.js');
let detail: typeof import('../src/health-detail.js');
let monitorStatus: string;

function get(path: string, headers: Record<string, string> = { 'x-api-key': API_KEY }): Promise<{ status: number; body: any; text: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: appPort, path, method: 'GET', headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode!, text, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end();
    });
}

const ENV = ['X_API_KEY', 'IPFS_STAGING_DIR', 'IPFS_API_URL', 'TRP_URL', 'BLOCKFROST_API_KEY'] as const;

beforeAll(async () => {
    for (const name of ENV) savedEnv[name] = process.env[name];
    ipfsFake = await fake(answer(200));
    trpFake = await fake(answer(404));
    bfFake = await fake(answer(200));

    scratch = await mkdtemp(join(tmpdir(), 'hydra-health-'));
    process.env.X_API_KEY = API_KEY;
    process.env.IPFS_STAGING_DIR = join(scratch, 'staging');
    process.env.IPFS_API_URL = ipfsFake.url;
    process.env.TRP_URL = `${trpFake.url}/${TRP_SECRET}`;
    process.env.BLOCKFROST_API_KEY = BLOCKFROST_KEY;
    await mkdir(process.env.IPFS_STAGING_DIR, { recursive: true });

    helpers = await import('../src/helpers.js');
    lifecycle = await import('../src/routes/lifecycle.js');
    detail = await import('../src/health-detail.js');
    const { createApp } = await import('../src/app.js');

    vi.spyOn(helpers.hydraMonitor, 'connected', 'get').mockReturnValue(true);
    vi.spyOn(helpers.hydraMonitor, 'headInfo', 'get').mockImplementation(
        () => ({ headStatus: monitorStatus, headId: 'head1', nodeVersion: '2.0.0' }) as any,
    );

    const expressApp: Express = createApp();
    app = expressApp.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    appPort = (app.address() as AddressInfo).port;
});

afterAll(async () => {
    vi.restoreAllMocks();
    app.close();
    for (const f of [ipfsFake, trpFake, bfFake]) {
        f.server.closeAllConnections();
        f.server.close();
    }
    await rm(scratch, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

beforeEach(async () => {
    detail.__resetHealthDetailForTests();
    detail.__setBlockfrostBaseForTests(bfFake.url);
    lifecycle.__resetBallotSessionForTests();
    monitorStatus = 'OPEN';
    for (const f of [ipfsFake, trpFake, bfFake]) f.hits = 0;
    ipfsFake.handler = answer(200);
    trpFake.handler = answer(404);
    bfFake.handler = answer(200);
    process.env.BLOCKFROST_API_KEY = BLOCKFROST_KEY;
    SNAPSHOT_GET.mockReset();
    SNAPSHOT_GET.mockResolvedValue({});
    vi.spyOn(helpers.voteCache, 'getAll').mockReturnValue([]);
    vi.spyOn(helpers.txQueue, 'status').mockReturnValue(
        { built: 0, submitted: 0, accepted: 0, confirmed: 0, applied: 0, failed: 0, total: 0 },
    );
});

describe('GET /health detail', () => {
    it('keeps the key check and every existing field', async () => {
        expect((await get('/health', {})).status).toBe(401);
        const res = await get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('SUCCESS');
        expect(res.body.data).toMatchObject({
            headStatus: 'OPEN',
            headId: 'head1',
            nodeVersion: '2.0.0',
            connected: true,
            depositStatus: null,
            ballotActive: false,
        });
        expect(Object.keys(res.body.data.deposit).sort()).toEqual([
            'depositPeriodSec', 'error', 'estimatedReadyAt', 'observedAt', 'prime', 'readyAt', 'status', 'submittedAt', 'txIds',
        ]);
    });

    it('reports null ballot fields when no ballot is cached', async () => {
        const { data } = (await get('/health')).body;
        expect(data.ballot).toEqual({ ballotId: null, policyId: null });
        expect(data.snapshotNumber).toBeNull();
    });

    it('reports the cached ballot identity', async () => {
        await writeFile(
            join(process.env.IPFS_STAGING_DIR!, 'ballot-session.json'),
            JSON.stringify({ ballotPolicy: BALLOT_POLICY, ballotToken: 'cc', ballotId: 'dd', resultsAddress: null, ballotIpfsCid: null }),
        );
        await lifecycle.rehydrateBallotSession();
        const { data } = (await get('/health')).body;
        expect(data.ballot).toEqual({ ballotId: 'dd', policyId: BALLOT_POLICY });
    });

    it('counts vote-cache entries as voters.voted', async () => {
        vi.spyOn(helpers.voteCache, 'getAll').mockReturnValue([{}, {}, {}] as any);
        expect((await get('/health')).body.data.voters.voted).toBe(3);
    });

    it('counts voter tokens in the snapshot as voters.registered, excluding ballot tokens', async () => {
        SNAPSHOT_GET.mockResolvedValue({
            'tx1#0': { value: { lovelace: 0, [VOTER_POLICY]: { '01aa': 1 } } },
            'tx2#0': { value: { lovelace: 0, [VOTER_POLICY]: { '02bb': 1 } } },
            'tx3#0': { value: { lovelace: 5, [VOTER_POLICY]: { '00259a20ff': 1 } } },
            'tx4#0': { value: { lovelace: 5, [BALLOT_POLICY]: { '01aa': 1 } } },
        });
        expect((await get('/health')).body.data.voters.registered).toBe(2);
    });

    it('reports voters.registered null, without a snapshot read, when the head is not Open', async () => {
        monitorStatus = 'CLOSED';
        const { data } = (await get('/health')).body;
        expect(data.voters.registered).toBeNull();
        expect(SNAPSHOT_GET).not.toHaveBeenCalled();
    });

    it('reports voters.registered null when the snapshot read fails', async () => {
        SNAPSHOT_GET.mockRejectedValue(new Error('boom'));
        const res = await get('/health');
        expect(res.status).toBe(200);
        expect(res.body.data.voters.registered).toBeNull();
    });

    it('reports queue counts from txQueue.status() with depth as in-flight entries', async () => {
        vi.spyOn(helpers.txQueue, 'status').mockReturnValue(
            { built: 1, submitted: 2, accepted: 3, confirmed: 4, applied: 50, failed: 6, total: 66 },
        );
        expect((await get('/health')).body.data.queue).toEqual({
            depth: 10, built: 1, submitted: 2, accepted: 3, confirmed: 4, failed: 6,
        });
    });

    it('follows SnapshotConfirmed messages for snapshotNumber', async () => {
        (helpers.queueWorker as any).onMessage({ tag: 'SnapshotConfirmed', snapshot: { snapshotNumber: 41, confirmed: [] } });
        expect((await get('/health')).body.data.snapshotNumber).toBe(41);
        (helpers.queueWorker as any).onMessage({ tag: 'SnapshotConfirmed', snapshot: { snapshotNumber: 42, confirmed: [] } });
        expect((await get('/health')).body.data.snapshotNumber).toBe(42);
    });
});

describe('GET /health probes', () => {
    it('reports ok for reachable dependencies, treating a TRP 404 as reachable', async () => {
        const { probes } = (await get('/health')).body.data;
        expect(probes.ipfs).toMatchObject({ state: 'ok' });
        expect(probes.trp).toMatchObject({ state: 'ok' });
        expect(probes.blockfrost).toMatchObject({ state: 'ok' });
        for (const p of Object.values(probes) as any[]) expect(Date.parse(p.checkedAt)).not.toBeNaN();
    });

    it('maps IPFS and Blockfrost failures to the closed reasons', async () => {
        ipfsFake.handler = answer(500);
        bfFake.handler = answer(401);
        const { probes } = (await get('/health')).body.data;
        expect(probes.ipfs).toMatchObject({ state: 'down', reason: 'provider_error' });
        expect(probes.blockfrost).toMatchObject({ state: 'down', reason: 'provider_auth_failed' });
    });

    it('maps TRP 401 to provider_auth_failed and 500 to provider_error', async () => {
        trpFake.handler = answer(401);
        expect((await get('/health')).body.data.probes.trp).toMatchObject({ state: 'down', reason: 'provider_auth_failed' });
        detail.__resetHealthDetailForTests();
        detail.__setBlockfrostBaseForTests(bfFake.url);
        trpFake.handler = answer(500);
        expect((await get('/health')).body.data.probes.trp).toMatchObject({ state: 'down', reason: 'provider_error' });
    });

    it('reports provider_unreachable when nothing answers', async () => {
        const dead = await fake(answer(200));
        const url = dead.url;
        dead.server.close();
        process.env.IPFS_API_URL = url;
        try {
            expect((await get('/health')).body.data.probes.ipfs).toMatchObject({ state: 'down', reason: 'provider_unreachable' });
        } finally {
            process.env.IPFS_API_URL = ipfsFake.url;
        }
    });

    it('reports a hung IPFS node as down/timeout and still answers 200 within about 3 seconds', async () => {
        ipfsFake.handler = hang;
        const started = Date.now();
        const res = await get('/health');
        const elapsed = Date.now() - started;
        expect(res.status).toBe(200);
        expect(res.body.data.probes.ipfs).toMatchObject({ state: 'down', reason: 'timeout' });
        expect(elapsed).toBeLessThan(4_500);
    }, 10_000);

    it('reports not_configured for an empty BLOCKFROST_API_KEY and makes no call', async () => {
        process.env.BLOCKFROST_API_KEY = '';
        const { probes } = (await get('/health')).body.data;
        expect(probes.blockfrost).toMatchObject({ state: 'not_configured', reason: 'not_configured' });
        expect(bfFake.hits).toBe(0);
    });

    it('sends the Blockfrost key only upstream and never returns keys, URLs or upstream text', async () => {
        bfFake.handler = answer(500);
        ipfsFake.handler = answer(500);
        trpFake.handler = answer(500);
        const res = await get('/health');
        for (const secret of [BLOCKFROST_KEY, TRP_SECRET, ipfsFake.url, trpFake.url, bfFake.url, 'SECRETTEXT', '127.0.0.1']) {
            expect(res.text).not.toContain(secret);
        }
    });

    it('follows no redirects', async () => {
        const target = await fake(answer(200));
        ipfsFake.handler = (_req, res) => { res.statusCode = 302; res.setHeader('location', target.url); res.end(); };
        try {
            expect((await get('/health')).body.data.probes.ipfs).toMatchObject({ state: 'down', reason: 'provider_error' });
            expect(target.hits).toBe(0);
        } finally {
            target.server.close();
        }
    });

    it('serves ten concurrent requests with one probe per dependency and one snapshot read', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => get('/health')));
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect([ipfsFake.hits, trpFake.hits, bfFake.hits]).toEqual([1, 1, 1]);
        expect(SNAPSHOT_GET).toHaveBeenCalledTimes(1);
        await get('/health');
        expect([ipfsFake.hits, trpFake.hits, bfFake.hits]).toEqual([1, 1, 1]);
        expect(SNAPSHOT_GET).toHaveBeenCalledTimes(1);
    });
});
