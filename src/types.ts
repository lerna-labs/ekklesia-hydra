// ---------------------------------------------------------------------------
// CIP-67 Asset Name Label Prefixes (Ekklesia Ballot Standard)
// ---------------------------------------------------------------------------

/** CIP-67 encoded prefix for label 600 — Ballot Definition (stays on L1). */
export const BALLOT_DEFINITION_PREFIX = '00258a50';

/** CIP-67 encoded prefix for label 601 — Ballot Instance (enters Hydra head, returns with results). */
export const BALLOT_INSTANCE_PREFIX = '00259a20';

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/**
 * Evidence/results protocol version stamped into every vote-evidence bundle
 * (`VoteEvidence.specVersion`) and results object (`FullResults.specVersion`)
 * this middleware produces. This is the *protocol* version of the on-disk /
 * IPFS artifact shape and hashing contract — distinct from
 * `BallotDefinition.specVersion`, which is the ballot author's own version.
 *
 * Versioning contract: changes to how a vote is represented, hashed, encoded,
 * or identified ship as a NEW protocol version, never as an in-place mutation.
 * Two ballots have already settled under the previous versions (hydra `'0.3.0'`
 * and backend `'ekklesia/1.0'`); those artifacts must remain verifiable
 * byte-for-byte by replay tooling keyed off their declared version. This
 * middleware always produces the current version (one head, one ballot — no old
 * artifact is ever re-minted here); old-version replay lives in external audit
 * tooling.
 */
export const PROTOCOL_VERSION = 'ekklesia/2.0';

// ---------------------------------------------------------------------------
// Bech32 HRP → Voter-Token Role Tag
// ---------------------------------------------------------------------------

/**
 * Maps a bech32 voter HRP to the 1-byte tag prepended to its voter-token asset
 * name. This is an internal Ekklesia role tag, NOT a literal CIP bech32 first
 * byte — e.g. `stake` and `stake_test` deliberately share `0xe0` because they
 * are the same tally role (a real CIP-19 mainnet reward address starts `0xe1`,
 * which is irrelevant here). Renamed from `CREDENTIAL_PREFIX` to make that
 * explicit (audit finding F-012).
 *
 * Voter token asset name = <tag byte><blake2b_224(bech32_decoded_data)> (29 bytes)
 *
 * Only `drep`, `pool`, `stake`, `stake_test` are accepted as voter IDs.
 * Payment-stake composite addresses (addr / addr_test) are intentionally
 * excluded: the signing key only verifies a particular payment address and can
 * be spoofed against a stake credential, which is of limited use in a voting
 * platform.
 *
 * `calidus` is deliberately NOT a voter identity. A calidus key is an SPO hot
 * key authorized for a pool's cold key; an SPO voting with it submits `voterId`
 * as the pool (`pool1...`) and supplies the calidus key only as a signing
 * witness (`calidusDeclaration`). Tokenizing `calidus1...` separately would give
 * one operator two distinct voter tokens — one under the pool ID and one under
 * the calidus key hash — both tallying as `pool`, i.e. a double vote. The pool
 * ID is the single canonical SPO identity.
 */
export const ROLE_TOKEN_TAG: Record<string, number> = {
    drep: 0x22,
    stake: 0xe0,
    stake_test: 0xe0,
    pool: 0x06,
};

/** All recognized bech32 HRPs for voter identification. */
export type VoterHrp = keyof typeof ROLE_TOKEN_TAG;

/**
 * Map bech32 HRP to tally role. Roles are lowercase and form the canonical
 * three-group voter space: `drep`, `pool`, `stake`. `stake_test` is just
 * the testnet prefix for stake credentials and collapses into the same
 * role. There is no `calidus` entry: an SPO voting with a calidus hot key
 * submits as the pool (`voterId = pool1...`), so its `credentialHrp` is
 * already `pool` and it tallies under `pool` without a separate mapping.
 */
export const HRP_TO_ROLE: Record<string, string> = {
    drep: 'drep',
    pool: 'pool',
    stake: 'stake',
    stake_test: 'stake',
};

