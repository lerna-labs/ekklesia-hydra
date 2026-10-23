import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
    version: string;
    gitSha: string | null;
    buildTime: string | null;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * `build-info.json` beside the running module (`dist/index.js` once bundled),
 * located from the module's own URL so the working directory never matters.
 */
export const BUILD_INFO_PATH = join(MODULE_DIR, 'build-info.json');
const PACKAGE_JSON_PATH = join(MODULE_DIR, '..', 'package.json');

const SHA_RE = /^[0-9a-f]{7,40}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJsonObject(file: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normaliseSha(value: unknown): string | null {
    return typeof value === 'string' && SHA_RE.test(value) ? value.slice(0, 7) : null;
}

function normaliseBuildTime(value: unknown): string | null {
    return typeof value === 'string' && ISO_UTC_RE.test(value) && !Number.isNaN(Date.parse(value))
        ? value
        : null;
}

function normaliseVersion(value: unknown): string | null {
    return typeof value === 'string' && SEMVER_RE.test(value) ? value : null;
}

function packageVersion(): string {
    const version = readJsonObject(PACKAGE_JSON_PATH)?.version;
    return typeof version === 'string' ? version : '0.0.0';
}

/**
 * Resolve the build: the artifact's own `build-info.json` first; the
 * `GIT_SHA`, `BUILD_TIME` and `APP_VERSION` environment variables only when
 * no readable file exists; otherwise null. A `version` from either source
 * replaces the `package.json` version.
 */
export function resolveBuildInfo(file: string = BUILD_INFO_PATH, env: NodeJS.ProcessEnv = process.env): BuildInfo {
    const fromEnv = { gitSha: env.GIT_SHA, buildTime: env.BUILD_TIME, version: env.APP_VERSION };
    const fromFile = readJsonObject(file);
    const source = fromFile ?? fromEnv;

    const sha = normaliseSha(source.gitSha);
    const buildTime = normaliseBuildTime(source.buildTime);
    const version = normaliseVersion(source.version);

    if (fromFile && Object.values(fromEnv).some((v) => v)) {
        const differs = sha !== normaliseSha(fromEnv.gitSha)
            || buildTime !== normaliseBuildTime(fromEnv.buildTime)
            || version !== normaliseVersion(fromEnv.version);
        if (differs) console.warn('Build info: build-info.json and environment differ; using build-info.json');
    }

    return { version: version ?? packageVersion(), gitSha: sha, buildTime };
}

let cached: BuildInfo | null = null;

/** The build of the running process, resolved once. */
export function getBuildInfo(): BuildInfo {
    cached ??= resolveBuildInfo();
    return cached;
}
