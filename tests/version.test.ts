/**
 * GET /version: the build document served without x-api-key, ahead of the
 * key check, and the build resolution behind it (src/build-info.ts).
 */

import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';

const BUILD_ENV = ['GIT_SHA', 'BUILD_TIME', 'APP_VERSION'] as const;
const API_KEY = 'version-test-key';

let packageVersion: string;
let validateVersion: (data: unknown) => boolean;
let resolveBuildInfo: typeof import('../src/build-info.js').resolveBuildInfo;
let BUILD_INFO_PATH: string;

let scratch: string;
let server: Server;
let port: number;
const savedEnv: Record<string, string | undefined> = {};

interface RawResponse {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

/** node:http sends the path as written; fetch would normalise `..` and case first. */
function send(path: string, method = 'GET', headers: Record<string, string> = {}): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

beforeAll(async () => {
    for (const name of [...BUILD_ENV, 'X_API_KEY', 'IPFS_STAGING_DIR']) savedEnv[name] = process.env[name];
    for (const name of BUILD_ENV) delete process.env[name];
    process.env.X_API_KEY = API_KEY;

    // IPFS_STAGING_DIR is read once at module load, so set it before importing the app.
    scratch = await mkdtemp(join(tmpdir(), 'hydra-version-'));
    process.env.IPFS_STAGING_DIR = join(scratch, 'staging');

    packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    const schema = JSON.parse(await readFile(new URL('./schemas/version.schema.json', import.meta.url), 'utf8'));
    validateVersion = new Ajv().compile(schema);

    ({ resolveBuildInfo, BUILD_INFO_PATH } = await import('../src/build-info.js'));
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((res) => server.once('listening', () => res()));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await rm(scratch, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('GET /version', () => {
    it('answers 200 without x-api-key with exactly the four keys', async () => {
        const res = await send('/version');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        const body = JSON.parse(res.body);
        expect(Object.keys(body).sort()).toEqual(['buildTime', 'gitSha', 'name', 'version']);
        expect(body).toEqual({ name: 'ekklesia-hydra', version: packageVersion, gitSha: null, buildTime: null });
        expect(validateVersion(body)).toBe(true);
    });

    it('sets Cache-Control: public, max-age=60', async () => {
        const res = await send('/version');
        expect(res.headers['cache-control']).toBe('public, max-age=60');
    });

    it.each([
        '/Version',
        '/VERSION',
        '/version/',
        '//version',
        '/version/anything',
        '/version/../ledger',
        '/Version/../ledger',
        '/version%2f..%2fledger',
        '/version%2F..%2Fledger',
        '/%76ersion',
        '/version;/../ledger',
    ])('does not serve %s without x-api-key', async (path) => {
        const res = await send(path);
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body)).toMatchObject({ status: 'ERROR', code: 'UNAUTHORIZED' });
    });

    it.each(['POST', 'PUT', 'DELETE'])('does not serve %s /version without x-api-key', async (method) => {
        const res = await send('/version', method);
        expect(res.status).toBe(401);
    });

    it.each([
        ['GET', '/'],
        ['GET', '/health'],
        ['GET', '/audit/full'],
        ['GET', '/results'],
        ['POST', '/ledger'],
        ['OPTIONS', '/health'],
    ])('still requires x-api-key on %s %s', async (method, path) => {
        const res = await send(path, method);
        expect(res.status).toBe(401);
    });
});

describe('build resolution', () => {
    let dir: string;
    let file: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'hydra-build-info-'));
        file = join(dir, 'build-info.json');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(file, { force: true });
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('reads build-info.json first', async () => {
        await writeFile(file, JSON.stringify({ gitSha: 'abc1234', buildTime: '2026-10-01T12:00:00Z' }));
        expect(resolveBuildInfo(file, {})).toEqual({
            version: packageVersion,
            gitSha: 'abc1234',
            buildTime: '2026-10-01T12:00:00Z',
        });
    });

    it('uses the environment only when no file exists', () => {
        expect(resolveBuildInfo(file, { GIT_SHA: 'abc1234', BUILD_TIME: '2026-01-01T00:00:00Z' })).toEqual({
            version: packageVersion,
            gitSha: 'abc1234',
            buildTime: '2026-01-01T00:00:00Z',
        });
    });

    it('reports null for both with neither source', () => {
        expect(resolveBuildInfo(file, {})).toEqual({ version: packageVersion, gitSha: null, buildTime: null });
    });

    it('keeps the file values when the environment differs, and logs only the source names', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await writeFile(file, JSON.stringify({ gitSha: 'abc1234', buildTime: '2026-10-01T12:00:00Z', version: '1.2.0' }));
        const env = { GIT_SHA: 'deadbee', BUILD_TIME: '2026-01-01T00:00:00Z', APP_VERSION: '9.9.9' };

        expect(resolveBuildInfo(file, env)).toEqual({
            version: '1.2.0',
            gitSha: 'abc1234',
            buildTime: '2026-10-01T12:00:00Z',
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain('build-info.json');
        for (const value of ['abc1234', 'deadbee', '2026', '1.2.0', '9.9.9']) expect(line).not.toContain(value);
    });

    it('logs nothing when the environment names the same build', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await writeFile(file, JSON.stringify({ gitSha: 'abc1234' }));
        resolveBuildInfo(file, { GIT_SHA: 'abc1234' + 'f'.repeat(33) });
        expect(warn).not.toHaveBeenCalled();
    });

    it('falls through to the environment when build-info.json is malformed', async () => {
        await writeFile(file, '{ not json');
        expect(resolveBuildInfo(file, { GIT_SHA: 'abc1234' }).gitSha).toBe('abc1234');
        await writeFile(file, '"abc1234"');
        expect(resolveBuildInfo(file, { GIT_SHA: 'def5678' }).gitSha).toBe('def5678');
    });

    it('shortens a full sha to its first seven characters', () => {
        const sha = '0123456789abcdef0123456789abcdef01234567';
        expect(resolveBuildInfo(file, { GIT_SHA: sha }).gitSha).toBe('0123456');
    });

    it.each([
        'abc123',
        'ABC1234',
        'g123456',
        '0123456789abcdef0123456789abcdef012345678',
        'abc1234 ',
        '<script>alert(1)</script>',
        '/etc/passwd',
        'release candidate',
    ])('reports a null sha for %j', (value) => {
        expect(resolveBuildInfo(file, { GIT_SHA: value }).gitSha).toBeNull();
    });

    it.each(['yesterday', '2026-10-01', '2026-10-01 12:00:00Z', '2026-10-01T12:00:00+02:00', '2026-13-01T00:00:00Z'])(
        'reports a null build time for %j',
        (value) => {
            expect(resolveBuildInfo(file, { BUILD_TIME: value }).buildTime).toBeNull();
        },
    );

    it('replaces the package.json version with a version from either source', async () => {
        expect(resolveBuildInfo(file, { APP_VERSION: '1.2.0-rc-20261023120000' }).version).toBe('1.2.0-rc-20261023120000');
        await writeFile(file, JSON.stringify({ version: '1.3.0' }));
        expect(resolveBuildInfo(file, {}).version).toBe('1.3.0');
    });

    it('ignores a version that is not a semantic version', () => {
        expect(resolveBuildInfo(file, { APP_VERSION: '<b>x</b>' }).version).toBe(packageVersion);
    });

    it('returns only the three build keys from a file carrying others', async () => {
        await writeFile(file, JSON.stringify({ gitSha: 'abc1234', token: 'secret-value', runtime: 'v22' }));
        expect(Object.keys(resolveBuildInfo(file, {})).sort()).toEqual(['buildTime', 'gitSha', 'version']);
    });

    it('locates build-info.json beside the module, not in the working directory', () => {
        const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
        expect(BUILD_INFO_PATH).toBe(join(srcDir, 'build-info.json'));
    });
});

// Runs last: it exhausts the public limiter for this process.
describe('publicProbeLimiter', () => {
    it('limits GET /version on its own bucket, leaving GET /audit/full untouched', async () => {
        let last: RawResponse | undefined;
        for (let i = 0; i < 121; i++) last = await send('/version');
        expect(last!.status).toBe(429);

        const audit = await send('/audit/full', 'GET', { 'x-api-key': API_KEY });
        expect(audit.status).toBe(200);
        expect(audit.headers['ratelimit-limit']).toBe('60');
        expect(audit.headers['ratelimit-remaining']).toBe('59');
    });
});
