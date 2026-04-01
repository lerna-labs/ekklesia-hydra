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
    numericConstraints?: {
        minValue: number;
        maxValue: number;
    };
    /** For custom methods (ranked, weighted) — URI + hash of the schema. */
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
    surveyTxId: string;
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

    // Map options (CIP-179 uses string labels, not value objects)
    if (q.options && q.options.length > 0) {
        cip.options = q.options.map((o) => o.label);
    }

    if (q.method === 'multi-choice' && q.maxSelections !== undefined) {
        cip.maxSelections = q.maxSelections;
    }

    if (q.method === 'range' && q.valueRange) {
        cip.numericConstraints = {
            minValue: q.valueRange.min,
            maxValue: q.valueRange.max,
        };
    }

    // Custom methods get schema URIs
    if (q.method === 'ranked' || q.method === 'weighted') {
        cip.methodSchemaUri = toCip179MethodType(q.method);
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
 */
export function toVoteResponse(evidence: VoteEvidence): Cip179SurveyResponse {
    return {
        specVersion: evidence.specVersion,
        surveyTxId: evidence.surveyTxId,
        responderRole: evidence.responderRole,
        answers: evidence.answers.map(selectionToCip179Answer),
    };
}

/** Convert an Ekklesia VoteSelection to a CIP-179 answer. */
function selectionToCip179Answer(sel: VoteSelection): Cip179Answer {
    const answer: Cip179Answer = { questionId: sel.questionId };

    if (sel.selection !== undefined) {
        if (sel.selection.length === 1) {
            // Single value — could be single-choice or range
            answer.selection = sel.selection[0];
        } else {
            // Multiple values — multi-choice
            answer.selections = sel.selection;
        }
    }

    if (sel.ranking !== undefined) {
        answer.customValue = { type: 'ranked', ranking: sel.ranking };
    }

    if (sel.weights !== undefined) {
        answer.customValue = { type: 'weighted', weights: sel.weights };
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
        };
    }

    return result;
}