/**
 * Resolve a bech32 HRP to its canonical tally role, or `null` if the HRP is not
 * a recognized voter credential.
 *
 * Callers must fail closed on `null` rather than coercing to a default role.
 * Silently mapping a missing or unrecognized HRP to a real role (the old
 * `?? 'drep'`) miscounts the role-weighted tally, and trusting an
 * evidence-supplied `responderRole` (the old `?? evidence.responderRole`) lets
 * out-of-band evidence pick its own bucket (audit findings F-010/F-011).
 *
 * Note there is intentionally no `drep_test` / `calidus_test`: CIP-129 governance
 * credentials use the `drep` HRP on every network (no testnet variant); only
 * CIP-19 stake reward addresses are network-tagged, and `stake_test` is already
 * mapped above.
 */
export function resolveRole(hrp: string | undefined | null): string | null {
    if (!hrp) return null;
    return HRP_TO_ROLE[hrp] ?? null;
}

// ---------------------------------------------------------------------------
// Ballot Definition — (600) token datum, immutable on L1
// ---------------------------------------------------------------------------

/** A single option within a ballot question. Value is always an integer. */
export interface BallotOption {
    label: string;
    value: number;
}

/**
 * Voting method types supported by Ekklesia.
 *
 * - binary:        yes/no/abstain — options with fixed values (shorthand for single-choice)
 * - single-choice: pick exactly 1 from options
 * - multi-choice:  pick between minSelections and maxSelections from options
 * - range:         submit an integer within valueRange (e.g., "rate -5 to +5")
 * - ranked:        order options by preference — position in array = rank
 * - weighted:      distribute a point budget across options (weights must sum to budget)
 * - likert:        independently rate each option on a discrete integer scale (ratingRange)
 */
export type VoteMethod =
    | 'binary'
    | 'single-choice'
    | 'multi-choice'
    | 'range'
    | 'ranked'
    | 'weighted'
    | 'likert';

/**
 * A ballot question. The `method` field determines how selections are
 * interpreted and validated.
 */
export interface BallotQuestion {
    questionId: string;
    question: string;
    description?: string;
    /** Voting method — determines selection shape and validation rules. */
    method: VoteMethod;
    /** Available options with integer values (used by all methods except range). */
    options?: BallotOption[];
    /** Minimum selections required (default 1). Applies to binary, single, multi. */
    minSelections?: number;
    /** Maximum selections allowed. Applies to multi-choice (default: options.length). */
    maxSelections?: number;
    /**
     * For range questions — voter submits an integer within this range.
     * Required when method is 'range'. Valid values are the arithmetic grid
     * { min, min+step, min+2*step, …, max } (step defaults to 1). All three
     * fields must be integers and `(max - min) % step === 0`.
     */
    valueRange?: { min: number; max: number; step?: number };
    /**
     * For ranked questions — how many options must be ranked.
     * Defaults to options.length (must rank all).
     */
    rankCount?: number;
    /**
     * For weighted questions — total points the voter must allocate.
     * Weights submitted must sum to exactly this value.
     */
    budget?: number;
    /**
     * For likert questions — the discrete integer scale each option is rated
     * on. Every option must receive one integer rating on the grid
     * { min, min+step, …, max } (step defaults to 1). All three fields must
     * be integers and `(max - min) % step === 0`.
     */
    ratingRange?: { min: number; max: number; step?: number };
    /**
     * If true, voters MUST submit a selection on this question — `abstain:
     * true` is rejected. Default is false, meaning abstention is allowed by
     * default and only explicitly disallowed for "must answer" questions.
     * Orthogonal to having an "Abstain" option in `options`, which is a
     * regular selection that shows up in per-option counts.
     */
    requireAnswer?: boolean;
    /**
     * Optional blake2b_256 digest (64 lowercase hex chars) of the question's
     * voter-facing content blob — per-proposal summary, rationale, authors,
     * version, per-option descriptions / reference URLs / image URLs /
     * metadata, etc. The backend owns the canonical byte layout and hash
     * computation; Hydra treats this as an opaque commitment.
     *
     * When present, the field participates in the question's JSON-stringified
     * merkle leaf and therefore in `ekklesia.merkleRoot`, anchoring the
     * content on-chain via the (600) datum. When absent, the question is
     * committed without content-hash protection.
     *
     * Hydra does not fetch, interpret, or pin the underlying content — it
     * only validates the hash format (64-char lowercase hex) at
     * ballot-prepare time.
     */
    contentHash?: string;
}

