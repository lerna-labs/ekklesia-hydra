// ---------------------------------------------------------------------------
// Ballot-definition validation
// ---------------------------------------------------------------------------
//
// Structural validation for a BallotDefinition, shared by the two places a
// ballot enters the system:
//   - POST /prepare (ballot.ts) — before minting the (600)/(601) pair on L1.
//   - POST /start and session rehydrate (lifecycle.ts) — before a ballot
//     fetched from IPFS is cached and used for voting/tallying.
//
// Kept in its own module (not in a route file) so both callers can import it
// without a route↔route import cycle, and so it is unit-testable without pulling
// in MeshSDK / Blockfrost.

import type { BallotDefinition, BallotQuestion } from './types.js';
import { ROLE_TOKEN_TAG } from './types.js';

/** Roles permitted in ballot.roleWeighting. Matches the HRP_TO_ROLE range. */
const ALLOWED_ROLES = new Set(['drep', 'pool', 'stake']);

/**
 * Per-role allowed power-source modes, matching the RoleWeighting type in
 * types.ts. Each (role, mode) pair must independently satisfy this map —
 * e.g. `stake: PledgeBased` is nonsensical and must be rejected.
 */
const ALLOWED_MODES_BY_ROLE: Record<string, Set<string>> = {
    drep: new Set(['CredentialBased', 'StakeBased']),
    pool: new Set(['CredentialBased', 'StakeBased', 'PledgeBased']),
    stake: new Set(['CredentialBased', 'StakeBased']),
};

/**
 * Check a single {min, max, step} grid config for a range or rating scale:
 * all three must be integers, step must be positive, and `(max - min) % step`
 * must be zero so `max` is actually reachable on the grid. Returns an error
 * string or null.
 */
function validateGrid(
    label: string,
    grid: { min: number; max: number; step?: number },
): string | null {
    const step = grid.step ?? 1;
    if (!Number.isInteger(grid.min) || !Number.isInteger(grid.max) || !Number.isInteger(step)) {
        return `${label}: min, max, and step must all be integers`;
    }
    if (step <= 0) {
        return `${label}: step must be a positive integer`;
    }
    if (grid.max < grid.min) {
        return `${label}: max (${grid.max}) must be >= min (${grid.min})`;
    }
    if ((grid.max - grid.min) % step !== 0) {
        return `${label}: (max - min) must be divisible by step — ${grid.max} - ${grid.min} is not a multiple of ${step}`;
    }
    return null;
}

/**
 * Validate a question's options: every value must be a non-negative integer
 * and values must be unique within the question's options set.
 */
function validateOptions(
    label: string,
    options: BallotQuestion['options'],
): string | null {
    if (!options) return null;
    const seen = new Set<number>();
    for (const o of options) {
        if (typeof o.value !== 'number' || !Number.isInteger(o.value) || o.value < 0) {
            return `${label}: option values must be non-negative integers (got ${o.value})`;
        }
        if (seen.has(o.value)) {
            return `${label}: duplicate option value ${o.value}`;
        }
        seen.add(o.value);
    }
    return null;
}

/**
 * Validate the questions array of a BallotDefinition before minting. Enforces
 * method-level structural requirements so broken ballots never get locked
 * on-chain. Returns an error message string on failure, or null on success.
 */
export function validateBallotDefinition(ballot: BallotDefinition): string | null {
    // Role space: only `drep`, `pool`, `stake` are recognized in roleWeighting.
    // Each (role, mode) pair must also satisfy the per-role allowed-mode set
    // — e.g. `stake: PledgeBased` is nonsensical and is rejected here rather
    // than silently tally'd as a StakeBased stake role downstream.
    if (ballot.roleWeighting) {
        const rw = ballot.roleWeighting as Record<string, string>;
        for (const role of Object.keys(rw)) {
            if (!ALLOWED_ROLES.has(role)) {
                return `roleWeighting contains unrecognized role "${role}" — only ${Array.from(ALLOWED_ROLES).join(', ')} are accepted (earlier variants DRep/SPO/Stakeholder/CC have been dropped)`;
            }
            const mode = rw[role];
            const allowed = ALLOWED_MODES_BY_ROLE[role];
            if (!allowed.has(mode)) {
                return `roleWeighting.${role} has invalid mode "${mode}" — allowed for "${role}": ${Array.from(allowed).join(', ')}`;
            }
        }
    }

    // acceptedCredentials must reference bech32 HRPs Hydra recognizes.
    const accepted = ballot.ekklesia?.acceptedCredentials;
    if (accepted && Array.isArray(accepted)) {
        const allowedHrps = new Set(Object.keys(ROLE_TOKEN_TAG));
        for (const hrp of accepted) {
            if (!allowedHrps.has(hrp)) {
                return `ekklesia.acceptedCredentials contains unrecognized HRP "${hrp}" — allowed: ${Array.from(allowedHrps).join(', ')}`;
            }
        }
    }

    if (!Array.isArray(ballot.questions) || ballot.questions.length === 0) {
        return 'Ballot must contain at least one question';
    }
    const ids = new Set<string>();
    for (const q of ballot.questions as BallotQuestion[]) {
        if (!q.questionId) return 'Every question must have a questionId';
        if (ids.has(q.questionId)) return `Duplicate questionId: "${q.questionId}"`;
        ids.add(q.questionId);

        // Reject the legacy opt-in abstain flag. It was replaced by
        // `requireAnswer` (opt-out) with inverted semantics — silently
        // honoring abstainAllowed:false would be dangerous, so fail loudly.
        if ((q as unknown as Record<string, unknown>).abstainAllowed !== undefined) {
            return `"${q.questionId}" uses legacy field "abstainAllowed" — replaced by "requireAnswer" with inverted semantics (abstain is now allowed by default; set requireAnswer:true only to force an answer)`;
        }

        // Optional content-hash commitment. Hydra treats the hash as opaque
        // bytes; we only enforce the format so invalid commitments can't
        // sneak into the merkle root.
        if (q.contentHash !== undefined) {
            if (typeof q.contentHash !== 'string') {
                return `"${q.questionId}" contentHash must be a string`;
            }
            if (!/^[0-9a-f]{64}$/.test(q.contentHash)) {
                return `"${q.questionId}" contentHash must be exactly 64 lowercase hex characters (blake2b_256)`;
            }
        }

        // All questions: validate option value integrity if options are present.
        if (q.options) {
            const optErr = validateOptions(`"${q.questionId}" options`, q.options);
            if (optErr) return optErr;
        }

        if (q.method === 'range') {
            if (!q.valueRange) {
                return `"${q.questionId}" is range but has no valueRange defined`;
            }
            const err = validateGrid(`"${q.questionId}" valueRange`, q.valueRange);
            if (err) return err;
        }

        if (q.method === 'likert') {
            if (!q.ratingRange) {
                return `"${q.questionId}" is likert but has no ratingRange defined`;
            }
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
                return `"${q.questionId}" multi-choice: minSelections must be a positive integer (empty selections disallowed — voters use abstain:true to skip, or set requireAnswer:true to force a pick)`;
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
