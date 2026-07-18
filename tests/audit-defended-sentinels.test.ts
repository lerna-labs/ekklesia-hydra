/**
 * Regression sentinels for the audit items the auditor re-classified as
 * **not a bug** — defended by design. They are not fixes; each test pins the
 * defended behavior so a future refactor that silently removes it fails here and
 * forces the author to re-confirm the intent.
 *
 *   - Vuln 11 — weighted votes reject a negative weight (voting.ts).
 *   - Vuln 12 — weighted `voterCount` counts only non-zero allocations (settlement.ts).
 *   - Vuln 15 — NativeScript satisfaction is monotonic: over-signing (providing
 *     more keys than required) still satisfies the script (voting.ts). Intended
 *     per Lean S3.
 *   - F-009  — GET /results returns 404 when no finalize result exists yet
 *     (settlement.ts). Sentinel P67.
 *
 * These are source-level structural guards (the existing pattern in
 * security-responder-role.test.ts), chosen so the sentinels require no change to
 * production code — the functions involved are correct as-is and internal.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const VOTING = stripComments(readFileSync(resolve(here, '../src/routes/voting.ts'), 'utf-8'));
const SETTLEMENT = stripComments(readFileSync(resolve(here, '../src/routes/settlement.ts'), 'utf-8'));

describe('Audit defended-by-design sentinels (not-a-bug regression guards)', () => {
    describe('Vuln 11 — weighted votes reject a negative weight', () => {
        it('validateSelections rejects e.value < 0 for weighted', () => {
            expect(VOTING).toMatch(/!Number\.isInteger\(e\.value\)\s*\|\|\s*e\.value\s*<\s*0/);
        });
    });

    describe('Vuln 12 — weighted voterCount counts only non-zero allocations', () => {
        it('tallyWeighted uses values.filter((v) => v > 0) for voterCount', () => {
            expect(SETTLEMENT).toMatch(/voterCount:\s*values\.filter\(\(v\)\s*=>\s*v\s*>\s*0\)\.length/);
        });
    });

    describe('Vuln 15 — NativeScript satisfaction is monotonic (over-signing is fine)', () => {
        // every/some/(>= required) are all monotone in the provided key set:
        // adding keys can only keep a clause satisfied or flip it false→true,
        // never true→false. So there is intentionally no "too many signatures"
        // upper bound.
        it('atLeast uses `>= script.required` (not an exact / upper-bound match)', () => {
            expect(VOTING).toMatch(/\.length\s*>=\s*script\.required/);
            expect(VOTING).not.toMatch(/\.length\s*===\s*script\.required/);
        });
        it('all/any use every/some over the sub-scripts', () => {
            expect(VOTING).toMatch(/script\.scripts\.every\(\(s\)\s*=>\s*satisfiesScript/);
            expect(VOTING).toMatch(/script\.scripts\.some\(\(s\)\s*=>\s*satisfiesScript/);
        });
    });

    describe('F-009 — GET /results returns 404 when no result exists yet', () => {
        it('the /results handler maps a missing result file (ENOENT) to a 404', () => {
            const handler = SETTLEMENT.slice(SETTLEMENT.indexOf("router.get('/results'"));
            expect(handler).toMatch(/code\s*===\s*'ENOENT'/);
            expect(handler).toMatch(/'NOT_FOUND'[^;]*404/);
        });
    });
});
