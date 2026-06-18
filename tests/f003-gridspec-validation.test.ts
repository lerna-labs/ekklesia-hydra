/**
 * Regression coverage for audit finding F-003: a malformed range/likert grid
 * spec reaching the tally.
 *
 * `/prepare` already validates grids (validateGrid in ballot.ts: integers,
 * step > 0, max >= min, (max - min) % step === 0). But a ballot is fetched from
 * IPFS at /start and trusted as-is, so a malformed grid can reach the tally's
 * `gridValues`. The danger is specifically `step <= 0`: the enumeration loop
 * `for (v = min; v <= max; v += step)` would never terminate → finalize hangs on
 * an unbounded array.
 *
 * (The vote-path `isOnGrid` is already fail-closed in JS — `x % 0` is `NaN` and
 * `NaN === 0` is false — so a malformed grid there rejects values rather than
 * panicking. The tally enumeration is the real exposure.)
 *
 * Fix: gridValues rejects a malformed grid loudly instead of looping forever.
 */

import { describe, it, expect } from 'vitest';
import { gridValues } from '../src/routes/settlement.js';

describe('F-003 — gridValues fail-closed on malformed grid', () => {
    describe('well-formed grids enumerate correctly', () => {
        it('default step = 1', () => {
            expect(gridValues({ min: 0, max: 4 })).toEqual([0, 1, 2, 3, 4]);
        });

        it('explicit step', () => {
            expect(gridValues({ min: 0, max: 100, step: 25 })).toEqual([0, 25, 50, 75, 100]);
        });

        it('negative min', () => {
            expect(gridValues({ min: -2, max: 2 })).toEqual([-2, -1, 0, 1, 2]);
        });

        it('single-point grid (min === max)', () => {
            expect(gridValues({ min: 3, max: 3, step: 1 })).toEqual([3]);
        });
    });

    describe('malformed grids throw (never hang)', () => {
        it('step = 0 (would loop forever)', () => {
            expect(() => gridValues({ min: 0, max: 10, step: 0 })).toThrow(/Invalid grid spec/);
        });

        it('negative step', () => {
            expect(() => gridValues({ min: 0, max: 10, step: -1 })).toThrow(/Invalid grid spec/);
        });

        it('max < min', () => {
            expect(() => gridValues({ min: 5, max: 2 })).toThrow(/Invalid grid spec/);
        });

        it('non-integer bound', () => {
            expect(() => gridValues({ min: 0.5, max: 4 })).toThrow(/Invalid grid spec/);
        });

        it('non-integer step', () => {
            expect(() => gridValues({ min: 0, max: 4, step: 1.5 })).toThrow(/Invalid grid spec/);
        });

        it('(max - min) not divisible by step', () => {
            expect(() => gridValues({ min: 0, max: 10, step: 3 })).toThrow(/Invalid grid spec/);
        });

        it('NaN / Infinity bounds', () => {
            expect(() => gridValues({ min: 0, max: Infinity })).toThrow(/Invalid grid spec/);
            expect(() => gridValues({ min: NaN, max: 4 })).toThrow(/Invalid grid spec/);
        });
    });
});