/** Ekklesia-specific extension fields on the ballot definition. */
export interface EkklesiaBallotExtension {
    /** Fingerprint source — e.g., "vote.ekklesia.intersect.budget2026". The middleware overwrites this from the `/prepare` request field. */
    namespace: string;
    /**
     * Informational bech32 address of the intended voting authority.
     * Note: the on-chain (600) datum always records the middleware's admin
     * address here, not this value — so this field is advisory metadata in
     * the IPFS-pinned ballot, not a security-relevant commitment.
     */
    votingAuthority: string;
    /** Fixed marker — voting happens inside a Hydra head. */
    context: 'hydra-head';
    /** Bech32 HRPs permitted to register (e.g., ["drep", "pool", "stake"]). */
    acceptedCredentials: string[];
    /** blake2b_256 merkle root of ballot content, hex. Filled in by the middleware. */
    merkleRoot: string;
    /** IPFS CID of the pinned ballot JSON. Filled in by the middleware. */
    ballotIpfsCid: string;
    /** Voting window timestamps (ISO-8601 UTC). `open` is also the timelock anchor for the minting policy. */
    votingWindow: {
        open: string;
        close: string;
    };
}

/**
 * CIP-179 role weighting configuration.
 * Maps role names to their weighting mode. Only `drep`, `pool`, and
 * `stake` are recognized — the canonical three-group voter space.
 * Earlier variants (`DRep`, `SPO`, `Stakeholder`, `CC`) are not accepted
 * and are rejected at `/prepare` if present in a ballot definition.
 */
export interface RoleWeighting {
    drep?: 'CredentialBased' | 'StakeBased';
    pool?: 'CredentialBased' | 'StakeBased' | 'PledgeBased';
    stake?: 'CredentialBased' | 'StakeBased';
}

/**
 * Full ballot definition — stored on IPFS, NOT on-chain.
 * CIP-179 surveyDetails core fields + Ekklesia extension block.
 */
export interface BallotDefinition {
    // CIP-179 core
    specVersion: string;
    title: string;
    description: string;
    questions: BallotQuestion[];
    roleWeighting: RoleWeighting;
    endEpoch: number;

    // Ekklesia extension
    ekklesia: EkklesiaBallotExtension;
}

/**
 * On-chain (600) ballot definition datum.
 *
 * Plutus shape: `Constr 0 [List<Bytes>, Int]`
 *
 * The outer structure is always a two-field Constr 0:
 *   - Field 0: an ordered list of byte strings (the `fields` below).
 *   - Field 1: a schema version integer.
 *
 * All string-typed fields are encoded as UTF-8 bytes on-chain; hash and
 * CID fields are their raw bytes (not hex-re-encoded). `questionCount`
 * and `endEpoch` are encoded as Plutus `Int`s within the bytes list — see
 * `src/routes/ballot.ts` for the exact mint-time construction.
 *
 * Version history:
 *   1 — original mint (`/prepare`)
 *   2 — edited via `/prepare/update` before the head opened
 */
export interface BallotDefinitionDatum {
    fields: {
        /** Short title for on-chain identification. */
        title: string;
        /** Ekklesia namespace (e.g., "vote.ekklesia.intersect.budget2026"). */
        namespace: string;
        /** Voting authority address (bech32). */
        votingAuthority: string;
        /** blake2b_256 merkle root of the ballot content (questions/options), hex. */
        contentHash: string;
        /** IPFS CID of the full BallotDefinition JSON. */
        ballotCid: string;
        /** Number of questions in the ballot. */
        questionCount: number;
        /** Voting window open (ISO-8601 UTC). */
        votingWindowOpen: string;
        /** Voting window close (ISO-8601 UTC). */
        votingWindowClose: string;
        /** Cardano epoch at which voting ends. */
        endEpoch: number;
    };
    version: number;
}

// ---------------------------------------------------------------------------
// Ballot Result — (601) token datum, travels through Hydra head
// ---------------------------------------------------------------------------

