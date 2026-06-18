/**
 * Regression coverage for audit finding F-005: the ranked pairwise tally did not
 * de-duplicate the ranking array before building the preference matrix.
 *
 * `/vote` rejects duplicate rankings at the API boundary, but evidence pinned
 * out-of-band to IPFS can reach the tally directly. With a duplicate ranking like
 * `[0, 1, 0]`, the pairwise loop eventually compares the two `0` entries and
 * writes `matrix[indexOf(0)][indexOf(0)] += 1` — a diagonal cell, i.e. an option
 * preferring itself, which is nonsense and corrupts everything derived from the
 * matrix (Borda, Condorcet, Copeland, …).
 *
 * Fix: dedupe the ranking (preserving first-occurrence order) before tallying, so
 * the diagonal is always zero. Mirrors the audit's buildPairwiseMatrixCorrect and
 * the diagonal-zero property (P09 / Lean T7).
 */

import { describe, it, expect } from 'vitest';
import { tallyRanked } from '../src/routes/settlement.js';

const options = [
    { label: 'A', value: 0 },
    { label: 'B', value: 1 },
    { label: 'C', value: 2 },
];

function rankedTally(selections: number[][]) {
    const answers = selections.map((selection, i) => ({ questionId: `v${i}`, selection }));
    const tally = tallyRanked(answers as any, options);
    if (tally.method !== 'ranked') throw new Error('expected ranked tally');
    return tally;
}

const diagonalSum = (m: number[][]) => m.reduce((s, row, i) => s + row[i], 0);

describe('F-005 — ranked pairwise dedup', () => {
    it('well-formed ranking builds the expected matrix with a zero diagonal', () => {
        const { pairwise } = rankedTally([[0, 1, 2]]);
        expect(pairwise.options).toEqual([0, 1, 2]);
        // 0>1, 0>2, 1>2
        expect(pairwise.matrix).toEqual([
            [0, 1, 1],
            [0, 0, 1],
            [0, 0, 0],
        ]);
        expect(diagonalSum(pairwise.matrix)).toBe(0);
    });

    it('duplicate ranking [0,1,0] never writes the diagonal', () => {
        const { pairwise } = rankedTally([[0, 1, 0]]);
        expect(diagonalSum(pairwise.matrix)).toBe(0);
    });

    it('duplicate ranking tallies identically to its deduped form [0,1]', () => {
        const dup = rankedTally([[0, 1, 0]]).pairwise.matrix;
        const deduped = rankedTally([[0, 1]]).pairwise.matrix;
        expect(dup).toEqual(deduped);
        // Only the single real preference 0>1 is recorded.
        expect(dup).toEqual([
            [0, 1, 0],
            [0, 0, 0],
            [0, 0, 0],
        ]);
    });

    it('first-preference still credits the genuine first choice of a duplicate ranking', () => {
        const { firstPreference } = rankedTally([[0, 1, 0]]);
        expect(firstPreference).toEqual([
            { option: 0, count: 1 },
            { option: 1, count: 0 },
            { option: 2, count: 0 },
        ]);
    });

    it('diagonal stays zero across a mixed batch including duplicates', () => {
        const { pairwise } = rankedTally([[2, 2, 1], [1, 0, 1], [0, 1, 2]]);
        expect(diagonalSum(pairwise.matrix)).toBe(0);
    });
});
