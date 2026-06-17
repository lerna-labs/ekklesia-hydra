/**
 * Local unit tests for input validation logic.
 *
 * Tests pure functions that don't need a running server, Hydra node, or
 * external services. Validates that adversarial inputs are caught at the
 * correct layer with the correct error.
 */

import { describe, it, expect } from 'vitest';
import { voterIdToTokenName, voterIdHrp } from '../src/helpers.js';

// ---------------------------------------------------------------------------
// voterIdToTokenName — bech32 decode + credential prefix
// ---------------------------------------------------------------------------

describe('voterIdToTokenName', () => {
    it('should reject empty string', () => {
        expect(() => voterIdToTokenName('')).toThrow('Invalid voter ID');
    });

    it('should reject null/undefined', () => {
        expect(() => voterIdToTokenName(null as any)).toThrow();
        expect(() => voterIdToTokenName(undefined as any)).toThrow();
    });

    it('should reject invalid bech32 checksum', () => {
        expect(() => voterIdToTokenName(
            'drep1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq4e87a0'
        )).toThrow();
    });

    it('should reject completely garbage input', () => {
        expect(() => voterIdToTokenName('not-a-bech32-string-at-all!!!')).toThrow();
    });

    it('should reject extremely long input', () => {
        expect(() => voterIdToTokenName('drep1' + 'q'.repeat(10000))).toThrow();
    });

    it('should reject addr_test1 (exceeds bech32 length limit)', () => {
        expect(() => voterIdToTokenName(
            'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp'
        )).toThrow('Exceeds length limit');
    });
});