/**
 * On-chain (601) ballot instance datum — the same type is used both pre-head
 * (empty fields, mint-time placeholder) and post-finalize (results summary).
 *
 * Plutus shape: `Constr 0 [List<Bytes>, Int]`
 *
 * Matches the Tx3 `BallotResult` type:
 *   ```
 *   type BallotResult {
 *       Fields: List<Bytes>,
 *       Version: Int,
 *   }
 *   ```
 *
 * Fields are positional — decoders MUST respect the order below.
 * On-chain bytes are raw UTF-8 for strings/CIDs and raw hex-decoded
 * bytes for hashes; `Version` is a Plutus `Int`.
 *
 * Version history:
 *   1 — mint-time placeholder (all four byte fields empty) AND finalized state
 *   2 — edited via `/prepare/update` before the head opened (placeholder state)
 */
export interface BallotResultDatum {
    fields: {
        /** Ballot identifier (ULID or tx hash). Empty string pre-finalize. */
        ballotId: string;
        /** blake2b_256 of the canonical FullResults JSON on IPFS. Empty pre-finalize. */
        resultsHash: string;
        /** IPFS directory CID for the complete evidence package. Empty pre-finalize. */
        evidenceCid: string;
        /** Merkle root of all vote evidence files. Empty pre-finalize. */
        merkleRoot: string;
    };
    version: number;
}

// ---------------------------------------------------------------------------
// Full Results — stored on IPFS, pointed to by BallotResultDatum.fields.evidenceCid
// ---------------------------------------------------------------------------

/**
 * Per-option count — the base tally entry for the simple selection methods
 * (binary, single-choice, multi-choice) and for the first-preference
 * breakdown within ranked results.
 *
 * Hydra never emits voter weights or weighting modes — post-hoc stake / role
 * weighting is applied by the voting authority using their own snapshots, so
 * results.json publishes raw participation only.
 */
export interface OptionCount {
    option: number;
    count: number;
}

/** Distribution entry for a range question — one bucket per observed value. */
export interface DistributionEntry {
    value: number;
    count: number;
}

/**
 * Pairwise preference matrix for ranked questions. `matrix[i][j]` is the
 * number of ballots on which `options[i]` was ranked above `options[j]`.
 * `matrix[i][i]` is always 0. Raw pairwise preference counts — Condorcet,
 * Copeland, Schulze, Ranked Pairs, Borda and every other pairwise-family
 * method are computable from this without re-reading evidence.
 */
export interface PairwiseMatrix {
    options: number[];
    matrix: number[][];
}

/**
 * Per-option aggregate for a weighted-allocation question.
 *
 * Only raw quantities: `totalPoints` is the direct arithmetic sum of
 * voter-submitted allocations, `voterCount` is the count of ballots with
 * a non-zero allocation. Mean / stdDev / normalized scores are up to
 * downstream consumers.
 */
export interface WeightedOptionTally {
    option: number;
    /** Sum of points allocated to this option across all ballots. */
    totalPoints: number;
    /** Number of ballots that allocated a non-zero amount to this option. */
    voterCount: number;
}

/**
 * Per-option aggregate for a likert-rated question.
 *
 * Only raw quantities: `count` is the number of ballots that rated this
 * option, `distribution` is the per-rating histogram zero-filled across
 * the full `ratingRange` grid. Mean / median / mode are up to downstream
 * consumers.
 */
export interface LikertOptionTally {
    option: number;
    /** Number of ballots that rated this option (equals n for valid ballots). */
    count: number;
    /** Histogram of rating → number of voters who assigned it. */
    distribution: Record<number, number>;
}

/**
 * Method-shaped tally payload for a single role on a single question.
 * Discriminated on `method`; consumers narrow before reading method-specific
 * fields.
 *
 * Only raw cryptographic counts are emitted — per-option counts, per-value
 * histograms, first-preference counts, pairwise preference matrices,
 * per-option point totals. Statistical aggregations (mean, median, mode,
 * stdDev, Borda scores, etc.) are deliberately omitted: any such summary
 * is an opinionated interpretation of which option "won" and belongs to
 * downstream consumers/auditors, not to Hydra.
 */
export type MethodTally =
    | { method: 'binary' | 'single-choice' | 'multi-choice'; results: OptionCount[] }
    | { method: 'range'; distribution: DistributionEntry[] }
    | { method: 'ranked'; firstPreference: OptionCount[]; pairwise: PairwiseMatrix }
    | { method: 'weighted'; results: WeightedOptionTally[] }
    | { method: 'likert'; results: LikertOptionTally[] };

/**
 * Tally for one question across all applicable roles.
 * The question-level `method` matches every `roleResults[role].method`.
 */
