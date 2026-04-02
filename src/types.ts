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
    pool: 0x06,
    addr: 0x60,
    addr_test: 0x60,
};

/** All recognized bech32 HRPs for voter identification. */
export type VoterHrp = keyof typeof CREDENTIAL_PREFIX;

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
 */
export type VoteMethod =
    | 'binary'
    | 'single-choice'
    | 'multi-choice'
    | 'range'
    | 'ranked'
    | 'weighted';

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
     * Required when method is 'range'.
     */
    valueRange?: { min: number; max: number };
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
}

/** Ekklesia-specific extension fields on the ballot definition. */
export interface EkklesiaBallotExtension {
    namespace: string;
    votingAuthority: string;
    context: 'hydra-head';
    acceptedCredentials: string[];
    merkleRoot: string;
    ballotIpfsCid: string;
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
 * On-chain (600) ballot definition datum. Kept slim to stay within the
 * ~5KB UTxO output limit. Full ballot content lives on IPFS.
 *
 * Maps directly to the Tx3 `BallotDefinition` type (if we add one).
 * For now this is serialized as JSON for the inline datum.
 */
export interface BallotDefinitionDatum {
    /** Short title for on-chain identification. */
    title: string;
    /** Ekklesia namespace (e.g., "vote.ekklesia.intersect.budget2026"). */
    namespace: string;
    /** Voting authority address (bech32). */
    votingAuthority: string;
    /** blake2b_256 merkle root of the ballot content (questions/options). */
    contentHash: string;
    /** IPFS CID of the full BallotDefinition JSON. */
    ballotCid: string;
    /** Number of questions in the ballot. */
    questionCount: number;
    /** Voting window timestamps. */
    votingWindow: { open: string; close: string };
    /** Cardano epoch at which voting ends. */
    endEpoch: number;
}

// ---------------------------------------------------------------------------
// Ballot Instance — (601) token datum, travels through Hydra head
// ---------------------------------------------------------------------------

/**
 * Status codes for the (601) ballot instance datum.
 * Reserved range for future states.
 */
export enum BallotStatus {
    Created = 0,
    Active = 1,
    Tallying = 2,
    Finalized = 3,
    Contested = 4,
}

/**
 * On-chain (601) ballot instance datum. Kept slim (~150 bytes) to survive
 * L1 fanout (~5KB output limit). Full results live on IPFS.
 *
 * Maps directly to the Tx3 `BallotResult` type.
 */
export interface BallotInstanceDatum {
    /** Ballot identifier (ULID or tx hash) linking back to the (600) ballot definition. */
    ballotId: string;
    /** Lifecycle status (see BallotStatus enum). */
    status: BallotStatus;
    /** blake2b_256 of full results JSON on IPFS. 0x00 until finalized. */
    resultsHash: string;
    /** IPFS directory CID for the complete evidence package. Empty until finalized. */
    evidenceCid: string;
    /** Total number of voters who participated. 0 until finalized. */
    totalVoters: number;
    /** Merkle root of all vote evidence files. 0x00 until finalized. */
    merkleRoot: string;
}

// ---------------------------------------------------------------------------
// Full Results — stored on IPFS, pointed to by BallotInstanceDatum.evidenceCid
// ---------------------------------------------------------------------------

/** Per-option tally entry within a single role's results. */
export interface OptionTally {
    option: number;
    count: number;
    /** Lovelace-denominated weight as string (BigInt serialized). */
    weight: string;
}

/** Tally results for a single role on a single question. */
export interface RoleTally {
    weightingMode: string;
    results: OptionTally[];
}

/** Tally for one question across all applicable roles. */
export interface QuestionTally {
    questionId: string;
    roleResults: Record<string, RoleTally>;
}

/**
 * Complete results object stored on IPFS.
 * Hash of this (blake2b_256 of canonical JSON) = on-chain resultsHash.
 */
export interface FullResults {
    specVersion: string;
    ballotId: string;
    status: 'finalized';
    tallies: QuestionTally[];
    totalVoters: number;
    evidenceIpfsCid: string;
    headId: string;
    finalizedAt: string;
}

// ---------------------------------------------------------------------------
// Voter Token Datum — slim, in-head only
// ---------------------------------------------------------------------------

/**
 * On-chain voter token datum. Kept minimal — full evidence is on IPFS.
 */
export interface VoterDatum {
    /** 28-byte credential hash hex. */
    voterId: string;
    /** Monotonic nonce — must match nonce in signed payload. Doubles as replay protection. */
    version: number;
    /** blake2b_256 of the ballot merkle root. */
    merkleRoot: string;
    /** blake2b_256 of full vote evidence JSON on IPFS. */
    voteHash: string;
    /** IPFS CID pointing to full vote evidence. */
    ipfsCid: string;
}

// ---------------------------------------------------------------------------
// Signed Vote Payload — what the voter's COSE key signs
// ---------------------------------------------------------------------------

/** A weighted allocation entry — option value + points assigned. */
export interface WeightedEntry {
    option: number;
    weight: number;
}

/**
 * An individual answer to a ballot question.
 *
 * The shape depends on the question's method:
 * - binary/single/multi/range: use `selection` (array of chosen integer values)
 * - ranked: use `ranking` (ordered array — position = preference rank, value = option value)
 * - weighted: use `weights` (array of {option, weight} entries summing to budget)
 *
 * Exactly one of selection/ranking/weights must be present.
 */
export interface VoteSelection {
    questionId: string;
    /** Selected option values (binary, single-choice, multi-choice, range). */
    selection?: number[];
    /** Ordered preference ranking (ranked choice — index 0 = 1st preference). */
    ranking?: number[];
    /** Point allocation across options (weighted — must sum to budget). */
    weights?: WeightedEntry[];
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

/** A single COSE witness — one signer's signature + key. */
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
export interface VoteSignatureData extends Partial<CoseWitness> {
    /** For script-based DReps: the native script definition. */
    nativeScript?: NativeScriptDef;
    /** For script-based DReps: all witness signatures needed to satisfy the script. */
    witnesses?: CoseWitness[];
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
    txHash?: string;
    /** Monotonic version / nonce. */
    version: number;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Tally Result — alias for FullResults (used by finalization logic)
// ---------------------------------------------------------------------------

/** Alias: the tally result IS the full results object that gets pinned to IPFS. */
export type TallyResult = FullResults;

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
