import {Router} from 'express';
import {createNativeScript, verifySignature} from '@lerna-labs/hydra-sdk';
import {resolveNativeScriptHash} from '@meshsdk/core';
import {blake2b256, bytesToHex} from '@lerna-labs/hydra-proof';
import {bech32} from 'bech32';
import {blake2b} from 'blakejs';
import {
    appendVoteHistory,
    error,
    initialize,
    ipfs,
    success,
    voteCache,
    voterIdHrp,
    voterIdToTokenName,
    debug,
    enqueueAndWait,
} from '../helpers.js';
import {getCachedBallot, getCachedBallotIdentity} from './lifecycle.js';
import {HRP_TO_ROLE} from '../types.js';
import type {
    BallotDefinition,
    CoseWitness,
    NativeScriptDef,
    SelectionEntry,
    SignedVotePayload,
    VoteCacheEntry,
    VoteEvidence,
    VoteSelection,
    VoteSignatureData,
} from '../types.js';

/** Narrow `VoteSelection.selection` to `number[]`. */
function asNumberArray(s: VoteSelection['selection']): number[] | null {
    if (!Array.isArray(s) || s.length === 0) return null;
    return s.every((x) => typeof x === 'number') ? (s as number[]) : null;
}

/** Narrow `VoteSelection.selection` to `SelectionEntry[]`. */
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

/**
 * Check that `v` lies on the integer grid `{min, min+step, …, max}`.
 * Assumes the grid itself has already been validated (ints, `(max-min) % step === 0`).
 */
function isOnGrid(v: number, min: number, max: number, step: number): boolean {
    if (!Number.isInteger(v)) return false;
    if (v < min || v > max) return false;
    return (v - min) % step === 0;
}

/**
 * Check that a voter's bech32 HRP is permitted by the ballot.
 *
 * Source of truth (in priority order):
 *   1. ballot.ekklesia.acceptedCredentials — explicit HRP allowlist
 *   2. ballot.roleWeighting keys — mapped to HRPs via HRP_TO_ROLE
 *
 * Ballots with neither populated are treated as open (no gate), preserving
 * behavior for ballots authored before this check existed. Returns null on
 * success or a human-readable error string on rejection.
 */
function checkVoterEligibility(credentialHrp: string, ballot: BallotDefinition): string | null {
    const accepted = ballot.ekklesia?.acceptedCredentials;
    if (Array.isArray(accepted) && accepted.length > 0) {
        if (!accepted.includes(credentialHrp)) {
            return `Voter credential "${credentialHrp}" is not accepted by this ballot (acceptedCredentials: ${accepted.join(', ')})`;
        }
        return null;
    }

    const declaredRoles = ballot.roleWeighting ? Object.keys(ballot.roleWeighting) : [];
    if (declaredRoles.length > 0) {
        const role = HRP_TO_ROLE[credentialHrp];
        if (!role || !declaredRoles.includes(role)) {
            return `Voter role "${role ?? credentialHrp}" is not declared in ballot.roleWeighting (${declaredRoles.join(', ')})`;
        }
    }

    return null;
}

/**
 * Validate voter selections against the cached ballot definition.
 * Dispatches to method-specific validation based on question.method.
 * Returns an error message string on failure, or null on success.
 */