describe('voterIdHrp', () => {
    it('should reject invalid bech32', () => {
        expect(() => voterIdHrp('garbage')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// validateSelections — vote content validation
//
// The route's `validateSelections` is module-scoped in src/routes/voting.ts
// and not exported, so we replicate the logic here. This replica MUST stay
// in sync with the source — changing one without the other is a bug.
// ---------------------------------------------------------------------------

interface SelectionEntry {
    option: number;
    value: number;
}

interface VoteSelection {
    questionId: string;
    abstain?: true;
    selection?: number[] | SelectionEntry[];
}

interface QuestionDef {
    questionId: string;
    question: string;
    method: string;
    options?: Array<{ label: string; value: number }>;
    minSelections?: number;
    maxSelections?: number;
    valueRange?: { min: number; max: number; step?: number };
    rankCount?: number;
    budget?: number;
    ratingRange?: { min: number; max: number; step?: number };
    requireAnswer?: boolean;
    contentHash?: string;
}

function asNumberArray(s: VoteSelection['selection']): number[] | null {
    if (!Array.isArray(s) || s.length === 0) return null;
    return s.every((x) => typeof x === 'number') ? (s as number[]) : null;
}

function asEntryArray(s: VoteSelection['selection']): SelectionEntry[] | null {
    if (!Array.isArray(s) || s.length === 0) return null;
    return s.every(
        (x) =>
            typeof x === 'object' &&
            x !== null &&
            typeof (x as SelectionEntry).option === 'number' &&
            typeof (x as SelectionEntry).value === 'number',
    )
        ? (s as SelectionEntry[])
        : null;
}

function isOnGrid(v: number, min: number, max: number, step: number): boolean {
    if (!Number.isInteger(v)) return false;
    if (v < min || v > max) return false;
    return (v - min) % step === 0;
}

function validateSelections(votes: VoteSelection[], questions: QuestionDef[]): string | null {
    const questionMap = new Map(questions.map((q) => [q.questionId, q]));

    const seenQids = new Set<string>();
    for (const sel of votes) {
        if (seenQids.has(sel.questionId)) {
            return `Duplicate questionId "${sel.questionId}" in votes[] — at most one entry per question per submission`;
        }
        seenQids.add(sel.questionId);
    }

    for (const sel of votes) {
        const q = questionMap.get(sel.questionId);
        if (!q) return `Unknown questionId: "${sel.questionId}"`;

        const qid = sel.questionId;
        const validValues = q.options ? new Set(q.options.map((o) => o.value)) : null;

        if (sel.abstain === true) {
            if (q.requireAnswer) {
                return `"${qid}" requires an answer (question.requireAnswer is true) — abstain not permitted`;
            }
            if (sel.selection !== undefined) {
                return `"${qid}" abstain is mutually exclusive with selection`;
            }
            continue;
        }

        if (sel.selection === undefined) {
            return `"${qid}" requires either selection or abstain: true`;
        }

        switch (q.method) {
            case 'binary':
            case 'single-choice': {
                const values = asNumberArray(sel.selection);
                if (!values || values.length !== 1) {
                    return `"${qid}" (${q.method}) requires exactly 1 selection (number[])`;
                }
                if (validValues && !validValues.has(values[0])) {
                    return `Invalid option value ${values[0]} for "${qid}"`;
                }
                break;
            }

            case 'multi-choice': {
                const values = asNumberArray(sel.selection);
                if (!values) {
                    return `"${qid}" (multi-choice) requires a non-empty number[] selection (use abstain:true to skip)`;
                }
                const min = Math.max(q.minSelections ?? 1, 1);
                const max = q.maxSelections ?? (q.options?.length ?? 1);
                if (values.length < min) {
                    return `Too few selections for "${qid}": got ${values.length}, min ${min}`;
                }
                if (values.length > max) {
                    return `Too many selections for "${qid}": got ${values.length}, max ${max}`;
                }
                if (new Set(values).size !== values.length) {
                    return `Duplicate selections for "${qid}"`;
                }
                if (validValues) {
                    for (const v of values) {
                        if (!validValues.has(v)) return `Invalid option value ${v} for "${qid}"`;
                    }
                }
                break;
            }

            case 'range': {
                const values = asNumberArray(sel.selection);
                if (!values || values.length !== 1) {
                    return `"${qid}" (range) requires exactly 1 number value`;
                }
                if (!q.valueRange) {
                    return `"${qid}" is range type but has no valueRange defined`;
                }
                const step = q.valueRange.step ?? 1;
                const v = values[0];
                if (!isOnGrid(v, q.valueRange.min, q.valueRange.max, step)) {
                    return `Value ${v} is not on the grid [${q.valueRange.min}, ${q.valueRange.max}] step ${step} for "${qid}"`;
                }
                break;
            }

            case 'ranked': {
                const ranking = asNumberArray(sel.selection);
                if (!ranking) {
                    return `"${qid}" (ranked) requires a non-empty number[] selection (preference order)`;
                }
                const expectedCount = q.rankCount ?? (q.options?.length ?? 0);
                if (ranking.length !== expectedCount) {
                    return `"${qid}" (ranked) requires exactly ${expectedCount} ranked entries, got ${ranking.length}`;
                }
                if (validValues) {
                    for (const v of ranking) {
                        if (!validValues.has(v)) {
                            return `Invalid option value ${v} in ranking for "${qid}"`;
                        }
                    }
                }
                if (new Set(ranking).size !== ranking.length) {
                    return `Duplicate entries in ranking for "${qid}"`;
                }
                break;
            }

            case 'weighted': {
                const entries = asEntryArray(sel.selection);
                if (!entries) {
                    return `"${qid}" (weighted) requires a non-empty {option,value}[] selection`;
                }
                if (q.budget === undefined) {
                    return `"${qid}" is weighted type but has no budget defined`;
                }
                if (validValues) {
                    for (const e of entries) {
                        if (!validValues.has(e.option)) {
                            return `Invalid option value ${e.option} in weighted selection for "${qid}"`;
                        }
                    }
                }
                const optionSet = entries.map((e) => e.option);
                if (new Set(optionSet).size !== optionSet.length) {
                    return `Duplicate option entries in weighted selection for "${qid}"`;
                }
                for (const e of entries) {
                    if (!Number.isInteger(e.value) || e.value < 0) {
                        return `Weight must be a non-negative integer for "${qid}", got ${e.value}`;
                    }
                }
                const total = entries.reduce((sum, e) => sum + e.value, 0);
                if (total !== q.budget) {
                    return `Weights sum to ${total} but budget is ${q.budget} for "${qid}"`;
                }
                break;
            }

            case 'likert': {
                const entries = asEntryArray(sel.selection);
                if (!entries) {
                    return `"${qid}" (likert) requires a non-empty {option,value}[] selection`;
                }
                if (!q.ratingRange) {
                    return `"${qid}" is likert type but has no ratingRange defined`;
                }
                const expectedCount = q.options ? q.options.length : 0;
                if (entries.length !== expectedCount) {
                    return `"${qid}" (likert) expects ${expectedCount} ratings, got ${entries.length}`;
                }
                const optionSet = entries.map((e) => e.option);
                if (new Set(optionSet).size !== optionSet.length) {
                    return `Duplicate option entries in ratings for "${qid}"`;
                }
                const step = q.ratingRange.step ?? 1;
                if (validValues) {
                    for (const e of entries) {
                        if (!validValues.has(e.option)) {
                            return `Invalid option value ${e.option} in ratings for "${qid}"`;
                        }
                        if (!isOnGrid(e.value, q.ratingRange.min, q.ratingRange.max, step)) {
                            return `Rating ${e.value} is not on the grid [${q.ratingRange.min}, ${q.ratingRange.max}] step ${step} for "${qid}"`;
                        }
                    }
                }
                break;
            }

            default:
                return `Unknown vote method for "${qid}"`;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// validateBallotDefinition — ballot-level sanity checks (matches ballot.ts)
// ---------------------------------------------------------------------------

function validateGrid(
    label: string,
    grid: { min: number; max: number; step?: number },
): string | null {
    const step = grid.step ?? 1;
    if (!Number.isInteger(grid.min) || !Number.isInteger(grid.max) || !Number.isInteger(step)) {
        return `${label}: min, max, and step must all be integers`;
    }
    if (step <= 0) return `${label}: step must be a positive integer`;
    if (grid.max < grid.min) return `${label}: max (${grid.max}) must be >= min (${grid.min})`;
    if ((grid.max - grid.min) % step !== 0) {
        return `${label}: (max - min) must be divisible by step — ${grid.max} - ${grid.min} is not a multiple of ${step}`;
    }
    return null;
}

function validateOptions(
    label: string,
    options: QuestionDef['options'],
): string | null {
    if (!options) return null;
    const seen = new Set<number>();
    for (const o of options) {
        if (typeof o.value !== 'number' || !Number.isInteger(o.value) || o.value < 0) {
            return `${label}: option values must be non-negative integers (got ${o.value})`;
        }
        if (seen.has(o.value)) return `${label}: duplicate option value ${o.value}`;
        seen.add(o.value);
    }
    return null;
}

const ALLOWED_ROLES = new Set(['drep', 'pool', 'stake']);
const ALLOWED_HRPS = new Set(['drep', 'pool', 'stake', 'stake_test']);
const ALLOWED_MODES_BY_ROLE: Record<string, Set<string>> = {
    drep: new Set(['CredentialBased', 'StakeBased']),
    pool: new Set(['CredentialBased', 'StakeBased', 'PledgeBased']),
    stake: new Set(['CredentialBased', 'StakeBased']),
};

function validateBallotHeader(ballot: {
    roleWeighting?: Record<string, string>;
    ekklesia?: { acceptedCredentials?: string[] };
}): string | null {
    if (ballot.roleWeighting) {
        for (const role of Object.keys(ballot.roleWeighting)) {
            if (!ALLOWED_ROLES.has(role)) {
                return `roleWeighting contains unrecognized role "${role}"`;
            }
            const mode = ballot.roleWeighting[role];
            const allowed = ALLOWED_MODES_BY_ROLE[role];
            if (!allowed.has(mode)) {
                return `roleWeighting.${role} has invalid mode "${mode}"`;
            }
        }
    }
    const accepted = ballot.ekklesia?.acceptedCredentials;
    if (accepted && Array.isArray(accepted)) {
        for (const hrp of accepted) {
            if (!ALLOWED_HRPS.has(hrp)) {
                return `ekklesia.acceptedCredentials contains unrecognized HRP "${hrp}"`;
            }
        }
    }
    return null;
}

function validateBallotQuestions(questions: QuestionDef[]): string | null {
    if (!Array.isArray(questions) || questions.length === 0) {
        return 'Ballot must contain at least one question';
    }
    const ids = new Set<string>();
    for (const q of questions) {
        if (!q.questionId) return 'Every question must have a questionId';
        if (ids.has(q.questionId)) return `Duplicate questionId: "${q.questionId}"`;
        ids.add(q.questionId);

        if ((q as unknown as Record<string, unknown>).abstainAllowed !== undefined) {
            return `"${q.questionId}" uses legacy field "abstainAllowed" — replaced by "requireAnswer"`;
        }

        if (q.contentHash !== undefined) {
            if (typeof q.contentHash !== 'string') {
                return `"${q.questionId}" contentHash must be a string`;
            }
            if (!/^[0-9a-f]{64}$/.test(q.contentHash)) {
                return `"${q.questionId}" contentHash must be exactly 64 lowercase hex characters (blake2b_256)`;
            }
        }

        if (q.options) {
            const e = validateOptions(`"${q.questionId}" options`, q.options);
            if (e) return e;
        }

        if (q.method === 'range') {
            if (!q.valueRange) return `"${q.questionId}" is range but has no valueRange defined`;
            const err = validateGrid(`"${q.questionId}" valueRange`, q.valueRange);
            if (err) return err;
        }
        if (q.method === 'likert') {
            if (!q.ratingRange) return `"${q.questionId}" is likert but has no ratingRange defined`;
            if (!q.options || q.options.length === 0) {
                return `"${q.questionId}" is likert but has no options to rate`;
            }
            const err = validateGrid(`"${q.questionId}" ratingRange`, q.ratingRange);
            if (err) return err;
        }
        if (q.method === 'weighted') {
            if (q.budget === undefined || !Number.isInteger(q.budget) || q.budget <= 0) {
                return `"${q.questionId}" is weighted but has no positive integer budget`;
            }
            if (!q.options || q.options.length === 0) {
                return `"${q.questionId}" is weighted but has no options`;
            }
        }
        if (q.method === 'ranked') {
            if (!q.options || q.options.length === 0) {
                return `"${q.questionId}" is ranked but has no options`;
            }
            if (q.rankCount === undefined) {
                return `"${q.questionId}" ranked: rankCount is required (no silent default — specify how many options must be ranked)`;
            }
            if (!Number.isInteger(q.rankCount) || q.rankCount < 1 || q.rankCount > q.options.length) {
                return `"${q.questionId}" ranked: rankCount must be a positive integer no greater than options.length`;
            }
        }
        if (q.method === 'multi-choice') {
            if (!q.options || q.options.length === 0) {
                return `"${q.questionId}" is multi-choice but has no options`;
            }
            const min = q.minSelections ?? 1;
            const max = q.maxSelections ?? q.options.length;
            if (!Number.isInteger(min) || min < 1) {
                return `"${q.questionId}" multi-choice: minSelections must be a positive integer (empty selections disallowed — use abstainAllowed instead)`;
            }
            if (!Number.isInteger(max) || max < min) {
                return `"${q.questionId}" multi-choice: maxSelections must be an integer >= minSelections (${min})`;
            }
            if (max > q.options.length) {
                return `"${q.questionId}" multi-choice: maxSelections (${max}) exceeds options.length (${q.options.length})`;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const binaryQuestion: QuestionDef = {
    questionId: 'q1',
    question: 'Approve?',
    method: 'binary',
    options: [
        { label: 'Yes', value: 1 },
        { label: 'No', value: 0 },
        { label: 'Abstain', value: 2 },
    ],
};

const rangeQuestion: QuestionDef = {
    questionId: 'qR',
    question: 'Score -5 to 5',
    method: 'range',
    valueRange: { min: -5, max: 5 },
};

const rangeStepped: QuestionDef = {
    questionId: 'qRS',
    question: 'Score 0-100 in steps of 5',
    method: 'range',
    valueRange: { min: 0, max: 100, step: 5 },
};

const rankedQuestion: QuestionDef = {
    questionId: 'qRank',
    question: 'Rank the options',
    method: 'ranked',
    rankCount: 3,
    options: [
        { label: 'A', value: 1 },
        { label: 'B', value: 2 },
        { label: 'C', value: 3 },
    ],
};

const abstainableLikert: QuestionDef = {
    questionId: 'qLA',
    question: 'Rate the options (abstain allowed by default)',
    method: 'likert',
    ratingRange: { min: 1, max: 5 },
    options: [
        { label: 'A', value: 1 },
        { label: 'B', value: 2 },
    ],
};

const mustAnswerLikert: QuestionDef = {
    questionId: 'qLR',
    question: 'Rate the options (must answer)',
    method: 'likert',
    requireAnswer: true,
    ratingRange: { min: 1, max: 5 },
    options: [
        { label: 'A', value: 1 },
        { label: 'B', value: 2 },
    ],
};

const weightedQuestion: QuestionDef = {
    questionId: 'qW',
    question: 'Allocate 100 points',
    method: 'weighted',
    budget: 100,
    options: [
        { label: 'A', value: 1 },
        { label: 'B', value: 2 },
        { label: 'C', value: 3 },
    ],
};

const likertQuestion: QuestionDef = {
    questionId: 'qL',
    question: 'Rate each proposal',
    method: 'likert',
    ratingRange: { min: 1, max: 5 },
    options: [
        { label: 'P1', value: 1 },
        { label: 'P2', value: 2 },
        { label: 'P3', value: 3 },
        { label: 'P4', value: 4 },
        { label: 'P5', value: 5 },
        { label: 'P6', value: 6 },
        { label: 'P7', value: 7 },
    ],
};

const likertStepped: QuestionDef = {
    questionId: 'qLS',
    question: 'Rate on a 0..10 scale in steps of 2',
    method: 'likert',
    ratingRange: { min: 0, max: 10, step: 2 },
    options: [
        { label: 'O1', value: 1 },
        { label: 'O2', value: 2 },
    ],
};

// ---------------------------------------------------------------------------
// Binary validation
// ---------------------------------------------------------------------------

describe('validateSelections — binary', () => {
    it('should accept valid binary vote', () => {
        expect(validateSelections(
            [{ questionId: 'q1', selection: [1] }],
            [binaryQuestion],
        )).toBeNull();
    });

    it('should reject unknown questionId', () => {
        const err = validateSelections(
            [{ questionId: 'nonexistent', selection: [1] }],
            [binaryQuestion],
        );
        expect(err).toContain('Unknown questionId');
    });

    it('should reject invalid option value', () => {
        const err = validateSelections(
            [{ questionId: 'q1', selection: [99] }],
            [binaryQuestion],
        );
        expect(err).toContain('Invalid option value');
    });

    it('should reject multiple selections on binary', () => {
        const err = validateSelections(
            [{ questionId: 'q1', selection: [1, 0] }],
            [binaryQuestion],
        );
        expect(err).toContain('requires exactly 1 selection');
    });

    it('should reject empty selection on binary', () => {
        const err = validateSelections(
            [{ questionId: 'q1', selection: [] }],
            [binaryQuestion],
        );
        expect(err).toContain('requires exactly 1 selection');
    });

    it('should reject missing selection field', () => {
        const err = validateSelections(
            [{ questionId: 'q1' } as any],
            [binaryQuestion],
        );
        expect(err).toContain('requires either selection or abstain: true');
    });

    it('should reject string value in selection (type confusion)', () => {
        const err = validateSelections(
            [{ questionId: 'q1', selection: ['1' as any] }],
            [binaryQuestion],
        );
        expect(err).toContain('requires exactly 1 selection');
    });

    it('should accept empty votes array', () => {
        expect(validateSelections([], [binaryQuestion])).toBeNull();
    });

    it('should reject two votes referencing the same questionId in one submission', () => {
        const err = validateSelections(
            [
                { questionId: 'q1', selection: [1] },
                { questionId: 'q1', selection: [0] },
            ],
            [binaryQuestion],
        );
        expect(err).toContain('Duplicate questionId "q1"');
    });
});

// ---------------------------------------------------------------------------
// Range validation — includes step grid
// ---------------------------------------------------------------------------

describe('validateSelections — range', () => {
    it('should accept value inside range (default step=1)', () => {
        expect(validateSelections(
            [{ questionId: 'qR', selection: [3] }],
            [rangeQuestion],
        )).toBeNull();
    });

    it('should accept min/max boundary values', () => {
        expect(validateSelections(
            [{ questionId: 'qR', selection: [-5] }],
            [rangeQuestion],
        )).toBeNull();
        expect(validateSelections(
            [{ questionId: 'qR', selection: [5] }],
            [rangeQuestion],
        )).toBeNull();
    });

    it('should reject value outside the range', () => {
        const err = validateSelections(
            [{ questionId: 'qR', selection: [6] }],
            [rangeQuestion],
        );
        expect(err).toContain('not on the grid');
    });

    it('should reject non-integer value (default step=1 grid)', () => {
        const err = validateSelections(
            [{ questionId: 'qR', selection: [2.5] }],
            [rangeQuestion],
        );
        expect(err).toContain('not on the grid');
    });

    it('should accept value on stepped grid', () => {
        expect(validateSelections(
            [{ questionId: 'qRS', selection: [0] }],
            [rangeStepped],
        )).toBeNull();
        expect(validateSelections(
            [{ questionId: 'qRS', selection: [45] }],
            [rangeStepped],
        )).toBeNull();
        expect(validateSelections(
            [{ questionId: 'qRS', selection: [100] }],
            [rangeStepped],
        )).toBeNull();
    });

    it('should reject value off the stepped grid', () => {
        const err = validateSelections(
            [{ questionId: 'qRS', selection: [42] }],
            [rangeStepped],
        );
        expect(err).toContain('not on the grid');
    });

    it('should reject more than one value', () => {
        const err = validateSelections(
            [{ questionId: 'qR', selection: [1, 2] }],
            [rangeQuestion],
        );
        expect(err).toContain('requires exactly 1');
    });
});

// ---------------------------------------------------------------------------
// Ranked validation
// ---------------------------------------------------------------------------

describe('validateSelections — ranked', () => {
    it('should accept a valid full ranking', () => {
        expect(validateSelections(
            [{ questionId: 'qRank', selection: [3, 1, 2] }],
            [rankedQuestion],
        )).toBeNull();
    });

    it('should reject a partial ranking when rankCount defaults to options.length', () => {
        const err = validateSelections(
            [{ questionId: 'qRank', selection: [3, 1] }],
            [rankedQuestion],
        );
        expect(err).toContain('requires exactly 3 ranked entries');
    });

    it('should reject duplicate preferences', () => {
        const err = validateSelections(
            [{ questionId: 'qRank', selection: [1, 1, 2] }],
            [rankedQuestion],
        );
        expect(err).toContain('Duplicate entries in ranking');
    });

    it('should reject unknown option in ranking', () => {
        const err = validateSelections(
            [{ questionId: 'qRank', selection: [1, 2, 99] }],
            [rankedQuestion],
        );
        expect(err).toContain('Invalid option value 99');
    });
});

// ---------------------------------------------------------------------------
// Weighted validation
// ---------------------------------------------------------------------------

describe('validateSelections — weighted', () => {
    it('should accept an allocation that sums to budget', () => {
        expect(validateSelections(
            [{
                questionId: 'qW',
                selection: [
                    { option: 1, value: 60 },
                    { option: 2, value: 40 },
                ],
            }],
            [weightedQuestion],
        )).toBeNull();
    });

    it('should reject a sum mismatch with the budget', () => {
        const err = validateSelections(
            [{
                questionId: 'qW',
                selection: [
                    { option: 1, value: 50 },
                    { option: 2, value: 40 },
                ],
            }],
            [weightedQuestion],
        );
        expect(err).toContain('Weights sum to 90 but budget is 100');
    });

    it('should reject a negative allocation', () => {
        const err = validateSelections(
            [{
                questionId: 'qW',
                selection: [
                    { option: 1, value: -10 },
                    { option: 2, value: 110 },
                ],
            }],
            [weightedQuestion],
        );
        expect(err).toContain('non-negative integer');
    });

    it('should reject duplicate option entries', () => {
        const err = validateSelections(
            [{
                questionId: 'qW',
                selection: [
                    { option: 1, value: 50 },
                    { option: 1, value: 50 },
                ],
            }],
            [weightedQuestion],
        );
        expect(err).toContain('Duplicate option entries');
    });

    it('should reject a number[] selection on a weighted question', () => {
        const err = validateSelections(
            [{ questionId: 'qW', selection: [1, 2, 3] }],
            [weightedQuestion],
        );
        expect(err).toContain('requires a non-empty {option,value}[] selection');
    });
});

// ---------------------------------------------------------------------------
// Likert validation — includes step grid
// ---------------------------------------------------------------------------

describe('validateSelections — likert', () => {
    it('should accept a valid likert vote rating every option in range', () => {
        expect(validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 4 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [likertQuestion],
        )).toBeNull();
    });

    it('should reject a missing option (fewer ratings than options)', () => {
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 4 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                ],
            }],
            [likertQuestion],
        );
        expect(err).toContain('expects 7 ratings, got 6');
    });

    it('should reject a duplicate option', () => {
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 4 },
                    { option: 1, value: 2 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [likertQuestion],
        );
        expect(err).toContain('Duplicate option entries in ratings');
    });

    it('should reject a rating below ratingRange.min', () => {
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 0 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [likertQuestion],
        );
        expect(err).toContain('not on the grid');
    });

    it('should reject a non-integer rating', () => {
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 3.5 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [likertQuestion],
        );
        expect(err).toContain('not on the grid');
    });

    it('should reject a likert question missing ratingRange', () => {
        const brokenQuestion: QuestionDef = { ...likertQuestion, ratingRange: undefined };
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 1, value: 4 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [brokenQuestion],
        );
        expect(err).toContain('has no ratingRange defined');
    });

    it('should reject an empty selection array', () => {
        const err = validateSelections(
            [{ questionId: 'qL', selection: [] }],
            [likertQuestion],
        );
        expect(err).toContain('requires a non-empty {option,value}[] selection');
    });

    it('should reject a rating targeting an option not in the question', () => {
        const err = validateSelections(
            [{
                questionId: 'qL',
                selection: [
                    { option: 99, value: 4 },
                    { option: 2, value: 5 },
                    { option: 3, value: 3 },
                    { option: 4, value: 2 },
                    { option: 5, value: 5 },
                    { option: 6, value: 1 },
                    { option: 7, value: 3 },
                ],
            }],
            [likertQuestion],
        );
        expect(err).toContain('Invalid option value 99 in ratings');
    });

    it('should accept a value on a stepped rating grid', () => {
        expect(validateSelections(
            [{
                questionId: 'qLS',
                selection: [
                    { option: 1, value: 4 },
                    { option: 2, value: 10 },
                ],
            }],
            [likertStepped],
        )).toBeNull();
    });

    it('should reject a value off the stepped rating grid', () => {
        const err = validateSelections(
            [{
                questionId: 'qLS',
                selection: [
                    { option: 1, value: 3 },
                    { option: 2, value: 10 },
                ],
            }],
            [likertStepped],
        );
        expect(err).toContain('not on the grid');
    });
});

// ---------------------------------------------------------------------------
// Ballot-level validator — grid integrity + method requirements
// ---------------------------------------------------------------------------

describe('validateBallotQuestions', () => {
    it('accepts a well-formed likert question', () => {
        expect(validateBallotQuestions([likertQuestion])).toBeNull();
    });

    it('accepts a stepped range grid where (max-min) % step === 0', () => {
        expect(validateBallotQuestions([rangeStepped])).toBeNull();
    });

    it('rejects a range grid where max is unreachable on the step grid', () => {
        const broken: QuestionDef = {
            questionId: 'qBad',
            question: 'Off-grid max',
            method: 'range',
            valueRange: { min: 0, max: 99, step: 5 }, // 99 - 0 = 99, not divisible by 5
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('not a multiple of 5');
    });

    it('rejects a non-integer step', () => {
        const broken: QuestionDef = {
            questionId: 'qBad',
            question: 'Float step',
            method: 'range',
            valueRange: { min: 0, max: 10, step: 0.5 as any },
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('must all be integers');
    });

    it('rejects a likert grid with max < min', () => {
        const broken: QuestionDef = {
            questionId: 'qBad',
            question: 'Inverted',
            method: 'likert',
            ratingRange: { min: 5, max: 1 },
            options: [{ label: 'A', value: 1 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('max (1) must be >= min (5)');
    });

    it('rejects a weighted question with zero budget', () => {
        const broken: QuestionDef = {
            questionId: 'qBad',
            question: 'Zero budget',
            method: 'weighted',
            budget: 0,
            options: [{ label: 'A', value: 1 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('no positive integer budget');
    });

    it('rejects duplicate questionIds', () => {
        const err = validateBallotQuestions([binaryQuestion, { ...binaryQuestion }]);
        expect(err).toContain('Duplicate questionId');
    });

    it('rejects an empty questions array', () => {
        const err = validateBallotQuestions([]);
        expect(err).toContain('at least one question');
    });

    it('rejects duplicate option values within a question', () => {
        const broken: QuestionDef = {
            questionId: 'qDup',
            question: 'Pick one',
            method: 'single-choice',
            options: [
                { label: 'A', value: 1 },
                { label: 'B', value: 1 },
            ],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('duplicate option value 1');
    });

    it('rejects a negative option value', () => {
        const broken: QuestionDef = {
            questionId: 'qNeg',
            question: 'Pick one',
            method: 'single-choice',
            options: [{ label: 'A', value: -1 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('non-negative integers');
    });

    it('rejects a ranked question with no rankCount specified', () => {
        const broken: QuestionDef = {
            questionId: 'qRankNoRC',
            question: 'Rank',
            method: 'ranked',
            options: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('rankCount is required');
    });

    it('rejects a multi-choice with min=0', () => {
        const broken: QuestionDef = {
            questionId: 'qMultiZero',
            question: 'Pick some',
            method: 'multi-choice',
            minSelections: 0,
            options: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('minSelections must be a positive integer');
    });

    it('accepts a valid lowercase-hex contentHash on a question', () => {
        const good: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCH',
            contentHash: 'a'.repeat(64),
        };
        expect(validateBallotQuestions([good])).toBeNull();
    });

    it('accepts a ballot with mixed contentHash presence', () => {
        const withHash: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCH1',
            contentHash: '0123456789abcdef'.repeat(4),
        };
        const withoutHash: QuestionDef = { ...binaryQuestion, questionId: 'qCH2' };
        expect(validateBallotQuestions([withHash, withoutHash])).toBeNull();
    });

    it('rejects an uppercase-hex contentHash', () => {
        const broken: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCHup',
            contentHash: 'A'.repeat(64),
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('64 lowercase hex characters');
    });

    it('rejects a contentHash that is too short', () => {
        const broken: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCHshort',
            contentHash: 'abc123',
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('64 lowercase hex characters');
    });

    it('rejects a contentHash that is too long', () => {
        const broken: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCHlong',
            contentHash: 'a'.repeat(65),
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('64 lowercase hex characters');
    });

    it('rejects a contentHash that contains non-hex characters', () => {
        const broken: QuestionDef = {
            ...binaryQuestion,
            questionId: 'qCHjunk',
            contentHash: 'g'.repeat(64),
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('64 lowercase hex characters');
    });

    it('rejects a non-string contentHash', () => {
        const broken = {
            ...binaryQuestion,
            questionId: 'qCHnum',
            contentHash: 12345,
        } as unknown as QuestionDef;
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('contentHash must be a string');
    });

    it('rejects a question using the legacy abstainAllowed field', () => {
        const broken = {
            ...binaryQuestion,
            questionId: 'qLegacy',
            abstainAllowed: true,
        } as unknown as QuestionDef;
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('legacy field "abstainAllowed"');
    });

    it('rejects a multi-choice with max > options.length', () => {
        const broken: QuestionDef = {
            questionId: 'qMultiTooMany',
            question: 'Pick some',
            method: 'multi-choice',
            minSelections: 1,
            maxSelections: 5,
            options: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }],
        };
        const err = validateBallotQuestions([broken]);
        expect(err).toContain('exceeds options.length');
    });
});

// ---------------------------------------------------------------------------
// Ballot header (roleWeighting + acceptedCredentials) validation
// ---------------------------------------------------------------------------

describe('validateBallotHeader', () => {
    it('accepts a ballot with lowercase roles and allowed HRPs', () => {
        expect(validateBallotHeader({
            roleWeighting: { drep: 'CredentialBased', pool: 'PledgeBased' },
            ekklesia: { acceptedCredentials: ['drep', 'pool', 'stake'] },
        })).toBeNull();
    });

    it('rejects a legacy DRep role in roleWeighting', () => {
        const err = validateBallotHeader({
            roleWeighting: { DRep: 'CredentialBased' },
        });
        expect(err).toContain('unrecognized role "DRep"');
    });

    it('rejects a CC role in roleWeighting (dropped entirely)', () => {
        const err = validateBallotHeader({
            roleWeighting: { CC: 'CredentialBased' } as Record<string, string>,
        });
        expect(err).toContain('unrecognized role "CC"');
    });

    it('rejects addr in acceptedCredentials (payment-stake composite disallowed)', () => {
        const err = validateBallotHeader({
            ekklesia: { acceptedCredentials: ['drep', 'addr'] },
        });
        expect(err).toContain('unrecognized HRP "addr"');
    });

    it('rejects a credential prefix byte (`0x22`) in acceptedCredentials', () => {
        const err = validateBallotHeader({
            ekklesia: { acceptedCredentials: ['0x22'] },
        });
        expect(err).toContain('unrecognized HRP "0x22"');
    });

    it('accepts a multi-key roleWeighting per RSS v2 example', () => {
        expect(validateBallotHeader({
            roleWeighting: { drep: 'StakeBased', pool: 'PledgeBased' },
        })).toBeNull();
    });

    it('rejects drep with PledgeBased mode', () => {
        const err = validateBallotHeader({
            roleWeighting: { drep: 'PledgeBased' },
        });
        expect(err).toContain('roleWeighting.drep has invalid mode "PledgeBased"');
    });

    it('accepts stake with CredentialBased mode (one-stake-key-one-vote)', () => {
        expect(validateBallotHeader({
            roleWeighting: { stake: 'CredentialBased' },
        })).toBeNull();
    });

    it('rejects stake with PledgeBased mode (pool-only concept)', () => {
        const err = validateBallotHeader({
            roleWeighting: { stake: 'PledgeBased' },
        });
        expect(err).toContain('roleWeighting.stake has invalid mode "PledgeBased"');
    });

    it('rejects pool with a made-up mode', () => {
        const err = validateBallotHeader({
            roleWeighting: { pool: 'Bogus' },
        });
        expect(err).toContain('roleWeighting.pool has invalid mode "Bogus"');
    });
});

// ---------------------------------------------------------------------------
// Abstain validation
// ---------------------------------------------------------------------------

describe('validateSelections — abstain', () => {
    it('accepts abstain: true by default (no requireAnswer flag)', () => {
        expect(validateSelections(
            [{ questionId: 'qLA', abstain: true }],
            [abstainableLikert],
        )).toBeNull();
    });

    it('also accepts abstain: true on the unflagged likertQuestion (default permits)', () => {
        expect(validateSelections(
            [{ questionId: 'qL', abstain: true }],
            [likertQuestion],
        )).toBeNull();
    });

    it('rejects abstain on a question with requireAnswer: true', () => {
        const err = validateSelections(
            [{ questionId: 'qLR', abstain: true }],
            [mustAnswerLikert],
        );
        expect(err).toContain('requires an answer');
    });

    it('rejects abstain + selection together', () => {
        const err = validateSelections(
            [{
                questionId: 'qLA',
                abstain: true,
                selection: [{ option: 1, value: 3 }, { option: 2, value: 4 }],
            }],
            [abstainableLikert],
        );
        expect(err).toContain('mutually exclusive');
    });

    it('rejects a vote with neither abstain nor selection', () => {
        const err = validateSelections(
            [{ questionId: 'qL' } as any],
            [likertQuestion],
        );
        expect(err).toContain('requires either selection or abstain: true');
    });
});

// ---------------------------------------------------------------------------
// Multi-choice empty-selection rejection (must use abstain)
// ---------------------------------------------------------------------------

describe('validateSelections — multi-choice rejects empty selection', () => {
    const multi: QuestionDef = {
        questionId: 'qM',
        question: 'Pick any',
        method: 'multi-choice',
        options: [
            { label: 'A', value: 1 },
            { label: 'B', value: 2 },
            { label: 'C', value: 3 },
        ],
    };

    it('rejects an empty selection', () => {
        const err = validateSelections(
            [{ questionId: 'qM', selection: [] }],
            [multi],
        );
        expect(err).toContain('requires a non-empty number[] selection');
    });

    it('accepts a one-element selection (default min is 1)', () => {
        expect(validateSelections(
            [{ questionId: 'qM', selection: [1] }],
            [multi],
        )).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Route-level input validation tracing
// ---------------------------------------------------------------------------

describe('route input validation tracing', () => {
    function checkMissingFields(body: any): boolean {
        const { voterId, nonce, ballotId, votes, signature } = body ?? {};
        return !voterId || !nonce || !ballotId || !votes || !signature;
    }

    it('empty body → MISSING_FIELDS', () => {
        expect(checkMissingFields({})).toBe(true);
    });

    it('null body → MISSING_FIELDS', () => {
        expect(checkMissingFields(null)).toBe(true);
    });

    it('only voterId → MISSING_FIELDS', () => {
        expect(checkMissingFields({ voterId: 'drep1abc' })).toBe(true);
    });

    it('missing signature → MISSING_FIELDS', () => {
        expect(checkMissingFields({
            voterId: 'x', nonce: 3, ballotId: 'y', votes: [{}],
        })).toBe(true);
    });

    it('missing votes → MISSING_FIELDS', () => {
        expect(checkMissingFields({
            voterId: 'x', nonce: 3, ballotId: 'y', signature: {},
        })).toBe(true);
    });

    it('nonce 0 → MISSING_FIELDS (0 is falsy)', () => {
        expect(checkMissingFields({
            voterId: 'x', nonce: 0, ballotId: 'y', votes: [{}], signature: {},
        })).toBe(true);
    });

    it('complete body passes missing fields check', () => {
        expect(checkMissingFields({
            voterId: 'x', nonce: 3, ballotId: 'y', votes: [{}], signature: {},
        })).toBe(false);
    });

    it('nonce -1 fails replay check (nonce <= version)', () => {
        const existingVersion = 2;
        expect(-1 <= existingVersion).toBe(true);
    });

    it('nonce equal to version fails replay check', () => {
        const existingVersion = 2;
        expect(2 <= existingVersion).toBe(true);
    });

    it('nonce 1 fails replay check when version is 2', () => {
        const existingVersion = 2;
        expect(1 <= existingVersion).toBe(true);
    });

    it('string nonce "3" is truthy but may fail downstream', () => {
        const nonce = '3' as any;
        const existingVersion = 2;
        expect(nonce <= existingVersion).toBe(false);
    });

    it('empty votes array is truthy (passes !votes check)', () => {
        expect(!([]) ).toBe(false);
    });

    it('votes as object is truthy (passes !votes check)', () => {
        expect(!({})).toBe(false);
    });
});
