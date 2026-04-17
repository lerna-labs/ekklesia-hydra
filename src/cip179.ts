/**
 * CIP-179 Compatibility Layer
 *
 * Bidirectional mapping between Ekklesia-native types and CIP-179
 * surveyDetails / surveyResponse formats.
 *
 * Ekklesia uses CIP-179 core fields in its datums with extensions in the
 * `ekklesia` block. This module strips/adds extensions for interop with
 * tools that only speak CIP-179.
 */

import type {
    BallotDefinition,
    BallotQuestion,
    VoteEvidence,
    VoteSelection,
    VoteMethod,
    RoleWeighting,
} from './types.js';

// ---------------------------------------------------------------------------
// CIP-179 Types (subset relevant for mapping)
// ---------------------------------------------------------------------------

/** CIP-179 method type URIs. */
export const CIP179_METHOD = {
    SINGLE_CHOICE: 'urn:cardano:poll-method:single-choice:v1',
    MULTI_SELECT: 'urn:cardano:poll-method:multi-select:v1',
    NUMERIC_RANGE: 'urn:cardano:poll-method:numeric-range:v1',
} as const;

export interface Cip179Question {
    questionId: string;
    question: string;
    methodType: string;
    options?: string[];
    maxSelections?: number;
    /**
     * Numeric constraint for range questions. `step` is an Ekklesia-extension
     * field — absent on standard CIP-179 clients, which can still interpret
     * min/max; when present, auditors can reconstruct the exact valid grid.
     */
    numericConstraints?: {
        minValue: number;
        maxValue: number;
        step?: number;
    };
    /** For ranked questions — number of options that must be ranked. */
    rankCount?: number;
    /** For weighted questions — total points the voter allocates. */
    budget?: number;
    /**
     * For likert questions — discrete rating scale. `step` defaults to 1.
     * Every question option receives one rating on this grid.
     */
    ratingRange?: { min: number; max: number; step?: number };
    /** For custom methods (ranked, weighted, likert) — URI + hash of the schema. */
    methodSchemaUri?: string;
    methodSchemaHash?: string;
}

export interface Cip179SurveyDetails {
    specVersion: string;
    title: string;
    description: string;
    questions: Cip179Question[];
    roleWeighting: RoleWeighting;
    endEpoch: number;
}

export interface Cip179Answer {
    questionId: string;
    selection?: number;
    selections?: number[];
    numericValue?: number;
    customValue?: unknown;
}

export interface Cip179SurveyResponse {
    specVersion: string;
    responderRole: string;
    answers: Cip179Answer[];
}

// ---------------------------------------------------------------------------
// Ekklesia VoteMethod → CIP-179 methodType
// ---------------------------------------------------------------------------

/**
 * Map an Ekklesia vote method to a CIP-179 method type URI.
 * Methods without a standard CIP-179 equivalent use a custom URI.
 */
export function toCip179MethodType(method: VoteMethod): string {
    switch (method) {
        case 'binary':
        case 'single-choice':
            return CIP179_METHOD.SINGLE_CHOICE;
        case 'multi-choice':
            return CIP179_METHOD.MULTI_SELECT;
        case 'range':
            return CIP179_METHOD.NUMERIC_RANGE;
        case 'ranked':
            return 'urn:ekklesia:poll-method:ranked-choice:v1';
        case 'weighted':
            return 'urn:ekklesia:poll-method:weighted-allocation:v1';
        case 'likert':
            return 'urn:ekklesia:poll-method:likert:v1';
    }
}

/**
 * Map a CIP-179 method type URI back to an Ekklesia VoteMethod.
 * Returns undefined for unrecognized URIs.
 */
export function fromCip179MethodType(methodType: string): VoteMethod | undefined {
    switch (methodType) {
        case CIP179_METHOD.SINGLE_CHOICE:
            return 'single-choice';
        case CIP179_METHOD.MULTI_SELECT:
            return 'multi-choice';
        case CIP179_METHOD.NUMERIC_RANGE:
            return 'range';
        case 'urn:ekklesia:poll-method:ranked-choice:v1':
            return 'ranked';
        case 'urn:ekklesia:poll-method:weighted-allocation:v1':
            return 'weighted';
        case 'urn:ekklesia:poll-method:likert:v1':
            return 'likert';
        default:
            return undefined;
    }
}

// ---------------------------------------------------------------------------
// Ekklesia → CIP-179
// ---------------------------------------------------------------------------

/** Convert an Ekklesia BallotQuestion to a CIP-179 question. */
function questionToCip179(q: BallotQuestion): Cip179Question {
    const cip: Cip179Question = {
        questionId: q.questionId,
        question: q.question,
        methodType: toCip179MethodType(q.method),
    };

    if (q.options && q.options.length > 0) {
        cip.options = q.options.map((o) => o.label);
    }

    switch (q.method) {
        case 'multi-choice':
            if (q.maxSelections !== undefined) cip.maxSelections = q.maxSelections;
            break;
        case 'range':
            if (q.valueRange) {
                cip.numericConstraints = {
                    minValue: q.valueRange.min,
                    maxValue: q.valueRange.max,
                    ...(q.valueRange.step !== undefined ? { step: q.valueRange.step } : {}),
                };
            }
            break;
        case 'ranked':
            cip.methodSchemaUri = toCip179MethodType(q.method);
            if (q.rankCount !== undefined) cip.rankCount = q.rankCount;
            break;
        case 'weighted':
            cip.methodSchemaUri = toCip179MethodType(q.method);
            if (q.budget !== undefined) cip.budget = q.budget;
            break;
        case 'likert':
            cip.methodSchemaUri = toCip179MethodType(q.method);
            if (q.ratingRange) {
                cip.ratingRange = {
                    min: q.ratingRange.min,
                    max: q.ratingRange.max,
                    ...(q.ratingRange.step !== undefined ? { step: q.ratingRange.step } : {}),
                };
            }
            break;
    }

    return cip;
}

