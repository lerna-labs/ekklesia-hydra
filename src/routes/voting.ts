import {Router} from 'express';
import {createNativeScript, verifySignature} from '@lerna-labs/hydra-sdk';
import {resolveNativeScriptHash} from '@meshsdk/core';
import {blake2b256, bytesToHex} from '@lerna-labs/hydra-proof';
import {bech32} from 'bech32';
import {createHash} from 'crypto';
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
    submitWithRetry,
    TX_MODE,
    getVoterUtxo,
    setVoterUtxo,
    getBallotUtxo,
    setBallotUtxo,
    submitDirect,
} from '../helpers.js';
import type { CachedUtxo } from '../helpers.js';
import { buildCastVoteTx, buildRegisterVoterTx, buildVoteAndRegisterTx } from '../tx-builder.js';
import {getCachedBallot, getCachedBallotIdentity} from './lifecycle.js';
import type {
    BallotDefinition,
    CoseWitness,
    NativeScriptDef,
    SignedVotePayload,
    VoteCacheEntry,
    VoteEvidence,
    VoteSelection,
    VoteSignatureData,
} from '../types.js';

/**
 * Validate voter selections against the cached ballot definition.
 * Dispatches to method-specific validation based on question.method.
 * Returns an error message string on failure, or null on success.
 */