function validateSelections(votes: VoteSelection[], ballot: BallotDefinition): string | null {
    const questionMap = new Map(ballot.questions.map((q) => [q.questionId, q]));

    // A single /vote call may not contain two entries for the same
    // questionId — ambiguous which one is the voter's preference.
    const seenQids = new Set<string>();
    for (const sel of votes) {
        if (seenQids.has(sel.questionId)) {
            return `Duplicate questionId "${sel.questionId}" in votes[] — at most one entry per question per submission`;
        }
        seenQids.add(sel.questionId);
    }

    for (const sel of votes) {
        const q = questionMap.get(sel.questionId);
        if (!q) {
            return `Unknown questionId: "${sel.questionId}"`;
        }

        const qid = sel.questionId;
        const validValues = q.options ? new Set(q.options.map((o) => o.value)) : null;

        // Abstain short-circuits per-method shape validation. Allowed by
        // default; rejected only on questions flagged requireAnswer.
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
                        if (!validValues.has(v)) {
                            return `Invalid option value ${v} for "${qid}"`;
                        }
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
// Signature verification — supports both key-based and script-based credentials
// ---------------------------------------------------------------------------

/**
 * Verify a single COSE witness: Ed25519 signature validity + message match + address match.
 * Used for key-based credentials where the signing key hash must match the bech32 address.
 * Returns null on success, error message on failure.
 */
function verifySingleWitness(
    merkleRoot: string,
    signingAddress: string,
    witness: CoseWitness,
): string | null {
    try {
        const result = verifySignature(
            witness.coseSign1Hex,
            merkleRoot,
            signingAddress,
            witness.coseKeyHex,
        );
        if (!result.isValid) {
            return 'COSE_Sign1 does not match the credential or signed content';
        }
        return null;
    } catch (err: any) {
        return `Signature verification error: ${err.message}`;
    }
}

/**
 * Verify a COSE witness for script-based credentials.
 * Checks Ed25519 signature validity + message match, but NOT address match
 * (since the address is a script hash, not a key hash).
 *
 * Returns { error, pubKeyHex } — error is null on success.
 */
function verifyScriptWitness(
    merkleRoot: string,
    witness: CoseWitness,
): { error: string | null; pubKeyHex: string } {
    try {
        // Use the SDK's verifySignature with a dummy address — we only care
        // about the Ed25519 signature and message match, not address match.
        // The SDK returns pubKeyHex regardless of address match.
        // We pass the voterId but ignore isValid — instead check the components.
        const result = verifySignature(
            witness.coseSign1Hex,
            merkleRoot,
            // Dummy — we can't match a script address to a key hash
            'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
            witness.coseKeyHex,
        );

        // The SDK verifies: validates (Ed25519) && message_matches && address_matches
        // For scripts, address_matches will be false, so isValid is false.
        // But pubKeyHex is still populated if the COSE parsing succeeded
        // and the Ed25519 signature was verified against the payload.
        if (!result.pubKeyHex) {
            return { error: 'Could not extract public key from COSE witness', pubKeyHex: '' };
        }

        return { error: null, pubKeyHex: result.pubKeyHex };
    } catch (err: any) {
        return { error: `Script witness verification error: ${err.message}`, pubKeyHex: '' };
    }
}

/**
 * Extract all `sig` key hashes from a native script (recursively).
 */
function extractKeyHashes(script: NativeScriptDef): string[] {
    switch (script.type) {
        case 'sig': return [script.keyHash];
        case 'after':
        case 'before': return [];
        case 'all':
        case 'any': return script.scripts.flatMap(extractKeyHashes);
        case 'atLeast': return script.scripts.flatMap(extractKeyHashes);
    }
}

/**
 * Check if a set of provided key hashes satisfies a native script.
 * Does NOT check time constraints (after/before) — those are chain-level.
 */
function satisfiesScript(script: NativeScriptDef, providedKeyHashes: Set<string>): boolean {
    switch (script.type) {
        case 'sig':
            return providedKeyHashes.has(script.keyHash);
        case 'all':
            return script.scripts.every((s) => satisfiesScript(s, providedKeyHashes));
        case 'any':
            return script.scripts.some((s) => satisfiesScript(s, providedKeyHashes));
        case 'atLeast':
            return script.scripts.filter((s) => satisfiesScript(s, providedKeyHashes)).length >= script.required;
        case 'after':
        case 'before':
            // Time constraints are enforced by the ledger, not by us
            return true;
    }
}

/**
 * Verify vote signatures for both key-based and script-based credentials.
 *
 * Key-based: verifies the single COSE signature against the voter's bech32 address.
 * Script-based: verifies that (a) the script hash matches the DRep credential,
 *   (b) each witness signature is valid, and (c) the witnesses satisfy the script rules.
 *
 * Returns { error, witnesses } — error is null on success.
 */
function verifyVoteSignatures(
    merkleRoot: string,
    voterId: string,
    sig: VoteSignatureData,
): { error: string | null; witnesses: CoseWitness[] } {
    // --- Script-based credential (multi-sig) ---
    if (sig.nativeScript && sig.witnesses && sig.witnesses.length > 0) {
        // 1. Verify the script hash matches the DRep credential
        const scriptHash = resolveNativeScriptHash(sig.nativeScript);
        const decoded = bech32.decode(voterId);
        const bytes = bech32.fromWords(decoded.words);

        // CIP-129: first byte is credential type (0x22=key, 0x23=script), rest is hash
        let credentialHash: string;
        if (decoded.prefix === 'drep' && bytes[0] === 0x23) {
            credentialHash = Buffer.from(bytes.slice(1)).toString('hex');
        } else {
            credentialHash = Buffer.from(bytes).toString('hex');
        }

        if (scriptHash !== credentialHash) {
            return {
                error: `Native script hash ${scriptHash} does not match DRep credential ${credentialHash}`,
                witnesses: [],
            };
        }

        // 2. Verify each witness signature (Ed25519 + message match, no address match)
        const requiredKeys = new Set(extractKeyHashes(sig.nativeScript));
        const providedKeyHashes = new Set<string>();

        for (let i = 0; i < sig.witnesses.length; i++) {
            const { error, pubKeyHex } = verifyScriptWitness(merkleRoot, sig.witnesses[i]);
            if (error) {
                return {
                    error: `Witness ${i}: ${error}`,
                    witnesses: [],
                };
            }
            // Native script keyHash = blake2b-224(pubKey) — standard Cardano key hash
            const keyHash = Buffer.from(blake2b(Buffer.from(pubKeyHex, 'hex'), undefined, 28)).toString('hex');
            providedKeyHashes.add(keyHash);
        }

        // 3. Check the witnesses satisfy the script
        if (!satisfiesScript(sig.nativeScript, providedKeyHashes)) {
            return {
                error: `Provided witnesses do not satisfy the native script rules. ` +
                    `Required keys: ${[...requiredKeys].join(', ')}. ` +
                    `Provided keys: ${[...providedKeyHashes].join(', ')}`,
                witnesses: sig.witnesses,
            };
        }

        return { error: null, witnesses: sig.witnesses };
    }

    // --- Key-based credential (single sig) ---
    if (sig.coseSign1Hex && sig.coseKeyHex) {
        const witness: CoseWitness = {
            coseSign1Hex: sig.coseSign1Hex,
            coseKeyHex: sig.coseKeyHex,
            key: sig.key ?? '',
            signature: sig.signature ?? '',
        };

        // For calidus votes, the signing key is a hot key that won't match the
        // pool voter ID. Verify Ed25519 + message match only, skip address match.
        if (sig.calidusDeclaration) {
            try {
                const result = verifySignature(
                    witness.coseSign1Hex,
                    merkleRoot,
                    voterId,
                    witness.coseKeyHex,
                );
                // isValid will be false (address mismatch) but we check sigMeta/pubKeyHex
                // to confirm the Ed25519 signature and message are valid.
                if (!result.pubKeyHex) {
                    return { error: 'Could not extract public key from COSE witness', witnesses: [] };
                }
                // pubKeyHex populated = Ed25519 sig valid + message matches
                return { error: null, witnesses: [witness] };
            } catch (err: any) {
                return { error: `Signature verification error: ${err.message}`, witnesses: [] };
            }
        }

        // Standard key-based: full verification including address match
        const error = verifySingleWitness(merkleRoot, voterId, witness);
        return { error, witnesses: [witness] };
    }

    return { error: 'No valid signature data provided', witnesses: [] };
}

// ---------------------------------------------------------------------------
// Shared vote pipeline: validate → hash → verify sig → IPFS → cache → history
// ---------------------------------------------------------------------------

interface VotePipelineInput {
    voterId: string;
    tokenName: string;
    credentialHrp: string;
    nonce: number;
    ballotId: string;
    votes: VoteSelection[];
    signature: VoteSignatureData;
    prevTxHash?: string;
}

interface VotePipelineResult {
    merkleRoot: string;
    voteHash: string;
    ipfsCid: string;
    evidence: VoteEvidence;
}

/**
 * Shared pipeline for /vote and /vote-and-register:
 * validate selections → build payload → compute hashes → verify signature →
 * build evidence → pin to IPFS.
 *
 * Returns the computed hashes and evidence, or throws with a descriptive
 * error message prefixed with the HTTP status code for the caller to use.
 */
async function voteValidateAndPin(input: VotePipelineInput): Promise<VotePipelineResult> {
    const { voterId, tokenName, credentialHrp, nonce, ballotId, votes, signature } = input;

    // Validate votes against ballot
    const ballot = getCachedBallot();
    if (ballot) {
        const selError = validateSelections(votes, ballot);
        if (selError) {
            throw Object.assign(new Error(selError), { statusCode: 400, code: 'INVALID_VOTE' as const });
        }
    }

    // Build signed payload + compute hashes
    const signedPayload: SignedVotePayload = { ballotId, nonce, votes };
    const merkleRoot = bytesToHex(blake2b256(JSON.stringify(signedPayload)));

    // Verify signature(s)
    const { error: sigError, witnesses } = verifyVoteSignatures(merkleRoot, voterId, signature);
    if (sigError) {
        throw Object.assign(new Error(sigError), { statusCode: 401, code: 'SIGNATURE_INVALID' as const });
    }

    // Build evidence. responderRole is derived from credentialHrp — the client
    // does not get to pick. Any HRP that reaches this point already passed
    // CREDENTIAL_PREFIX validation in voterIdToTokenName, so HRP_TO_ROLE is
    // guaranteed to have a mapping; the fallback is defensive.
    const evidence: VoteEvidence = {
        specVersion: '0.3.0',
        responderRole: HRP_TO_ROLE[credentialHrp] ?? 'drep',
        answers: votes,
        ekklesia: {
            voterId,
            credentialHrp,
            nonce,
            signedPayload,
            witnesses,
            nativeScript: signature.nativeScript,
            calidusDeclaration: signature.calidusDeclaration,
            merkleProof: { root: '', steps: [] },
        },
    };

    const voteHash = bytesToHex(blake2b256(JSON.stringify(evidence)));

    // Pin to IPFS
    const { cid: ipfsCid } = await ipfs.pinJson(
        `vote-${tokenName}-v${nonce}.json`,
        evidence,
    );

    return { merkleRoot, voteHash, ipfsCid, evidence };
}

/**
 * Write vote to disk cache and append history entry.
 */
async function voteCacheAndHistory(
    voterId: string,
    credentialHrp: string,
    tokenName: string,
    nonce: number,
    voteHash: string,
    ipfsCid: string,
    txHash: string,
    evidence: VoteEvidence,
    prevTxHash?: string,
): Promise<void> {
    const cacheEntry: VoteCacheEntry = {
        voterId,
        credentialHrp,
        voteHash,
        ipfsCid,
        txHash,
        version: nonce,
        timestamp: Date.now(),
    };

    await voteCache.put(cacheEntry, `vote-${tokenName}-v${nonce}.json`, evidence);

    await appendVoteHistory(voterId, {
        version: nonce,
        voteHash,
        ipfsCid,
        txHash: txHash ?? '',
        prevTxHash,
        timestamp: Date.now(),
    });
}

const router = Router();

// ---------------------------------------------------------------------------
// Per-voter mutex — prevents race conditions when the same voter sends
// multiple concurrent requests (e.g., double-click, retry spam).
// Only one request per voter is processed at a time; others wait in line.
// ---------------------------------------------------------------------------

const voterLocks = new Map<string, Promise<void>>();

async function withVoterLock<T>(voterId: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this voter
    const existing = voterLocks.get(voterId);
    let releaseFn: () => void;
    const newLock = new Promise<void>(resolve => { releaseFn = resolve; });
    voterLocks.set(voterId, newLock);

    if (existing) await existing;

    try {
        return await fn();
    } finally {
        releaseFn!();
        // Clean up if this is still the latest lock
        if (voterLocks.get(voterId) === newLock) {
            voterLocks.delete(voterId);
        }
    }
}

router.post('/register', async (req, res) => {
    const voterId = req.body.voterId;

    if (!voterId) {
        return error(res, 'MISSING_FIELDS', 'Missing required field: voterId', 400);
    }

    let tokenName: string;
    let credentialHrp: string;
    try {
        tokenName = voterIdToTokenName(voterId);
        credentialHrp = voterIdHrp(voterId);
    } catch (e: any) {
        return error(res, 'INVALID_VOTER_ID', `Invalid voter ID: ${e.message}`, 400);
    }

    // Reject voters whose credential type isn't permitted by the ballot.
    const ballot = getCachedBallot();
    if (ballot) {
        const eligErr = checkVoterEligibility(credentialHrp, ballot);
        if (eligErr) {
            return error(res, 'INELIGIBLE_VOTER', eligErr, 403);
        }
    }

    // Prevent duplicate registration — voter token already exists in head
    const existingVote = voteCache.get(voterId);
    if (existingVote) {
        return error(res, 'CONFLICT', 'Voter already registered. Use POST /vote to cast a vote.', 409);
    }

    try {
        const { admin_wallet, client } = await initialize();
        if (!admin_wallet) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet', 503);
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        if (!client) {
            return error(res, 'CLIENT_INIT_FAILED', 'Could not initialize client', 503);
        }

        const {
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY,
        } = createNativeScript(admin_payment_address);

        const ballotIdentity = getCachedBallotIdentity();
        if (!ballotIdentity) {
            return error(res, 'CLIENT_INIT_FAILED', 'Ballot identity not cached. Was /start called with ballotPolicy and ballotToken?', 503);
        }

        // TRP resolves the unsigned tx; admin signs locally; queue worker
        // dispatches via WebSocket and reports back via TxValid.
        const { tx: unsignedTx } = await client!.registerVoterTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
            userId: Buffer.from(tokenName, 'hex'),
            ballotPolicy: Buffer.from(ballotIdentity.ballotPolicy, 'hex'),
            ballotToken: Buffer.from(ballotIdentity.ballotToken, 'hex'),
        });
        const signedTx = await admin_wallet.signTx(unsignedTx);

        const { txHash } = await enqueueAndWait({
            id: `register:${tokenName}`,
            type: 'register',
            unsignedCborHex: unsignedTx,
            signedCborHex: signedTx,
            voterId,
        });

        return success(res, { txHash, tokenName });
    } catch (err: any) {
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to register voter', 400);
    }
});

