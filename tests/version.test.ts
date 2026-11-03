/**
 * GET /version: the build document served without x-api-key, ahead of the
 * key check, and the build resolution behind it (src/build-info.ts).
 */

import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import { build } from 'esbuild';
import type { Express } from 'express';

const execFileAsync = promisify(execFile);

const BUILD_ENV = ['GIT_SHA', 'BUILD_TIME', 'APP_VERSION'] as const;
const API_KEY = 'version-test-key';

let packageVersion: string;
let validateVersion: (data: unknown) => boolean;
let resolveBuildInfo: typeof import('../src/build-info.js').resolveBuildInfo;
let createApp: () => Express;

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
function send(path: string, method = 'GET', headers: Record<string, string> = {}, toPort = port): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: toPort, path, method, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function listen(app: Express): Promise<Server> {
    const s = app.listen(0, '127.0.0.1');
    await new Promise<void>((res) => s.once('listening', () => res()));
    return s;
}

const portOf = (s: Server) => (s.address() as AddressInfo).port;
const close = (s: Server) => new Promise<void>((res) => s.close(() => res()));

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

    ({ resolveBuildInfo } = await import('../src/build-info.js'));
    ({ createApp } = await import('../src/app.js'));
    server = await listen(createApp());
    port = portOf(server);
});