/**
 * Convert an Ekklesia BallotDefinition to a CIP-179 surveyDetails object.
 * Strips the `ekklesia` extension block.
 */
export function toBallotSurveyDetails(ballot: BallotDefinition): Cip179SurveyDetails {
    return {
        specVersion: ballot.specVersion,
        title: ballot.title,
        description: ballot.description,
        questions: ballot.questions.map(questionToCip179),
        roleWeighting: ballot.roleWeighting,
        endEpoch: ballot.endEpoch,
    };
}

/**
 * Convert an Ekklesia VoteEvidence to a CIP-179 surveyResponse object.
 * Strips the `ekklesia` extension block (signatures, proofs, etc.).
 *
 * Requires the ballot to correctly shape each answer according to its
 * question's method — the unified `VoteSelection.selection` field cannot
 * disambiguate ranked vs. multi-choice or weighted vs. likert on its own.
 */
export function toVoteResponse(
    evidence: VoteEvidence,
    ballot: BallotDefinition,
): Cip179SurveyResponse {
    const methods = new Map(ballot.questions.map((q) => [q.questionId, q.method]));
    return {
        specVersion: evidence.specVersion,
        responderRole: evidence.responderRole,
        answers: evidence.answers.map((a) =>
            selectionToCip179Answer(a, methods.get(a.questionId)),
        ),
    };
}

/** Convert an Ekklesia VoteSelection to a CIP-179 answer, keyed on method. */
function selectionToCip179Answer(
    sel: VoteSelection,
    method: VoteMethod | undefined,
): Cip179Answer {
    const answer: Cip179Answer = { questionId: sel.questionId };
    const raw = sel.selection;

    switch (method) {
        case 'binary':
        case 'single-choice': {
            const values = raw as number[];
            if (values.length === 1) answer.selection = values[0];
            break;
        }
        case 'multi-choice': {
            answer.selections = raw as number[];
            break;
        }
        case 'range': {
            const values = raw as number[];
            if (values.length === 1) answer.numericValue = values[0];
            break;
        }
        case 'ranked': {
            answer.customValue = { type: 'ranked', ranking: raw as number[] };
            break;
        }
        case 'weighted': {
            answer.customValue = { type: 'weighted', allocations: raw };
            break;
        }
        case 'likert': {
            answer.customValue = { type: 'likert', ratings: raw };
            break;
        }
        default:
            // Unknown method — emit the raw selection so the evidence round-trip
            // is still lossless for downstream CIP-179 consumers.
            answer.customValue = { type: 'unknown', selection: raw };
    }

    return answer;
}

// ---------------------------------------------------------------------------
// CIP-179 → Ekklesia
// ---------------------------------------------------------------------------

/**
 * Convert a CIP-179 surveyDetails to an Ekklesia BallotDefinition.
 * The `ekklesia` extension block is populated with empty/default values
 * and must be filled in manually by the caller.
 */
export function fromSurveyDetails(survey: Cip179SurveyDetails): BallotDefinition {
    return {
        specVersion: survey.specVersion,
        title: survey.title,
        description: survey.description,
        questions: survey.questions.map(questionFromCip179),
        roleWeighting: survey.roleWeighting,
        endEpoch: survey.endEpoch,
        ekklesia: {
            namespace: '',
            votingAuthority: '',
            context: 'hydra-head',
            acceptedCredentials: [],
            merkleRoot: '',
            ballotIpfsCid: '',
            votingWindow: { open: '', close: '' },
        },
    };
}

/** Convert a CIP-179 question to an Ekklesia BallotQuestion. */
function questionFromCip179(q: Cip179Question): BallotQuestion {
    const method = fromCip179MethodType(q.methodType) ?? 'single-choice';

    const result: BallotQuestion = {
        questionId: q.questionId,
        question: q.question,
        method,
    };

    if (q.options) {
        result.options = q.options.map((label, i) => ({ label, value: i }));
    }

    if (q.maxSelections !== undefined) {
        result.maxSelections = q.maxSelections;
    }

    if (q.numericConstraints) {
        result.valueRange = {
            min: q.numericConstraints.minValue,
            max: q.numericConstraints.maxValue,
            ...(q.numericConstraints.step !== undefined ? { step: q.numericConstraints.step } : {}),
        };
    }

    if (q.rankCount !== undefined) {
        result.rankCount = q.rankCount;
    }

    if (q.budget !== undefined) {
        result.budget = q.budget;
    }

    if (q.ratingRange) {
        result.ratingRange = {
            min: q.ratingRange.min,
            max: q.ratingRange.max,
            ...(q.ratingRange.step !== undefined ? { step: q.ratingRange.step } : {}),
        };
    }

    return result;
}