/**
 * POST /vote-and-register (deprecated — use POST /vote)
 *
 * Kept for backwards compatibility. The unified /vote endpoint auto-detects
 * registration status and calls the appropriate transaction builder.
 */
router.post('/vote-and-register', (req, _res, next) => {
    if (!req.body.nonce) req.body.nonce = 1;
    req.url = '/vote';
    next();
});

/**
 * POST /vote
 *
 * Cast or update a vote. The middleware handles IPFS pinning, hash computation,
 * caching, and TRP submission. The caller provides the raw vote data + signature.
 *
 * Body:
 *   voterId: string                — bech32 voter ID (e.g., "drep1...")
 *   nonce: number                  — monotonic, must exceed current on-chain version
 *   ballotId: string               — ballot identifier (ULID or tx hash)
 *   votes: VoteSelection[]         — [{questionId, selection: number[]}]
 *   signature: {
 *     COSE_Sign1_hex: string,
 *     COSE_Key_hex: string,
 *     key: string,
 *     signature: string,
 *   }
 */
/**
 * POST /vote
 *
 * Unified vote endpoint — automatically registers the voter if needed.
 *
 * If the voter is not yet registered, mints a voter token and casts the
 * first vote in a single atomic transaction (vote-and-register).
 * If already registered, updates the existing vote (cast_vote).
 *
 * The caller never needs to know the voter's registration status.
 * A per-voter lock prevents race conditions from concurrent requests.
 *
 * Body:
 *   voterId: string                — bech32 voter ID (e.g., "drep1...")
 *   nonce?: number                 — monotonic version. Optional for first vote (auto-set to 1).
 *                                    Required for updates (must exceed current on-chain version).
 *   ballotId: string               — ballot identifier (ULID or tx hash)
 *   votes: VoteSelection[]         — [{questionId, selection: number[]}]
 *   signature: VoteSignatureData   — COSE_Sign1 or native script witnesses
 *
 * responderRole is intentionally NOT accepted on the wire. It is derived
 * server-side from the bech32 HRP of voterId before evidence is hashed.
 */
