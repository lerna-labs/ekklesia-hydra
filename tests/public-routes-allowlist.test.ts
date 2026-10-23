/**
 * The route table of createApp(): only the routes listed in KEYLESS are
 * mounted ahead of the x-api-key check, and every other route answers 401
 * without the key. Importing and listening on the app starts nothing else.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const KEYLESS = ['GET /version'];
const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'] as const;

interface RouteEntry {
    method: string;
    path: string;
    keyless: boolean;
}

let scratch: string;
let savedStagingDir: string | undefined;
let server: Server;
let port: number;
let app: any;
let authHeaderMiddleware: unknown;
let listenersBefore: Record<string, number>;
let startSpies: Array<ReturnType<typeof vi.spyOn>>;

function routeTable(): RouteEntry[] {
    const stack: any[] = app._router.stack;
    const authIndex = stack.findIndex((layer) => layer.handle === authHeaderMiddleware);
    expect(authIndex).toBeGreaterThan(-1);

    const entries: RouteEntry[] = [];
    stack.forEach((layer, index) => {
        const routes = layer.route
            ? [layer.route]
            : (layer.handle?.stack ?? []).filter((inner: any) => inner.route).map((inner: any) => inner.route);
        for (const route of routes) {
            for (const method of Object.keys(route.methods)) {
                const name = method === '_all' ? 'ALL' : method.toUpperCase();
                entries.push({ method: name, path: route.path, keyless: index < authIndex });
            }
        }
    });
    return entries;
}

function send(method: string, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
    });
}

beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'hydra-allowlist-'));
    savedStagingDir = process.env.IPFS_STAGING_DIR;
    process.env.IPFS_STAGING_DIR = join(scratch, 'staging');

    listenersBefore = Object.fromEntries(PROCESS_EVENTS.map((event) => [event, process.listenerCount(event)]));

    const helpers = await import('../src/helpers.js');
    startSpies = [
        vi.spyOn(helpers.hydraMonitor, 'start'),
        vi.spyOn(helpers.queueWorker, 'start'),
        vi.spyOn(helpers.txQueue, 'init'),
        vi.spyOn(helpers.voteCache, 'rehydrate'),
    ];

    ({ authHeaderMiddleware } = await import('../src/middleware.js'));
    const { createApp } = await import('../src/app.js');
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((res) => server.once('listening', () => res()));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((res) => server.close(() => res()));
    await rm(scratch, { recursive: true, force: true });
    if (savedStagingDir === undefined) delete process.env.IPFS_STAGING_DIR;
    else process.env.IPFS_STAGING_DIR = savedStagingDir;
});

describe('createApp() route table', () => {
    it('mounts exactly the listed routes ahead of the x-api-key check', () => {
        // An ALL handler on a public path only hands other methods on to the
        // key check; the method test below holds it to that.
        const keyless = routeTable()
            .filter((r) => r.keyless && r.method !== 'ALL')
            .map((r) => `${r.method} ${r.path}`);
        expect(keyless.sort()).toEqual([...KEYLESS].sort());
    });

    it('mounts nothing ahead of the key check that could answer on its own', () => {
        const stack: any[] = app._router.stack;
        const authIndex = stack.findIndex((layer) => layer.handle === authHeaderMiddleware);
        const ahead = stack.slice(0, authIndex);
        expect(ahead.map((layer) => layer.name)).toEqual(['query', 'expressInit', 'jsonParser', 'router']);
        // The public router holds routes only, no router-level middleware.
        expect(ahead[3].handle.stack.every((inner: any) => inner.route)).toBe(true);
    });

    it('answers 401 without x-api-key on every other route', async () => {
        const keyed = routeTable().filter((r) => !r.keyless);
        expect(keyed.length).toBeGreaterThan(30);
        for (const { method, path } of keyed) {
            const status = await send(method === 'ALL' ? 'GET' : method, path.replace(/:\w+/g, 'drep1test'));
            expect(status, `${method} ${path}`).toBe(401);
        }
        expect(await send('GET', '/no-such-route')).toBe(401);
    });

    it('serves the listed routes without x-api-key', async () => {
        for (const entry of KEYLESS) {
            const [method, path] = entry.split(' ');
            expect(await send(method, path), entry).toBe(200);
        }
    });

    it('answers 401 without x-api-key for every other method on a keyless path', async () => {
        const paths = new Set(routeTable().filter((r) => r.keyless).map((r) => r.path));
        for (const path of paths) {
            const served = KEYLESS.filter((e) => e.endsWith(` ${path}`)).map((e) => e.split(' ')[0]);
            if (served.includes('GET')) served.push('HEAD');
            for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
                if (served.includes(method)) continue;
                expect(await send(method, path), `${method} ${path}`).toBe(401);
            }
        }
    });
});

describe('createApp() side effects', () => {
    it('starts no monitor, queue or cache, and registers no process handlers', () => {
        for (const spy of startSpies) expect(spy).not.toHaveBeenCalled();
        for (const event of PROCESS_EVENTS) expect(process.listenerCount(event), event).toBe(listenersBefore[event]);
    });
});