export interface QuestionTally {
    questionId: string;
    method: VoteMethod;
    roleResults: Record<string, MethodTally>;
    /**
     * Per-role counts of voters who explicitly abstained on this question
     * (`abstain: true`). Abstainers do NOT contribute to any `MethodTally`
     * aggregate. Omitted when no abstentions were recorded.
     * The `"raw"` key aggregates across all roles.
     */
    abstainedByRole?: Record<string, number>;
}

/**
 * One entry on a backend `results[]` array — the wire shape consumed by
 * `Result.results` and `Result.resultsByGroup[role].results` on the backend.
 *
 * `id` is the option value rendered as a string, or the literal `"abstain"`.
 * `votingPower` is always 0 — Hydra emits raw counts only and leaves
 * stake-weighting to the voting authority's post-hoc adjustment document.
 */
export interface BackendOptionResult {
    id: string;
    label?: string;
    count: number;
    votingPower: 0;
}

/** Per-group bucket on `BackendTally.resultsByGroup` — mirrors backend cron output. */
export interface BackendGroupTally {
    /** Distinct voter count for this question in this role (includes abstainers). */
    totalVotes: number;
    /** Per-option count rows. Empty for `range` (consult `scale.distribution`). */
    results: BackendOptionResult[];
    /** Range histogram. Present only when question method is `range`. */
    scale?: { distribution: DistributionEntry[] };
    /** Ranked-method extension. Present only when question method is `ranked`. */
    ranked?: { firstPreference: OptionCount[]; pairwise: PairwiseMatrix };
    /** Likert-method extension. Present only when question method is `likert`. */
    likert?: { results: LikertOptionTally[] };
    /** Weighted-method extension. Present only when question method is `weighted`. */
    weighted?: { results: WeightedOptionTally[] };
}

/**
 * Backend-shaped tally for one question — the value type of
 * `FinalizeResponse.tallies[questionId]`.
 *
 * `results` aggregates across every role (the `"raw"` bucket internally);
 * `resultsByGroup` contains one entry per role declared on the ballot or
 * observed in evidence. Method-specific extension fields hang off each
 * group bucket.
 */
export interface BackendTally {
    results: BackendOptionResult[];
    resultsByGroup: Record<string, BackendGroupTally>;
}

/**
 * Complete results object stored on IPFS.
 * Hash of this (blake2b_256 of canonical JSON) = on-chain resultsHash.
 *
 * Two parallel tally views are emitted:
 *   - `tallies` is the wire shape consumed by the Ekklesia backend
 *     (`writeFinalResult` in the 10-min aggregate cron) — keyed by
 *     `questionId`, with method-specific extension fields per role.
 *   - `questionTallies` is the canonical auditor shape: discriminated
 *     union per method, fully zero-filled, deterministic. Auditors who
 *     replay the tally from the evidence directory must match this
 *     shape byte-for-byte.
 */