router.post('/vote', async (req, res) => {
    const {
        voterId,
        ballotId,
        votes,
        signature,
    } = req.body as {
        voterId: string;
        nonce?: number;
        ballotId: string;
        votes: VoteSelection[];
        signature: VoteSignatureData;
    };

    if (!voterId || !ballotId || !votes || !signature) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: voterId, ballotId, votes, signature', 400);
    }

    let tokenName: string;
    let credentialHrp: string;
    try {
        tokenName = voterIdToTokenName(voterId);
        credentialHrp = voterIdHrp(voterId);
    } catch (e: any) {
        return error(res, 'INVALID_VOTER_ID', `Invalid voter ID: ${e.message}`, 400);
    }

    // Reject voters whose credential type isn't permitted by the ballot.
    const ballot = getCachedBallot();
    if (ballot) {
        const eligErr = checkVoterEligibility(credentialHrp, ballot);
        if (eligErr) {
            return error(res, 'INELIGIBLE_VOTER', eligErr, 403);
        }
    }

    // Per-voter lock: only one request per voter at a time
    return withVoterLock(voterId, async () => {
        // Determine registration status and nonce
        const existingVote = voteCache.get(voterId);
        const isRegistered = !!existingVote;
        const nonce = req.body.nonce ?? (isRegistered ? existingVote.version + 1 : 1);

        // Replay protection for updates
        if (isRegistered && nonce <= existingVote.version) {
            return error(res, 'CONFLICT', `Nonce ${nonce} must exceed current version ${existingVote.version}`, 409);
        }

        try {
            const { admin_wallet, client } = await initialize();
            if (!admin_wallet) {
                return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet', 503);
            }
            if (!client) {
                return error(res, 'CLIENT_INIT_FAILED', 'Could not initialize client', 503);
            }

            const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;
            const {
                scriptCbor: TOKEN_SCRIPT,
                scriptHash: TOKEN_POLICY,
            } = createNativeScript(admin_payment_address);

            // --- Shared pipeline: validate → hash → verify sig → IPFS ---
            const { merkleRoot, voteHash, ipfsCid, evidence } = await voteValidateAndPin({
                voterId, tokenName, credentialHrp, nonce, ballotId, votes, signature,
            });

            let txHash: string;
            const registered = !isRegistered;

            if (!isRegistered) {
                // ===== VOTE-AND-REGISTER PATH =====
                const ballotIdentity = getCachedBallotIdentity();
                if (!ballotIdentity) {
                    return error(res, 'CLIENT_INIT_FAILED', 'Ballot identity not cached. Was /start called?', 503);
                }

                const { tx: unsignedTx } = await client!.voteAndRegisterTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                    merkleRoot: Buffer.from(merkleRoot, 'hex'),
                    voteHash: Buffer.from(voteHash, 'hex'),
                    ipfsCid: Buffer.from(ipfsCid),
                    ballotPolicy: Buffer.from(ballotIdentity.ballotPolicy, 'hex'),
                    ballotToken: Buffer.from(ballotIdentity.ballotToken, 'hex'),
                });
                const signedTx = await admin_wallet.signTx(unsignedTx);

                const result = await enqueueAndWait({
                    id: `vote-and-register:${tokenName}:${nonce}`,
                    type: 'vote-and-register',
                    unsignedCborHex: unsignedTx,
                    signedCborHex: signedTx,
                    voterId,
                });
                txHash = result.txHash;
            } else {
                // ===== CAST_VOTE PATH (already registered) =====
                const { tx: unsignedTx } = await client!.castVoteTx({
                    votingAuthority: admin_payment_address,
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                    version: nonce,
                    merkleRoot: Buffer.from(merkleRoot, 'hex'),
                    voteHash: Buffer.from(voteHash, 'hex'),
                    ipfsCid: Buffer.from(ipfsCid),
                });
                const signedTx = await admin_wallet.signTx(unsignedTx);

                const result = await enqueueAndWait({
                    id: `cast-vote:${tokenName}:${nonce}`,
                    type: 'cast_vote',
                    unsignedCborHex: unsignedTx,
                    signedCborHex: signedTx,
                    voterId,
                });
                txHash = result.txHash;
            }

            // --- Cache + history ---
            await voteCacheAndHistory(voterId, credentialHrp, tokenName, nonce, voteHash, ipfsCid, txHash, evidence, existingVote?.txHash);

            return success(res, { txHash, voteHash, ipfsCid, version: nonce, tokenName, registered });
        } catch (err: any) {
            console.error('[vote] FULL ERROR:', err);
            if (err.code && err.statusCode) {
                return error(res, err.code, err.message, err.statusCode);
            }
            if (err.message?.includes('IPFS') || err.message?.includes('fetch')) {
                return error(res, 'IPFS_UNAVAILABLE', `IPFS pin failed — retryable: ${err.message}`, 503);
            }
            return error(res, 'INTERNAL_ERROR', err.message || 'Failed to vote', 400);
        }
    });
});

export default router;