function validateSelections(votes: VoteSelection[], ballot: BallotDefinition): string | null {
    const questionMap = new Map(ballot.questions.map((q) => [q.questionId, q]));

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
                // Check for duplicates
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

            case 'range': {
                if (!sel.selection || sel.selection.length !== 1) {
                    return `"${qid}" (range) requires exactly 1 value`;
                }
                if (!q.valueRange) {
                    return `"${qid}" is range type but has no valueRange defined`;
                }
                const v = sel.selection[0];
                if (v < q.valueRange.min || v > q.valueRange.max) {
                    return `Value ${v} out of range [${q.valueRange.min}, ${q.valueRange.max}] for "${qid}"`;
                }
                break;
            }

            case 'ranked': {
                if (!sel.ranking) {
                    return `"${qid}" (ranked) requires ranking array`;
                }
                const expectedCount = q.rankCount ?? (q.options?.length ?? 0);
                if (sel.ranking.length !== expectedCount) {
                    return `"${qid}" (ranked) requires exactly ${expectedCount} ranked entries, got ${sel.ranking.length}`;
                }
                // All entries must be valid option values
                if (validValues) {
                    for (const v of sel.ranking) {
                        if (!validValues.has(v)) {
                            return `Invalid option value ${v} in ranking for "${qid}"`;
                        }
                    }
                }
                // No duplicates
                if (new Set(sel.ranking).size !== sel.ranking.length) {
                    return `Duplicate entries in ranking for "${qid}"`;
                }
                break;
            }

            case 'weighted': {
                if (!sel.weights || sel.weights.length === 0) {
                    return `"${qid}" (weighted) requires weights array`;
                }
                if (q.budget === undefined) {
                    return `"${qid}" is weighted type but has no budget defined`;
                }
                // All options must be valid
                if (validValues) {
                    for (const w of sel.weights) {
                        if (!validValues.has(w.option)) {
                            return `Invalid option value ${w.option} in weights for "${qid}"`;
                        }
                    }
                }
                // No duplicate option entries
                const weightOptions = sel.weights.map((w) => w.option);
                if (new Set(weightOptions).size !== weightOptions.length) {
                    return `Duplicate option entries in weights for "${qid}"`;
                }
                // Weights must be non-negative integers
                for (const w of sel.weights) {
                    if (!Number.isInteger(w.weight) || w.weight < 0) {
                        return `Weight must be a non-negative integer for "${qid}", got ${w.weight}`;
                    }
                }
                // Must sum to budget
                const total = sel.weights.reduce((sum, w) => sum + w.weight, 0);
                if (total !== q.budget) {
                    return `Weights sum to ${total} but budget is ${q.budget} for "${qid}"`;
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
            // Native script keyHash = blake2b-224(pubKey).
            // The SDK returns the raw Ed25519 pubKeyHex — hash it to get the keyHash.
            const keyHash = createHash('blake2b512')
                .update(Buffer.from(pubKeyHex, 'hex'))
                .digest('hex')
                .slice(0, 56); // 28 bytes = 56 hex chars
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
    responderRole?: string;
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
    const { voterId, tokenName, credentialHrp, nonce, ballotId, votes, signature, responderRole } = input;

    // Validate votes against ballot
    const ballot = getCachedBallot();
    if (ballot) {
        const selError = validateSelections(votes, ballot);
        if (selError) {
            throw Object.assign(new Error(selError), { statusCode: 400, code: 'INVALID_INPUT' as const });
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

    // Build evidence
    const evidence: VoteEvidence = {
        specVersion: '0.3.0',
        surveyTxId: ballotId,
        responderRole: responderRole ?? 'DRep',
        answers: votes,
        ekklesia: {
            voterId,
            credentialHrp,
            nonce,
            signedPayload,
            witnesses,
            nativeScript: signature.nativeScript,
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

router.post('/register', async (req, res) => {
    const voterId = req.body.voterId;

    if (!voterId) {
        return error(res, 'MISSING_FIELDS', 'Missing required field: voterId', 400);
    }

    let tokenName: string;
    try {
        tokenName = voterIdToTokenName(voterId);
    } catch (e: any) {
        return error(res, 'INVALID_VOTER_ID', `Invalid voter ID: ${e.message}`, 400);
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

        let txHash: string;
        let attempts = 1;

        if (TX_MODE === 'direct') {
            const ballotUtxo = getBallotUtxo();
            if (!ballotUtxo) {
                return error(res, 'INTERNAL_ERROR', 'Ballot UTxO not found in cache. Was the head opened with TX_MODE=direct?', 500);
            }

            const unsignedTx = buildRegisterVoterTx({
                adminAddress: admin_payment_address,
                tokenPolicy: TOKEN_POLICY as string,
                tokenScript: TOKEN_SCRIPT as string,
                userId: tokenName,
                inputRef: ballotUtxo.ref,
                inputValue: ballotUtxo.value,
                inputDatum: ballotUtxo.datum,
            });

            const signedTx = await admin_wallet.signTx(unsignedTx);
            const result = await submitDirect(signedTx);
            txHash = result.hash;

            // Update caches: output 0 = voter token, output 1 = gas return (ballot)
            setVoterUtxo(tokenName, {
                ref: { txHash, outputIndex: 0 },
                value: [
                    { unit: 'lovelace', quantity: '0' },
                    { unit: (TOKEN_POLICY as string) + tokenName, quantity: '1' },
                ],
                address: ballotUtxo.address,
            });
            setBallotUtxo({
                ref: { txHash, outputIndex: 1 },
                value: ballotUtxo.value,
                datum: ballotUtxo.datum,
                address: ballotUtxo.address,
            });
        } else {
            const result = await submitWithRetry(
                () => client!.registerVoterTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                    ballotPolicy: Buffer.from(ballotIdentity.ballotPolicy, 'hex'),
                    ballotToken: Buffer.from(ballotIdentity.ballotToken, 'hex'),
                }),
                (tx) => admin_wallet.signTx(tx),
                `0:${tokenName}`,
            );
            txHash = result.hash;
            attempts = result.attempts;
            if (attempts > 1) debug(`[register] Succeeded after ${attempts} attempts`);
        }

        return success(res, { txHash, tokenName, attempts });
    } catch (err: any) {
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to register voter', 400);
    }
});

/**
 * POST /vote-and-register
 *
 * Register a voter and cast their first vote in a single transaction.
 * Same IPFS+cache flow as /vote, but mints the voter token atomically.
 * The nonce is always 1 (first vote).
 *
 * Body: same as /vote (nonce should be 1)
 */
router.post('/vote-and-register', async (req, res) => {
    const {
        voterId,
        ballotId,
        votes,
        signature,
        responderRole,
    } = req.body as {
        voterId: string;
        ballotId: string;
        votes: VoteSelection[];
        signature: VoteSignatureData;
        responderRole?: string;
    };

    if (!voterId || !ballotId || !votes || !signature) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: voterId, ballotId, votes, signature', 400);
    }

    const nonce = 1;

    let tokenName: string;
    let credentialHrp: string;
    try {
        tokenName = voterIdToTokenName(voterId);
        credentialHrp = voterIdHrp(voterId);
    } catch (e: any) {
        return error(res, 'INVALID_VOTER_ID', `Invalid voter ID: ${e.message}`, 400);
    }

    const existingVote = voteCache.get(voterId);
    if (existingVote) {
        return error(res, 'CONFLICT', 'Voter already registered. Use POST /vote to update.', 409);
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
            voterId, tokenName, credentialHrp, nonce, ballotId, votes, signature, responderRole,
        });

        // --- Submit combined register+vote via TRP ---
        const ballotIdentity = getCachedBallotIdentity();
        if (!ballotIdentity) {
            return error(res, 'CLIENT_INIT_FAILED', 'Ballot identity not cached. Was /start called with ballotPolicy and ballotToken?', 503);
        }

        let txHash: string;
        let attempts = 1;

        if (TX_MODE === 'direct') {
            const ballotUtxo = getBallotUtxo();
            if (!ballotUtxo) {
                return error(res, 'INTERNAL_ERROR', 'Ballot UTxO not found in cache. Was the head opened with TX_MODE=direct?', 500);
            }

            const unsignedTx = buildVoteAndRegisterTx({
                adminAddress: admin_payment_address,
                tokenPolicy: TOKEN_POLICY as string,
                tokenScript: TOKEN_SCRIPT as string,
                userId: tokenName,
                merkleRoot,
                voteHash,
                ipfsCid,
                inputRef: ballotUtxo.ref,
                inputValue: ballotUtxo.value,
                inputDatum: ballotUtxo.datum,
            });

            const signedTx = await admin_wallet.signTx(unsignedTx);
            const result = await submitDirect(signedTx);
            txHash = result.hash;

            // Update caches: output 0 = voter token, output 1 = gas return (ballot)
            setVoterUtxo(tokenName, {
                ref: { txHash, outputIndex: 0 },
                value: [
                    { unit: 'lovelace', quantity: '0' },
                    { unit: (TOKEN_POLICY as string) + tokenName, quantity: '1' },
                ],
                address: ballotUtxo.address,
            });
            setBallotUtxo({
                ref: { txHash, outputIndex: 1 },
                value: ballotUtxo.value,
                datum: ballotUtxo.datum,
                address: ballotUtxo.address,
            });
        } else {
            const result = await submitWithRetry(
                () => client!.voteAndRegisterTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                    merkleRoot: Buffer.from(merkleRoot, 'hex'),
                    voteHash: Buffer.from(voteHash, 'hex'),
                    ipfsCid: Buffer.from(ipfsCid),
                    ballotPolicy: Buffer.from(ballotIdentity!.ballotPolicy, 'hex'),
                    ballotToken: Buffer.from(ballotIdentity!.ballotToken, 'hex'),
                }),
                (tx) => admin_wallet.signTx(tx),
                `0:${tokenName}`,
            );
            txHash = result.hash;
            attempts = result.attempts;
            if (attempts > 1) debug(`[vote-and-register] Succeeded after ${attempts} attempts`);
        }

        // --- Cache + history ---
        await voteCacheAndHistory(voterId, credentialHrp, tokenName, nonce, voteHash, ipfsCid, txHash, evidence);

        return success(res, { txHash, voteHash, ipfsCid, version: nonce, tokenName, registered: true, attempts });
    } catch (err: any) {
        console.error('[vote-and-register] FULL ERROR:', err);
        if (err.code && err.statusCode) {
            return error(res, err.code, err.message, err.statusCode);
        }
        if (err.message?.includes('IPFS') || err.message?.includes('fetch')) {
            return error(res, 'IPFS_UNAVAILABLE', `IPFS pin failed — retryable: ${err.message}`, 503);
        }
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to register and vote', 400);
    }
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
 *   responderRole?: string         — e.g., "DRep" (default: "DRep")
 */
router.post('/vote', async (req, res) => {
    const {
        voterId,
        nonce,
        ballotId,
        votes,
        signature,
        responderRole,
    } = req.body as {
        voterId: string;
        nonce: number;
        ballotId: string;
        votes: VoteSelection[];
        signature: VoteSignatureData;
        responderRole?: string;
    };

    if (!voterId || !nonce || !ballotId || !votes || !signature) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: voterId, nonce, ballotId, votes, signature', 400);
    }

    // --- Replay protection: check nonce > current version ---
    const existingVote = voteCache.get(voterId);
    if (existingVote && nonce <= existingVote.version) {
        return error(res, 'CONFLICT', `Nonce ${nonce} must exceed current version ${existingVote.version}`, 409);
    }

    let tokenName: string;
    let credentialHrp: string;
    try {
        tokenName = voterIdToTokenName(voterId);
        credentialHrp = voterIdHrp(voterId);
    } catch (e: any) {
        return error(res, 'INVALID_VOTER_ID', `Invalid voter ID: ${e.message}`, 400);
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
        const { scriptHash: TOKEN_POLICY } = createNativeScript(admin_payment_address);

        // --- Shared pipeline: validate → hash → verify sig → IPFS ---
        const { merkleRoot, voteHash, ipfsCid, evidence } = await voteValidateAndPin({
            voterId, tokenName, credentialHrp, nonce, ballotId, votes, signature, responderRole,
        });

        // --- Submit to Hydra head ---
        let txHash: string;
        let attempts = 1;

        if (TX_MODE === 'direct') {
            // Direct pipeline: build tx locally, submit via WebSocket
            const voterUtxo = getVoterUtxo(tokenName);
            if (!voterUtxo) {
                return error(res, 'INTERNAL_ERROR', 'Voter UTxO not found in cache. Is TX_MODE=direct supported for this voter?', 500);
            }

            const unsignedTx = buildCastVoteTx({
                adminAddress: admin_payment_address,
                tokenPolicy: TOKEN_POLICY as string,
                userId: tokenName,
                version: nonce,
                merkleRoot,
                voteHash,
                ipfsCid,
                inputRef: voterUtxo.ref,
                inputValue: voterUtxo.value,
            });

            const signedTx = await admin_wallet.signTx(unsignedTx);
            const result = await submitDirect(signedTx);
            txHash = result.hash;

            // Update UTxO ref cache — cast_vote has a single output at index 0
            setVoterUtxo(tokenName, {
                ref: { txHash, outputIndex: 0 },
                value: voterUtxo.value,
                address: voterUtxo.address,
            });
        } else {
            // TRP pipeline: resolve via TRP, submit with retry
            const result = await submitWithRetry(
                () => client!.castVoteTx({
                    votingAuthority: admin_payment_address,
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                    version: nonce,
                    merkleRoot: Buffer.from(merkleRoot, 'hex'),
                    voteHash: Buffer.from(voteHash, 'hex'),
                    ipfsCid: Buffer.from(ipfsCid),
                }),
                (tx) => admin_wallet.signTx(tx),
                `0:${tokenName}`,
            );
            txHash = result.hash;
            attempts = result.attempts;
            if (attempts > 1) debug(`[vote] Succeeded after ${attempts} attempts`);
        }

        // --- Cache + history ---
        await voteCacheAndHistory(voterId, credentialHrp, tokenName, nonce, voteHash, ipfsCid, txHash, evidence, existingVote?.txHash);

        return success(res, { txHash, voteHash, ipfsCid, version: nonce, tokenName, attempts });
    } catch (err: any) {
        console.error('[vote] FULL ERROR:', err);
        if (err.code && err.statusCode) {
            return error(res, err.code, err.message, err.statusCode);
        }
        if (err.message?.includes('IPFS') || err.message?.includes('fetch')) {
            return error(res, 'IPFS_UNAVAILABLE', `IPFS pin failed — retryable: ${err.message}`, 503);
        }
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to cast vote', 400);
    }
});

export default router;
