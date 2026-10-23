import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
    version: string;
    gitSha: string | null;
    buildTime: string | null;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// `build-info.json` beside the running module (`dist/index.js` once bundled),
// located from the module's own URL so the working directory never matters.
const BUILD_INFO_PATH = join(MODULE_DIR, 'build-info.json');
const PACKAGE_JSON_PATH = join(MODULE_DIR, '..', 'package.json');

const SHA_RE = /^[0-9a-f]{7,40}$/;
const BUILD_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SEMVER_MAX_LENGTH = 64;
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The file's object, or whether the file is absent or present but unusable. */
function readBuildFile(file: string): Record<string, unknown> | 'absent' | 'unreadable' {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch (err: any) {
        return err?.code === 'ENOENT' ? 'absent' : 'unreadable';
    }
    try {
        const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : 'unreadable';
    } catch {
        return 'unreadable';
    }
}

function normaliseSha(value: unknown): string | null {
    return typeof value === 'string' && SHA_RE.test(value) ? value.slice(0, 7) : null;
}

function normaliseBuildTime(value: unknown): string | null {
    if (typeof value !== 'string' || !BUILD_TIME_RE.test(value)) return null;
    const time = Date.parse(value);
    // Date rolls instants that do not exist (02-30, 24:00) over to real ones.
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}

function normaliseVersion(value: unknown): string | null {
    return typeof value === 'string' && value.length <= SEMVER_MAX_LENGTH && SEMVER_RE.test(value) ? value : null;
}

function packageVersion(): string {
    try {
        const { version } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
        return typeof version === 'string' ? version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Resolve the build: the artifact's own `build-info.json` first; the
 * `GIT_SHA`, `BUILD_TIME` and `APP_VERSION` environment variables only when
 * no such file exists; otherwise null. A `version` from either source
 * replaces the `package.json` version. A file that exists but cannot be read
 * as a JSON object yields null, never the environment.
 */
export function resolveBuildInfo(file: string = BUILD_INFO_PATH, env: NodeJS.ProcessEnv = process.env): BuildInfo {
    const fromEnv = { gitSha: env.GIT_SHA, buildTime: env.BUILD_TIME, version: env.APP_VERSION };
    const fromFile = readBuildFile(file);

    if (fromFile === 'unreadable') {
        console.warn('Build info: build-info.json is present but unreadable; ignoring it and the environment');
        return { version: packageVersion(), gitSha: null, buildTime: null };
    }

    const source = fromFile === 'absent' ? fromEnv : fromFile;
    const sha = normaliseSha(source.gitSha);
    const buildTime = normaliseBuildTime(source.buildTime);
    const version = normaliseVersion(source.version);

    if (fromFile !== 'absent' && Object.values(fromEnv).some((v) => v)) {
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
