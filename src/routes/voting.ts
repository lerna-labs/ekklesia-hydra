import {Router} from 'express';
import {createNativeScript, submitTx, verifySignature} from '@lerna-labs/hydra-sdk';
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
    TRP_URL,
    voteCache,
    voterIdHrp,
    voterIdToTokenName,
    debug,
} from '../helpers.js';
import {getCachedBallot} from './lifecycle.js';
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

const router = Router();

router.post('/register', async (req, res) => {
    const voterId = req.body.voterId;
    const tokenName = voterIdToTokenName(voterId);

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

        const trp_response = await client.registerVoterTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
            userId: Buffer.from(tokenName, 'hex'),
        });

        const signedTx = await admin_wallet.signTx(trp_response.tx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${tokenName}`);
        const response_json = await submit_response.json() as { hash?: string };

        return success(res, { txHash: response_json.hash, tokenName });
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
    const tokenName = voterIdToTokenName(voterId);
    const credentialHrp = voterIdHrp(voterId);

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

        // --- 0. Validate votes against ballot ---
        const ballot = getCachedBallot();
        if (ballot) {
            const selError = validateSelections(votes, ballot);
            if (selError) {
                return error(res, 'INVALID_INPUT', selError, 400);
            }
        }

        // --- 1. Build signed payload (timestamp excluded — nonce provides replay protection) ---
        const timestamp = new Date().toISOString();

        const signedPayload: SignedVotePayload = {
            ballotId,
            nonce,
            votes,
        };

        // --- 2. Compute hashes ---
        const merkleRoot = bytesToHex(blake2b256(JSON.stringify(signedPayload)));

        // --- 2a. Verify signature(s) ---
        const { error: sigError, witnesses } = verifyVoteSignatures(merkleRoot, voterId, signature);
        if (sigError) {
            return error(res, 'SIGNATURE_INVALID', sigError, 401);
        }

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

        const evidenceJson = JSON.stringify(evidence);
        const voteHash = bytesToHex(blake2b256(evidenceJson));

        // --- 3. Pin to IPFS ---
        const { cid: ipfsCid } = await ipfs.pinJson(
            `vote-${tokenName}-v${nonce}.json`,
            evidence,
        );

        // --- 4. Submit combined register+vote via TRP ---
        const trp_response = await client.voteAndRegisterTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
            userId: Buffer.from(tokenName, 'hex'),
            merkleRoot: Buffer.from(merkleRoot, 'hex'),
            voteHash: Buffer.from(voteHash, 'hex'),
            ipfsCid: Buffer.from(ipfsCid),
        });

        debug(`[vote-and-register] unsigned tx (${trp_response.tx?.length ?? 0} chars):`, trp_response.tx);
        const signedTx = await admin_wallet.signTx(trp_response.tx);
        debug(`[vote-and-register] signed tx (${signedTx?.length ?? 0} chars):`, signedTx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${tokenName}`);
        const submit_text = await submit_response.text();
        debug(`[vote-and-register] submitTx response (${submit_response.status}):`, submit_text);
        let response_json: { hash?: string };
        try {
            response_json = JSON.parse(submit_text);
        } catch {
            console.error('[vote-and-register] Failed to parse submit response:', submit_text);
            response_json = {};
        }

        // --- 5. Cache ---
        const cacheEntry: VoteCacheEntry = {
            voterId,
            credentialHrp,
            voteHash,
            ipfsCid,
            txHash: response_json.hash,
            version: nonce,
            timestamp: Date.now(),
        };

        await voteCache.put(
            cacheEntry,
            `vote-${tokenName}-v${nonce}.json`,
            evidence,
        );

        // --- 5a. Append vote history ---
        await appendVoteHistory(voterId, {
            version: nonce,
            voteHash,
            ipfsCid,
            txHash: response_json.hash ?? '',
            timestamp: Date.now(),
        });

        // --- 6. Receipt ---
        return success(res, {
            txHash: response_json.hash,
            voteHash,
            ipfsCid,
            version: nonce,
            tokenName,
            registered: true,
        });
    } catch (err: any) {
        console.error('[vote-and-register] FULL ERROR:', err);
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

    const tokenName = voterIdToTokenName(voterId);
    const credentialHrp = voterIdHrp(voterId);

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

        // --- 0. Validate votes against ballot ---
        const ballot = getCachedBallot();
        if (ballot) {
            const selError = validateSelections(votes, ballot);
            if (selError) {
                return error(res, 'INVALID_INPUT', selError, 400);
            }
        }

        // --- 1. Build signed payload (timestamp excluded — nonce provides replay protection) ---
        const timestamp = new Date().toISOString();

        const signedPayload: SignedVotePayload = {
            ballotId,
            nonce,
            votes,
        };

        const merkleRoot = bytesToHex(blake2b256(JSON.stringify(signedPayload)));

        // --- 2. Verify signature(s) ---
        const { error: sigError, witnesses } = verifyVoteSignatures(merkleRoot, voterId, signature);
        if (sigError) {
            return error(res, 'SIGNATURE_INVALID', sigError, 401);
        }

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

        const evidenceJson = JSON.stringify(evidence);
        const voteHash = bytesToHex(blake2b256(evidenceJson));

        // --- 3. Pin evidence to IPFS ---
        const { cid: ipfsCid } = await ipfs.pinJson(
            `vote-${tokenName}-v${nonce}.json`,
            evidence,
        );

        // --- 4. Submit slim params to TRP ---
        const trp_response = await client.castVoteTx({
            votingAuthority: admin_payment_address,
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
            userId: Buffer.from(tokenName, 'hex'),
            version: nonce,
            merkleRoot: Buffer.from(merkleRoot, 'hex'),
            voteHash: Buffer.from(voteHash, 'hex'),
            ipfsCid: Buffer.from(ipfsCid),
        });

        debug(`[vote] unsigned tx (${trp_response.tx?.length ?? 0} chars):`, trp_response.tx);
        const signedTx = await admin_wallet.signTx(trp_response.tx);
        debug(`[vote] signed tx (${signedTx?.length ?? 0} chars):`, signedTx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${tokenName}`);
        const submit_text = await submit_response.text();
        debug(`[vote] submitTx response (${submit_response.status}):`, submit_text);
        let response_json: { hash?: string };
        try {
            response_json = JSON.parse(submit_text);
        } catch {
            console.error('[vote] Failed to parse submit response:', submit_text);
            response_json = {};
        }

        // --- 5. Write to cache ---
        const cacheEntry: VoteCacheEntry = {
            voterId,
            credentialHrp,
            voteHash,
            ipfsCid,
            txHash: response_json.hash,
            version: nonce,
            timestamp: Date.now(),
        };

        await voteCache.put(
            cacheEntry,
            `vote-${tokenName}-v${nonce}.json`,
            evidence,
        );

        // --- 5a. Append vote history ---
        await appendVoteHistory(voterId, {
            version: nonce,
            voteHash,
            ipfsCid,
            txHash: response_json.hash ?? '',
            prevTxHash: existingVote?.txHash,
            timestamp: Date.now(),
        });

        // --- 6. Return receipt ---
        return success(res, {
            txHash: response_json.hash,
            voteHash,
            ipfsCid,
            version: nonce,
            tokenName,
        });
    } catch (err: any) {
        console.error('[vote] FULL ERROR:', err);
        if (err.message?.includes('IPFS') || err.message?.includes('fetch')) {
            return error(res, 'IPFS_UNAVAILABLE', `IPFS pin failed — retryable: ${err.message}`, 503);
        }
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to cast vote', 400);
    }
});

export default router;
