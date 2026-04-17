// ---------------------------------------------------------------------------
// CIP-67 Asset Name Label Prefixes (Ekklesia Ballot Standard)
// ---------------------------------------------------------------------------

/** CIP-67 encoded prefix for label 600 — Ballot Definition (stays on L1). */
export const BALLOT_DEFINITION_PREFIX = '00258a50';

/** CIP-67 encoded prefix for label 601 — Ballot Instance (enters Hydra head, returns with results). */
export const BALLOT_INSTANCE_PREFIX = '00259a20';

// ---------------------------------------------------------------------------
// Bech32 HRP → Credential Prefix Byte Mapping
// ---------------------------------------------------------------------------

/**
 * Maps bech32 human-readable prefixes to the 1-byte credential prefix
 * used in voter token asset names.
 *
 * Voter token asset name = <prefix byte><blake2b_224(bech32_decoded_data)> (29 bytes)
 */
export const CREDENTIAL_PREFIX: Record<string, number> = {
    drep: 0x22,
    stake: 0xe0,
    stake_test: 0xe0,
    pool: 0x06,
    calidus: 0x06,      // Calidus keys represent an SPO — use same prefix as pool
    addr: 0x60,
    addr_test: 0x60,
};

/** All recognized bech32 HRPs for voter identification. */
export type VoterHrp = keyof typeof CREDENTIAL_PREFIX;

/** Map bech32 HRP to human-readable voter role for tally grouping. */
export const HRP_TO_ROLE: Record<string, string> = {
    drep: 'DRep',
    pool: 'SPO',
    calidus: 'SPO',     // Calidus is an SPO hot key — counts as SPO vote
    stake: 'Stakeholder',
    stake_test: 'Stakeholder',
    addr: 'Stakeholder',
    addr_test: 'Stakeholder',
};

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
 * Maps role names to their weighting mode.
 */
export interface RoleWeighting {
    DRep?: 'CredentialBased' | 'StakeBased';
    SPO?: 'CredentialBased' | 'StakeBased' | 'PledgeBased';
    CC?: 'CredentialBased';
    Stakeholder?: 'StakeBased';
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

/** Aggregate statistics over a set of integer votes (range question). */
export interface RangeStats {
    n: number;
    mean: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
}

/** One option's Borda score — sum of rank-position points across ballots. */
export interface BordaEntry {
    option: number;
    score: number;
}

/**
 * Pairwise preference matrix for ranked questions. `matrix[i][j]` is the
 * number of ballots on which `options[i]` was ranked above `options[j]`.
 * `matrix[i][i]` is always 0. Sufficient for Condorcet, Copeland, Schulze,
 * Ranked Pairs and other pairwise-family methods without re-reading evidence.
 */
export interface PairwiseMatrix {
    options: number[];
    matrix: number[][];
}

/** Per-option aggregate for a weighted-allocation question. */
export interface WeightedOptionTally {
    option: number;
    /** Sum of points allocated to this option across all ballots. */
    totalPoints: number;
    /** Number of ballots that allocated a non-zero amount to this option. */
    voterCount: number;
    /** Mean points per ballot that answered this question. */
    mean: number;
    stdDev: number;
}

/** Per-option aggregate for a likert-rated question. */
export interface LikertOptionTally {
    option: number;
    /** Sum of all ratings on this option. */
    sum: number;
    /** Number of ballots that rated this option (equals n for valid ballots). */
    count: number;
    mean: number;
    median: number;
    /** Histogram of rating → number of voters who assigned it. */
    distribution: Record<number, number>;
}

/**
 * Method-shaped tally payload for a single role on a single question.
 * Discriminated on `method`; consumers narrow before reading method-specific
 * fields. All values are deterministic functions of the evidence set —
 * auditors can replay the exact computation from the IPFS evidence directory.
 */
export type MethodTally =
    | { method: 'binary' | 'single-choice' | 'multi-choice'; results: OptionCount[] }
    | { method: 'range'; distribution: DistributionEntry[]; stats: RangeStats }
    | { method: 'ranked'; firstPreference: OptionCount[]; borda: BordaEntry[]; pairwise: PairwiseMatrix }
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
}

/**
 * Complete results object stored on IPFS.
 * Hash of this (blake2b_256 of canonical JSON) = on-chain resultsHash.
 */
export interface FullResults {
    specVersion: string;
    ballotId: string;
    tallies: QuestionTally[];
    totalVoters: number;
    headId: string;
    finalizedAt: string;
    /** Per-role voter counts (e.g., { DRep: 800, SPO: 200 }). */
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
    selection: number[] | SelectionEntry[];
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