export interface FullResults {
    specVersion: string;
    ballotId: string;
    /** Backend wire shape — keyed by questionId. */
    tallies: Record<string, BackendTally>;
    /** Canonical auditor breakdown — discriminated by method, role-bucketed. */
    questionTallies: QuestionTally[];
    totalVoters: number;
    headId: string;
    finalizedAt: string;
    /** Per-role voter counts (e.g., { drep: 800, pool: 200 }). */
    votersByRole?: Record<string, number>;
    /** Voters excluded from results — on-chain token existed but evidence could not be verified. */
    excludedVoters?: Array<{ tokenName: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Voter Token Datum — slim, in-head only
// ---------------------------------------------------------------------------

/**
 * On-chain voter token datum — in-head only, burned before settlement.
 *
 * Plutus shape: `Constr 0 [Bytes, Int, Bytes, Bytes, Bytes]`
 *
 * Matches the Tx3 `Vote` type:
 *   ```
 *   type Vote {
 *       VoterId: Bytes,
 *       Version: Int,
 *       MerkleRoot: Bytes,
 *       VoteHash: Bytes,
 *       IpfsCid: Bytes,
 *   }
 *   ```
 *
 * Fields are positional (not nested in a list). Decoders MUST respect the
 * order below.
 *
 * Version numbering:
 *   0 — set by `register_voter` (voter registered but hasn't voted yet)
 *   N≥1 — monotonic vote nonce; must strictly exceed the prior on-chain
 *         version on each update (replay protection).
 */
export interface VoterDatum {
    /** Voter token asset name: 29 bytes = 1-byte credential prefix + 28-byte blake2b_224 of bech32 data. 58 hex chars. */
    voterId: string;
    /** Monotonic nonce — must match the `nonce` field of the signed payload. */
    version: number;
    /** blake2b_256 of the canonical signed payload JSON (the message verified against the COSE signature). Empty bytes on register. */
    merkleRoot: string;
    /** blake2b_256 of full VoteEvidence JSON on IPFS. Empty bytes on register. */
    voteHash: string;
    /** IPFS CID pointing to full VoteEvidence. Empty bytes on register. */
    ipfsCid: string;
}

// ---------------------------------------------------------------------------
// Signed Vote Payload — what the voter's COSE key signs
// ---------------------------------------------------------------------------

/**
 * A per-option scalar entry — the shape used by `weighted` (value = points
 * allocated) and `likert` (value = rating on the ratingRange grid).
 */
export interface SelectionEntry {
    option: number;
    value: number;
}

/**
 * An individual answer to a ballot question.
 *
 * Either `abstain: true` is set (voter participated but expressed no
 * preference — allowed by default unless question has `requireAnswer: true`) or `selection`
 * is present. The two are mutually exclusive.
 *
 * The `selection` payload shape is determined by the question's `method`:
 *   - binary / single-choice / multi-choice: number[] of chosen option values.
 *   - range:                                 number[] of length 1 — the picked value on the valueRange grid.
 *   - ranked:                                number[] of option values in preference order (index 0 = 1st preference).
 *   - weighted:                              SelectionEntry[] — `value` is points allocated, must sum to budget.
 *   - likert:                                SelectionEntry[] — `value` is rating on the ratingRange grid, one entry per option.
 *
 * The validator and tally both switch on the question's method; the field
 * name is unified so consumers have a single place to read the answer.
 */
export interface VoteSelection {
    questionId: string;
    /**
     * If true, the voter participated on this question but expressed no
     * preference. `selection` must be absent. Allowed by default; rejected
     * only on questions flagged with `requireAnswer: true`.
     */
    abstain?: true;
    /** Required unless `abstain === true`. Shape determined by method. */
    selection?: number[] | SelectionEntry[];
}

/**
 * The exact payload the voter signs with their COSE key.
 * The nonce provides replay protection (must exceed current on-chain version).
 */
export interface SignedVotePayload {
    ballotId: string;
    nonce: number;
    votes: VoteSelection[];
}

// ---------------------------------------------------------------------------
// Vote Evidence — full bundle stored on IPFS
// ---------------------------------------------------------------------------

/**
 * A single COSE witness — one signer's signature + key.
 *
 * The middleware only consumes `coseSign1Hex` and `coseKeyHex` for
 * verification. `key` and `signature` are legacy / duplicative fields
 * (the raw public-key hex and raw signature hex, as returned by some
 * CIP-30 `signData` implementations) — carried through to the IPFS
 * evidence bundle for downstream consumers but not read by this service.
 */
export interface CoseWitness {
    coseSign1Hex: string;
    coseKeyHex: string;
    key: string;
    signature: string;
}

/**
 * Signature data submitted with a vote.
 *
 * For key-based credentials: provide a single witness in the top-level fields.
 * For script-based credentials: provide `nativeScript` (the script definition)
 * and `witnesses` (one CoseWitness per signing key needed to satisfy the script).
 *
 * The API accepts either shape — single-key is a convenience shorthand.
 */
/**
 * CIP-151 Calidus key declaration.
 *
 * When an SPO votes using a calidus hot key instead of their pool cold key,
 * the voter ID is still the pool bech32 (pool1...). The calidus key is only
 * the signing witness — included in the evidence package so auditors can
 * verify the CIP-151 on-chain registration binding (calidus key → pool ID).
 */
export interface CalidusDeclaration {
    /** bech32 calidus key ID (calidus1...) — the hot key that signed the vote. */
    calidusId: string;
}

export interface VoteSignatureData extends Partial<CoseWitness> {
    /** For script-based DReps: the native script definition. */
    nativeScript?: NativeScriptDef;
    /** For script-based DReps: all witness signatures needed to satisfy the script. */
    witnesses?: CoseWitness[];
    /** For CIP-151 calidus key votes: declares which pool this key represents. */
    calidusDeclaration?: CalidusDeclaration;
}

/**
 * Portable native script definition (matches @meshsdk/common NativeScript type).
 * Kept as our own type to avoid coupling the types file to meshsdk.
 */
export type NativeScriptDef =
    | { type: 'sig'; keyHash: string }
    | { type: 'all' | 'any'; scripts: NativeScriptDef[] }
    | { type: 'atLeast'; required: number; scripts: NativeScriptDef[] }
    | { type: 'after' | 'before'; slot: string };

/** Ekklesia-specific fields within the IPFS evidence bundle. */
export interface EkklesiaVoteExtension {
    /** Original bech32 voter ID. */
    voterId: string;
    /** Bech32 HRP used to derive credential prefix (e.g., "drep", "stake"). */
    credentialHrp: string;
    /** Monotonic nonce matching the on-chain version. */
    nonce: number;
    /** The exact payload that was signed (for independent verification). */
    signedPayload: SignedVotePayload;
    /**
     * For key-based credentials: single witness.
     * For script-based credentials: all witnesses that satisfied the script.
     */
    witnesses: CoseWitness[];
    /** For script-based credentials: the native script definition used for verification. */
    nativeScript?: NativeScriptDef;
    /** For CIP-151 calidus key votes: identifies the hot key that signed on behalf of the pool. */
    calidusDeclaration?: CalidusDeclaration;
    merkleProof: {
        root: string;
        steps: Array<{ siblingHex: string }>;
    };
}

/**
 * Full vote evidence stored on IPFS.
 * CIP-179 surveyResponse core fields + Ekklesia extension block.
 * Hash of this (blake2b_256 of canonical JSON) = on-chain voteHash.
 */
export interface VoteEvidence {
    // CIP-179 core
    specVersion: string;
    /**
     * The L1 transaction that anchors this ballot (defaults to `ballotId`).
     * Present in every bundle so the hydra and backend evidence producers emit
     * the same top-level shape (audit finding F-007).
     */
    surveyTxId: string;
    responderRole: string;
    answers: VoteSelection[];

    // Ekklesia extension
    ekklesia: EkklesiaVoteExtension;
}

// ---------------------------------------------------------------------------
// Vote Cache Entry — disk-backed in-memory cache
// ---------------------------------------------------------------------------

/**
 * Cache entry for a single voter's latest vote state.
 * Used with SDK's createDiskCache<VoteCacheEntry>().
 */
export interface VoteCacheEntry {
    /** Original bech32 voter ID (cache key). */
    voterId: string;
    /** Bech32 HRP for credential type derivation. */
    credentialHrp: string;
    /** blake2b_256 hash of IPFS evidence (matches on-chain voteHash). */
    voteHash: string;
    /** IPFS CID of full evidence bundle. */
    ipfsCid: string;
    /** Hydra head tx hash where this vote was recorded. */
    txHash: string;
    /** Monotonic version / nonce. */
    version: number;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Vote History — append-only chain of all vote versions
// ---------------------------------------------------------------------------

/**
 * A single entry in a voter's history chain.
 * Each entry links to the previous via prevTxHash, forming a
 * provable sequence from registration through final vote.
 */
export interface VoteHistoryEntry {
    version: number;
    voteHash: string;
    ipfsCid: string;
    txHash: string;
    /** Tx hash of the previous version (links the UTxO chain). Undefined for registration. */
    prevTxHash?: string;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Ballot Fingerprint — asset name construction
// ---------------------------------------------------------------------------

/**
 * Compute the full asset name for a ballot token.
 * @param prefix - CIP-67 4-byte prefix hex (BALLOT_DEFINITION_PREFIX or BALLOT_INSTANCE_PREFIX)
 * @param fingerprint - 28-byte blake2b_224 hash of the namespace, as hex (56 chars)
 * @returns 32-byte asset name as hex string (64 chars)
 */
export function buildAssetName(prefix: string, fingerprint: string): string {
    if (prefix.length !== 8) throw new Error(`CIP-67 prefix must be 8 hex chars, got ${prefix.length}`);
    if (fingerprint.length !== 56) throw new Error(`Fingerprint must be 56 hex chars, got ${fingerprint.length}`);
    return prefix + fingerprint;
}
