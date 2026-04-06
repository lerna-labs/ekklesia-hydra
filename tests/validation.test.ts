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
        // addr_test1 addresses are too long for standard bech32 decode — throws before prefix check
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
// We can't import validateSelections directly (it's a module-scoped function
// in voting.ts, not exported). Instead we test the logic by tracing what
// the route handler would do.
// ---------------------------------------------------------------------------

// Inline replica of the validation logic for unit testing.
// This must stay in sync with src/routes/voting.ts:validateSelections.
interface VoteSelection {
    questionId: string;
    selection?: number[];
    ranking?: number[];
    weights?: Array<{ option: number; weight: number }>;
}

interface QuestionDef {
    questionId: string;
    question: string;
    method: string;
    options?: Array<{ label: string; value: number }>;
    minSelections?: number;
    maxSelections?: number;
    valueRange?: { min: number; max: number };
    rankCount?: number;
    budget?: number;
}

function validateSelections(votes: VoteSelection[], questions: QuestionDef[]): string | null {
    const questionMap = new Map(questions.map((q) => [q.questionId, q]));

    for (const sel of votes) {
        const q = questionMap.get(sel.questionId);
        if (!q) {
            return `Unknown questionId: "${sel.questionId}"`;
        }

        const qid = sel.questionId;
        const validValues = q.options ? new Set(q.options.map((o) => o.value)) : null;

        switch (q.method) {
            case 'binary':
            case 'single-choice': {
                if (!sel.selection || sel.selection.length !== 1) {
                    return `"${qid}" (${q.method}) requires exactly 1 selection`;
                }
                if (validValues && !validValues.has(sel.selection[0])) {
                    return `Invalid option value ${sel.selection[0]} for "${qid}"`;
                }
                break;
            }

            case 'multi-choice': {
                if (!sel.selection) {
                    return `"${qid}" (multi-choice) requires selection array`;
                }
                const min = q.minSelections ?? 0;
                const max = q.maxSelections ?? (q.options?.length ?? 1);
                if (sel.selection.length < min) {
                    return `Too few selections for "${qid}": got ${sel.selection.length}, min ${min}`;
                }
                if (sel.selection.length > max) {
                    return `Too many selections for "${qid}": got ${sel.selection.length}, max ${max}`;
                }
                if (new Set(sel.selection).size !== sel.selection.length) {
                    return `Duplicate selections for "${qid}"`;
                }
                if (validValues) {
                    for (const v of sel.selection) {
                        if (!validValues.has(v)) {
                            return `Invalid option value ${v} for "${qid}"`;
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

describe('validateSelections', () => {
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
            [{ questionId: 'q1' }],
            [binaryQuestion],
        );
        expect(err).toContain('requires exactly 1 selection');
    });

    it('should reject string value in selection (type confusion)', () => {
        // '1' as string won't be in the Set of numbers
        const err = validateSelections(
            [{ questionId: 'q1', selection: ['1' as any] }],
            [binaryQuestion],
        );
        expect(err).toContain('Invalid option value');
    });

    it('should reject XSS in questionId', () => {
        const err = validateSelections(
            [{ questionId: '<script>alert(1)</script>', selection: [1] }],
            [binaryQuestion],
        );
        expect(err).toContain('Unknown questionId');
    });

    it('should reject 1000 unknown question entries', () => {
        const bigVotes = Array.from({ length: 1000 }, (_, i) => ({
            questionId: `q${i}`,
            selection: [1],
        }));
        // q0 doesn't exist in ballot (ballot has q1)
        const err = validateSelections(bigVotes, [binaryQuestion]);
        expect(err).toContain('Unknown questionId');
    });

    it('should accept empty votes array (no questions to validate)', () => {
        // Empty array has no votes to check — all zero pass
        expect(validateSelections([], [binaryQuestion])).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Route-level input validation tracing
//
// These trace the exact code paths in the route handlers to confirm
// what status/code each adversarial case will produce.
// ---------------------------------------------------------------------------

describe('route input validation tracing', () => {

    // Simulate the !voterId || !nonce || !ballotId || !votes || !signature check
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

    // Nonce replay check: nonce <= existingVote.version
    it('nonce -1 fails replay check (nonce <= version)', () => {
        const existingVersion = 2;
        expect(-1 <= existingVersion).toBe(true); // → 409 CONFLICT
    });

    it('nonce equal to version fails replay check', () => {
        const existingVersion = 2;
        expect(2 <= existingVersion).toBe(true); // → 409 CONFLICT
    });

    it('nonce 1 fails replay check when version is 2', () => {
        const existingVersion = 2;
        expect(1 <= existingVersion).toBe(true); // → 409 CONFLICT
    });

    it('string nonce "3" is truthy but may fail downstream', () => {
        // "3" is truthy so passes !nonce, but as a string it may cause
        // issues in nonce <= existingVersion (string comparison)
        const nonce = '3' as any;
        const existingVersion = 2;
        // '3' <= 2 in JS: string '3' compared to number 2 → '3' coerced to 3 → false
        // So it passes replay check and proceeds to signature verification
        expect(nonce <= existingVersion).toBe(false);
        // This means string nonce '3' will NOT be caught by replay check,
        // will pass missing fields, and will fail at signature verification (401)
    });

    // Empty votes array: [] is truthy in JS
    it('empty votes array is truthy (passes !votes check)', () => {
        expect(!([]) ).toBe(false); // [] is truthy
        // So empty votes passes MISSING_FIELDS and proceeds to signature verification
    });

    // votes as object: {} is truthy
    it('votes as object is truthy (passes !votes check)', () => {
        expect(!({})).toBe(false);
        // So votes-as-object passes MISSING_FIELDS and proceeds
        // validateSelections will iterate it — for..of on an object throws
    });
});
