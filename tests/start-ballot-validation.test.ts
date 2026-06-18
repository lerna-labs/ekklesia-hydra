/**
 * Coverage for the /start (and rehydrate) ballot-validation enhancement.
 *
 * The ballot is fetched from IPFS at POST /start and on session rehydrate and was
 * previously cached and used with no validation — only POST /prepare validated.
 * A malformed ballot (e.g. a range grid with step=0, which would hang the tally —
 * see F-003) could therefore be cached and reach voting/tally.
 *
 * `validateBallotDefinition` is now a shared module (`src/ballot-validation.ts`),
 * imported by both ballot.ts (/prepare) and lifecycle.ts (/start + rehydrate), so
 * the same gate runs everywhere. These tests cover the validator behaviorally
 * (now that it is a pure, importable module) and structurally guard that
 * lifecycle.ts validates before caching.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { validateBallotDefinition } from '../src/ballot-validation.js';
import type { BallotDefinition } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal valid ballot; the validator only inspects questions/roleWeighting/acceptedCredentials. */
function validBallot(overrides: Record<string, unknown> = {}): BallotDefinition {
    return {
        questions: [
            { questionId: 'q1', method: 'single-choice', options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }] },
        ],
        roleWeighting: { drep: 'CredentialBased' },
        ekklesia: { acceptedCredentials: ['drep', 'pool', 'stake'] },
        ...overrides,
    } as unknown as BallotDefinition;
}

describe('/start ballot validation', () => {
    describe('validateBallotDefinition accepts a well-formed ballot', () => {
        it('returns null for a valid ballot', () => {
            expect(validateBallotDefinition(validBallot())).toBeNull();
        });
    });

    describe('rejects malformed ballots (these would otherwise be cached at /start)', () => {
        it('empty questions', () => {
            expect(validateBallotDefinition(validBallot({ questions: [] }))).toMatch(/at least one question/);
        });

        it('duplicate questionId', () => {
            const q = { method: 'single-choice', options: [{ label: 'A', value: 0 }] };
            expect(validateBallotDefinition(validBallot({ questions: [{ questionId: 'dup', ...q }, { questionId: 'dup', ...q }] }))).toMatch(/Duplicate questionId/);
        });

        it('unrecognized role in roleWeighting', () => {
            expect(validateBallotDefinition(validBallot({ roleWeighting: { cc: 'CredentialBased' } }))).toMatch(/unrecognized role/);
        });

        it('nonsensical (role, mode) pair', () => {
            expect(validateBallotDefinition(validBallot({ roleWeighting: { stake: 'PledgeBased' } }))).toMatch(/invalid mode/);
        });

        it('unrecognized acceptedCredentials HRP', () => {
            expect(validateBallotDefinition(validBallot({ ekklesia: { acceptedCredentials: ['addr'] } }))).toMatch(/unrecognized HRP/);
        });

        it('range question with a step=0 grid (the F-003 tally-hang shape)', () => {
            const ballot = validBallot({ questions: [{ questionId: 'r', method: 'range', valueRange: { min: 0, max: 10, step: 0 } }] });
            expect(validateBallotDefinition(ballot)).toMatch(/step must be a positive integer/);
        });

        it('ranked question missing rankCount', () => {
            const ballot = validBallot({ questions: [{ questionId: 'rk', method: 'ranked', options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }] }] });
            expect(validateBallotDefinition(ballot)).toMatch(/rankCount is required/);
        });

        it('legacy abstainAllowed field', () => {
            const ballot = validBallot({ questions: [{ questionId: 'q1', method: 'single-choice', options: [{ label: 'A', value: 0 }], abstainAllowed: false }] });
            expect(validateBallotDefinition(ballot)).toMatch(/legacy field "abstainAllowed"/);
        });
    });

    describe('structural guard — lifecycle.ts validates before opening / caching', () => {
        const src = readFileSync(resolve(here, '../src/routes/lifecycle.ts'), 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        const startHandler = src.slice(src.indexOf("router.post('/start'"));

        it('validates the ballot at both entry points (/start + rehydrate)', () => {
            const matches = src.match(/validateBallotDefinition\(/g) ?? [];
            expect(matches.length).toBeGreaterThanOrEqual(2);
        });

        it('/start validates the ballot BEFORE opening the head (no head opened for an invalid ballot)', () => {
            const vIdx = startHandler.indexOf('validateBallotDefinition');
            const openIdx = startHandler.indexOf('waitForHeadOpen');
            expect(vIdx).toBeGreaterThan(-1);
            expect(openIdx).toBeGreaterThan(-1);
            expect(vIdx).toBeLessThan(openIdx);
        });

        it('/start hard-fails (returns an error, does not open) on an invalid ballot', () => {
            expect(startHandler).toMatch(/is invalid:/);
            expect(startHandler).toMatch(/Refusing to \/start/);
            expect(startHandler).toMatch(/return error\(res, 'INVALID_INPUT'/);
        });

        it('only caches the validated ballot, never the raw fetch result', () => {
            expect(src).toMatch(/cachedBallot = fetchedBallot/);
            expect(src).toMatch(/cachedBallot = fetched\b/);
            expect(src).not.toMatch(/cachedBallot = await ipfs\.fetchJson/);
        });
    });
});