afterAll(async () => {
    await close(server);
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

    it('answers HEAD /version without x-api-key', async () => {
        expect((await send('/version', 'HEAD')).status).toBe(200);
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

    it.each(['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])('does not serve %s /version without x-api-key', async (method) => {
        const res = await send('/version', method);
        expect(res.status).toBe(401);
        expect(res.headers.allow).toBeUndefined();
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
        await rm(file, { recursive: true, force: true });
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

    it('reads a build-info.json that starts with a byte order mark', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await writeFile(file, '\uFEFF' + JSON.stringify({ gitSha: 'abc1234' }));
        expect(resolveBuildInfo(file, {}).gitSha).toBe('abc1234');
        expect(warn).not.toHaveBeenCalled();
    });

    it('uses the environment only when no file exists', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveBuildInfo(file, { GIT_SHA: 'abc1234', BUILD_TIME: '2026-01-01T00:00:00Z' })).toEqual({
            version: packageVersion,
            gitSha: 'abc1234',
            buildTime: '2026-01-01T00:00:00Z',
        });
        expect(warn).not.toHaveBeenCalled();
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

    it.each([
        ['empty', ''],
        ['truncated', '{ "gitSha": "abc1'],
        ['null', 'null'],
        ['an array', '[]'],
        ['a string', '"abc1234"'],
        ['a number', '42'],
    ])('reports nulls, not the environment, for a build-info.json that is %s', async (_label, content) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await writeFile(file, content);
        const env = { GIT_SHA: 'deadbee', BUILD_TIME: '2026-01-01T00:00:00Z', APP_VERSION: '9.9.9' };

        expect(resolveBuildInfo(file, env)).toEqual({ version: packageVersion, gitSha: null, buildTime: null });
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain('build-info.json');
        for (const value of ['abc1', 'deadbee', '2026', '9.9.9']) expect(line).not.toContain(value);
    });

    it('reports nulls, not the environment, for a build-info.json that cannot be read', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mkdir(file);
        expect(resolveBuildInfo(file, { GIT_SHA: 'deadbee' })).toEqual({ version: packageVersion, gitSha: null, buildTime: null });
        expect(warn).toHaveBeenCalledTimes(1);
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

    it.each(['2026-10-01T12:00:00Z', '2026-10-01T12:00:00.5Z', '2026-10-01T12:00:00.123Z', '2028-02-29T23:59:59Z'])(
        'keeps the build time %j',
        (value) => {
            expect(resolveBuildInfo(file, { BUILD_TIME: value }).buildTime).toBe(value);
        },
    );

    it.each([
        'yesterday',
        '2026-10-01',
        '2026-10-01 12:00:00Z',
        '2026-10-01T12:00:00+02:00',
        '2026-13-01T00:00:00Z',
        '2026-02-30T00:00:00Z',
        '2027-02-29T00:00:00Z',
        '2026-10-01T24:00:00Z',
        '2026-10-01T12:00:60Z',
        '2026-10-01T12:00:00.1234Z',
    ])('reports a null build time for %j', (value) => {
        expect(resolveBuildInfo(file, { BUILD_TIME: value }).buildTime).toBeNull();
    });

    it('reports a null build time for an unbounded fraction', () => {
        expect(resolveBuildInfo(file, { BUILD_TIME: `2026-10-01T12:00:00.${'1'.repeat(10_000)}Z` }).buildTime).toBeNull();
    });

    it.each(['1.2.0', '0.0.1', '1.2.0-rc-20261023120000', '1.2.3-alpha.1+build.5'])(
        'replaces the package.json version with %j',
        (value) => {
            expect(resolveBuildInfo(file, { APP_VERSION: value }).version).toBe(value);
        },
    );

    it('replaces the package.json version with a version from the file', async () => {
        await writeFile(file, JSON.stringify({ version: '1.3.0' }));
        expect(resolveBuildInfo(file, {}).version).toBe('1.3.0');
    });

    it.each([
        '<b>x</b>',
        '1.0',
        'v1.0.0',
        '01.002.0003',
        '1.0.0-..',
        '1.0.0-01',
    ])('keeps the package.json version for %j', (value) => {
        expect(resolveBuildInfo(file, { APP_VERSION: value }).version).toBe(packageVersion);
    });

    it('keeps the package.json version for a version longer than 64 characters', () => {
        const long = `1.0.0-${'a'.repeat(59)}`;
        expect(long).toHaveLength(65);
        expect(resolveBuildInfo(file, { APP_VERSION: long }).version).toBe(packageVersion);
        expect(resolveBuildInfo(file, { APP_VERSION: `1.0.0+${'a'.repeat(1_000_000)}` }).version).toBe(packageVersion);
    });

    it('returns only the three build keys from a file carrying others', async () => {
        await writeFile(file, JSON.stringify({ gitSha: 'abc1234', token: 'secret-value', runtime: 'v22' }));
        expect(Object.keys(resolveBuildInfo(file, {})).sort()).toEqual(['buildTime', 'gitSha', 'version']);
    });
});

describe('build resolution in the bundled service', () => {
    // The image layout: dist/index.js bundled from src, package.json one level up.
    let root: string;
    let elsewhere: string;
    const bundleFile = () => join(root, 'dist', 'build-info.json');

    // Reads the build, deletes the bundle's build-info.json, and reads it again.
    const PROBE = [
        "const { getBuildInfo } = await import(process.argv[1]);",
        "const { rmSync } = await import('node:fs');",
        'const first = getBuildInfo();',
        'rmSync(process.argv[2], { force: true });',
        'console.log(JSON.stringify({ first, second: getBuildInfo() }));',
    ].join('\n');

    async function probe(env: Record<string, string>) {
        const { stdout } = await execFileAsync(
            process.execPath,
            ['--input-type=module', '-e', PROBE, pathToFileURL(join(root, 'dist', 'index.js')).href, bundleFile()],
            { cwd: elsewhere, env: { PATH: process.env.PATH ?? '', ...env } },
        );
        return JSON.parse(stdout);
    }

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'hydra-bundle-'));
        await build({
            entryPoints: [fileURLToPath(new URL('../src/build-info.ts', import.meta.url))],
            bundle: true,
            platform: 'node',
            format: 'esm',
            packages: 'external',
            logLevel: 'silent',
            outfile: join(root, 'dist', 'index.js'),
        });
        await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '7.7.7' }));

        // A working directory carrying decoy build files where a cwd-relative lookup would find them.
        elsewhere = await mkdtemp(join(tmpdir(), 'hydra-cwd-'));
        const decoy = JSON.stringify({ gitSha: 'fffffff', buildTime: '2020-01-01T00:00:00Z', version: '0.0.9' });
        for (const sub of ['', 'src', 'dist']) {
            await mkdir(join(elsewhere, sub), { recursive: true });
            await writeFile(join(elsewhere, sub, 'build-info.json'), decoy);
        }
        await writeFile(join(elsewhere, 'package.json'), JSON.stringify({ version: '0.0.9' }));
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(elsewhere, { recursive: true, force: true });
    });

    it('reads build-info.json beside the bundle from another working directory, once', async () => {
        await writeFile(bundleFile(), JSON.stringify({ gitSha: 'abc1234', buildTime: '2026-10-23T12:00:00Z' }));
        const { first, second } = await probe({ GIT_SHA: 'deadbee' });
        expect(first).toEqual({ version: '7.7.7', gitSha: 'abc1234', buildTime: '2026-10-23T12:00:00Z' });
        expect(second).toEqual(first);
    });

    it('uses the environment, not the working directory, when the bundle carries no file', async () => {
        await rm(bundleFile(), { force: true });
        const { first } = await probe({ GIT_SHA: 'deadbee' });
        expect(first).toEqual({ version: '7.7.7', gitSha: 'deadbee', buildTime: null });
    });
});

// Runs last: it exhausts this server's public limiter.
describe('createPublicProbeLimiter', () => {
    it('limits GET /version on its own bucket, leaving GET /audit/full untouched', async () => {
        let last: RawResponse | undefined;
        for (let i = 0; i < 121; i++) last = await send('/version');
        expect(last!.status).toBe(429);

        const audit = await send('/audit/full', 'GET', { 'x-api-key': API_KEY });
        expect(audit.status).toBe(200);
        expect(audit.headers['ratelimit-limit']).toBe('60');
        expect(audit.headers['ratelimit-remaining']).toBe('59');
    });

    it('gives each app its own bucket', async () => {
        expect((await send('/version')).status).toBe(429);
        const other = await listen(createApp());
        try {
            expect((await send('/version', 'GET', {}, portOf(other))).status).toBe(200);
        } finally {
            await close(other);
        }
    });
});
