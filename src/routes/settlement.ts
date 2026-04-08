import { Router } from 'express';
import { MeshTxBuilder } from '@meshsdk/core';
import { createNativeScript, submitTx, Wrangler } from '@lerna-labs/hydra-sdk';
import { blake2b256, bytesToHex, computePackage } from '@lerna-labs/hydra-proof';
import type { FileLeaf } from '@lerna-labs/hydra-proof';
import { initialize, voterIdToTokenName, TRP_URL, CLOSE_TOKEN, VERBOSE, IPFS_STAGING_DIR, ipfs, voteCache, success, error, debug, parseTrpSubmitResponse, submitWithRetry, hydraMonitor, getHeadId, TX_MODE, getBallotUtxo, setBallotUtxo, getVoterUtxo, deleteVoterUtxo, submitDirect, submitDirectBatch, txQueue } from '../helpers.js';
import { buildCountVoteTx, buildFinalizeBallotTx, hydraValueToAmounts } from '../tx-builder.js';
import { getCachedBallot } from './lifecycle.js';
import { BALLOT_INSTANCE_PREFIX, BALLOT_DEFINITION_PREFIX, BallotStatus, HRP_TO_ROLE } from '../types.js';
import type {
    FullResults,
    QuestionTally,
    OptionTally,
    BallotDefinition,
    BallotInstanceDatum,
    VoteCacheEntry,
    VoteEvidence,
} from '../types.js';

const router = Router();

// ---------------------------------------------------------------------------
// Diagnostic: log head UTxO snapshot
// ---------------------------------------------------------------------------

/** Log the full head UTxO set for diagnostics (only when VERBOSE). */
async function logHeadSnapshot(label: string, wrangler: Wrangler): Promise<void> {
    if (!VERBOSE) return;
    try {
        const snapshot = await wrangler.http.getSnapshotUtxo();
        const entries = Object.entries(snapshot);
        debug(`[settle/${label}] Head UTxO snapshot — ${entries.length} UTxO(s):`);
        for (const [ref, utxo] of entries) {
            const u = utxo as any;
            const tokens: string[] = [];
            for (const [pid, assets] of Object.entries(u.value)) {
                if (pid === 'lovelace') continue;
                if (typeof assets === 'object') {
                    for (const [name, qty] of Object.entries(assets as Record<string, number>)) {
                        tokens.push(`${pid.slice(0, 8)}…${name.slice(0, 16)}…(${qty})`);
                    }
                }
            }
            const lovelace = u.value.lovelace ?? 0;
            const datumTag = u.inlineDatum ? ` datum:constructor=${(u.inlineDatum as any)?.constructor}` : '';
            debug(`  ${ref}: ${lovelace} lovelace${tokens.length ? ' + ' + tokens.join(', ') : ''}${datumTag}`);
        }
    } catch (err: any) {
        debug(`[settle/${label}] Could not fetch snapshot: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Head UTxO–driven voter discovery
// ---------------------------------------------------------------------------

/** Voter info derived from an on-chain voter token UTxO in the Hydra head. */
interface HeadVoterInfo {
    /** Hex asset name (1-byte prefix + 28-byte hash = 58 hex chars). */
    tokenName: string;
    version: number;
    voteHash: string;
    ipfsCid: string;
    /** UTxO reference (txHash#outputIndex). */
    ref: { txHash: string; outputIndex: number };
    /** UTxO value in Amount[] format for MeshTxBuilder. */
    value: Array<{ unit: string; quantity: string }>;
    /** UTxO address. */
    address: string;
}

// ---------------------------------------------------------------------------
// MeshTxBuilder-based in-head finalize (bypasses tx3 for datum encoding test)
// ---------------------------------------------------------------------------

/**
 * Build and submit a finalize transaction inside the Hydra head using
 * MeshTxBuilder. The ballot token UTxO is the sole input (it carries all
 * the ADA + the token). Output is the same UTxO with updated datum.
 *
 * Datum shape: Constr 0 [[ballotId, resultsHash, evidenceCid, merkleRoot], 1]
 * Matches the tx3 BallotResult { Fields: List<Bytes>, Version: Int } type.
 */
async function finalizeBallotViaMesh(
    wrangler: Wrangler,
    adminWallet: any,
    adminAddress: string,
    ballotId: string,
    resultsHash: string,
    evidenceCid: string,
    merkleRoot: string,
): Promise<string> {
    const snapshot = await wrangler.http.getSnapshotUtxo();

    // Find the ballot token UTxO (the only UTxO with the ballot instance token)
    let ballotRef: string | null = null;
    let ballotEntry: any = null;

    for (const [ref, utxo] of Object.entries(snapshot)) {
        const u = utxo as any;
        for (const [pid, assets] of Object.entries(u.value)) {
            if (pid === 'lovelace' || typeof assets !== 'object') continue;
            for (const name of Object.keys(assets as Record<string, number>)) {
                if (name.startsWith(BALLOT_INSTANCE_PREFIX)) {
                    ballotRef = ref;
                    ballotEntry = u;
                    break;
                }
            }
            if (ballotRef) break;
        }
        if (ballotRef) break;
    }

    if (!ballotRef || !ballotEntry) throw new Error('Ballot token UTxO not found in head');

    const [txHash, txIdx] = ballotRef.split('#');

    // Build amount array from snapshot value
    const amount: Array<{ unit: string; quantity: string }> = [];
    for (const [key, val] of Object.entries(ballotEntry.value)) {
        if (key === 'lovelace') {
            amount.push({ unit: 'lovelace', quantity: String(val) });
        } else if (typeof val === 'object') {
            for (const [name, qty] of Object.entries(val as Record<string, number>)) {
                amount.push({ unit: key + name, quantity: String(qty) });
            }
        }
    }

    // Build updated datum: Constr 0 [[fields...], version]
    const toHex = (s: string) => s ? Buffer.from(s, 'utf-8').toString('hex') : '';
    const updatedDatum = {
        alternative: 0,
        fields: [
            [
                ballotId || '',                 // BallotId: Bytes (already hex)
                resultsHash || '',              // ResultsHash: Bytes (already hex)
                toHex(evidenceCid),             // EvidenceCid: Bytes (IPFS CID → hex)
                merkleRoot || '',               // MerkleRoot: Bytes (already hex)
            ],
            1,  // datum schema version
        ],
    };

    debug('[finalizeMesh] Building in-head finalize tx via MeshTxBuilder');
    debug('[finalizeMesh] Ballot UTxO:', ballotRef);
    debug('[finalizeMesh] Datum fields:', JSON.stringify(updatedDatum));

    // Single input → single output, zero fee
    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(txHash, parseInt(txIdx), amount, ballotEntry.address)
        .txOut(adminAddress, amount)
        .txOutInlineDatumValue(updatedDatum)
        .setFee('0')
        .changeAddress(adminAddress);

    const unsignedTx = txBuilder.completeSync();
    const signedTx = await adminWallet.signTx(unsignedTx);

    debug(`[finalizeMesh] Signed tx (${signedTx.length} chars)`);

    // Submit to head via TRP
    const ballotName = amount.find(a => a.unit !== 'lovelace')?.unit.slice(-64) ?? '';
    const submitRes = await submitTx(TRP_URL, signedTx, `0:${ballotName}`);
    const submitText = await submitRes.text();
    debug('[finalizeMesh] submitTx response:', submitText);
    const { hash: finalizeHash } = parseTrpSubmitResponse(submitText);

    return finalizeHash ?? '';
}

/**
 * Query the Hydra head snapshot and return info for every voter token UTxO.
 *
 * This is the authoritative source for "who has voted" — it reads the actual
 * on-chain state rather than relying on the middleware's disk cache.
 */
async function getVotersFromHead(
    wrangler: Wrangler,
    tokenPolicy: string,
): Promise<HeadVoterInfo[]> {
    const snapshotUtxos = await wrangler.http.getSnapshotUtxo();
    const voters: HeadVoterInfo[] = [];

    for (const [utxoRef, utxo] of Object.entries(snapshotUtxos)) {
        const policyAssets = utxo.value[tokenPolicy];
        if (!policyAssets || typeof policyAssets !== 'object') continue;

        for (const assetName of Object.keys(policyAssets as Record<string, number>)) {
            // Skip ballot tokens — only voter tokens
            if (assetName.startsWith(BALLOT_INSTANCE_PREFIX)) continue;
            if (assetName.startsWith(BALLOT_DEFINITION_PREFIX)) continue;

            // Parse the Vote datum: constructor 0, fields [VoterId, Version, MerkleRoot, VoteHash, IpfsCid]
            const datum = utxo.inlineDatum as any;
            if (!datum || datum.constructor !== 0 || !datum.fields || datum.fields.length < 5) {
                console.warn(`[getVotersFromHead] Skipping UTxO with unexpected datum for asset ${assetName}`);
                continue;
            }

            const [txHash, idx] = utxoRef.split('#');
            voters.push({
                tokenName: assetName,
                version: datum.fields[1].int,
                voteHash: datum.fields[3].bytes,
                ipfsCid: Buffer.from(datum.fields[4].bytes, 'hex').toString('utf-8'),
                ref: { txHash, outputIndex: parseInt(idx) },
                value: hydraValueToAmounts(utxo.value),
                address: utxo.address,
            });
        }
    }

    debug(`[getVotersFromHead] Found ${voters.length} voter token(s) in head`);
    return voters;
}

// ---------------------------------------------------------------------------
// Tallying logic
// ---------------------------------------------------------------------------

/** Minimal voter reference needed for tallying — works with both cache and head-derived data. */
interface VoterRef {
    tokenName: string;
    version: number;
    voteHash: string;
}

/**
 * Build raw (unweighted) tallies from voter evidence files on disk.
 *
 * Accepts a `VoterRef[]` so it can be driven by either the vote cache
 * (for the standalone /finalize endpoint) or the head UTxO set (for /settle).
 *
 * Evidence files are looked up by `vote-{tokenName}-v{version}.json`.
 */
/**
 * Tally results, return per-role breakdowns + raw aggregate.
 *
 * Also returns `votersByRole` counts for the FullResults.
 */
async function tallyVotes(
    ballot: BallotDefinition,
    voters: VoterRef[],
    evidenceDir: string,
): Promise<{ tallies: QuestionTally[]; votersByRole: Record<string, number> }> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const evidenceList: VoteEvidence[] = [];
    for (const voter of voters) {
        try {
            const filePath = path.join(evidenceDir, `vote-${voter.tokenName}-v${voter.version}.json`);
            const raw = await fs.readFile(filePath, 'utf-8');
            evidenceList.push(JSON.parse(raw));
        } catch {
            console.warn(`Missing evidence file for token ${voter.tokenName} v${voter.version}, skipping`);
        }
    }

    // Count voters per role
    const votersByRole: Record<string, number> = {};
    for (const evidence of evidenceList) {
        const hrp = evidence.ekklesia?.credentialHrp ?? 'drep';
        const role = HRP_TO_ROLE[hrp] ?? evidence.responderRole ?? 'Unknown';
        votersByRole[role] = (votersByRole[role] ?? 0) + 1;
    }

    // Discover all roles present
    const roles = new Set(Object.keys(votersByRole));

    const tallies = ballot.questions.map((q) => {
        // Per-role counts
        const roleCounts = new Map<string, Map<number, number>>();
        // Aggregate counts
        const rawCounts = new Map<number, number>();

        // Initialize all options to 0
        if (q.options) {
            for (const opt of q.options) {
                rawCounts.set(opt.value, 0);
                for (const role of roles) {
                    if (!roleCounts.has(role)) roleCounts.set(role, new Map());
                    roleCounts.get(role)!.set(opt.value, 0);
                }
            }
        }

        // Count votes grouped by role
        for (const evidence of evidenceList) {
            const hrp = evidence.ekklesia?.credentialHrp ?? 'drep';
            const role = HRP_TO_ROLE[hrp] ?? evidence.responderRole ?? 'Unknown';
            if (!roleCounts.has(role)) roleCounts.set(role, new Map());
            const rc = roleCounts.get(role)!;

            const answer = evidence.answers.find((a) => a.questionId === q.questionId);
            if (!answer) continue;

            const addVote = (option: number, weight = 1) => {
                rawCounts.set(option, (rawCounts.get(option) ?? 0) + weight);
                rc.set(option, (rc.get(option) ?? 0) + weight);
            };

            if (answer.selection) {
                for (const v of answer.selection) addVote(v);
            }
            if (answer.ranking) {
                const firstPref = answer.ranking[0];
                if (firstPref !== undefined) addVote(firstPref);
            }
            if (answer.weights) {
                for (const w of answer.weights) addVote(w.option, w.weight);
            }
        }

        // Build roleResults
        const roleResults: Record<string, { weightingMode: string; results: OptionTally[] }> = {};

        // Per-role buckets
        for (const [role, counts] of roleCounts) {
            roleResults[role] = {
                weightingMode: 'Unweighted',
                results: Array.from(counts.entries()).map(([option, count]) => ({
                    option, count, weight: '0',
                })),
            };
        }

        // Raw aggregate (all roles combined)
        roleResults.raw = {
            weightingMode: 'Unweighted',
            results: Array.from(rawCounts.entries()).map(([option, count]) => ({
                option, count, weight: '0',
            })),
        };

        return { questionId: q.questionId, roleResults };
    });

    return { tallies, votersByRole };
}

/**
 * Convert cache entries to VoterRef for the standalone /finalize endpoint.
 * /settle uses head UTxOs instead.
 */
function cacheToVoterRefs(votes: VoteCacheEntry[]): VoterRef[] {
    return votes.map((v) => ({
        tokenName: voterIdToTokenName(v.voterId),
        version: v.version,
        voteHash: v.voteHash,
    }));
}

// ---------------------------------------------------------------------------
// POST /finalize — tally + IPFS evidence directory + update (601) datum
// ---------------------------------------------------------------------------

/**
 * POST /finalize
 *
 * Tally all votes, pin the complete evidence directory to IPFS,
 * and update the (601) ballot instance datum with results.
 *
 * Body:
 *   ballotId: string       — ballot identifier (ULID or tx hash)
 *   ballotName: string     — hex asset name suffix (fingerprint) of the (601) token
 */
router.post('/finalize', async (req, res) => {
    const { ballotId, ballotName, ballotPolicy } = req.body as {
        ballotId: string;
        ballotName: string;
        ballotPolicy: string;
    };

    if (!ballotId || !ballotName || !ballotPolicy) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: ballotId, ballotName, ballotPolicy', 400);
    }

    const ballot = getCachedBallot();
    if (!ballot) {
        return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached. Was /start called with ballotIpfsCid?', 400);
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

        // --- 1. Gather all votes (cache-based for standalone /finalize) ---
        const allVotes = voteCache.getAll();
        const voterRefs = cacheToVoterRefs(allVotes);

        // --- 2. Build merkle tree of vote evidence ---
        const fileLeaves: FileLeaf[] = voterRefs.map((v) => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));

        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;

        // --- 3. Tally ---
        const { tallies, votersByRole } = await tallyVotes(ballot, voterRefs, voteCache.getDocumentsDir());

        // --- 4. Build full results object ---
        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: allVotes.length,
            votersByRole,
            evidenceIpfsCid: '', // filled after pinning
            headId: getHeadId() ?? '',
            finalizedAt: new Date().toISOString(),
        };

        // --- 5. Write per-voter proof files + history to disk ---
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const evidenceDir = voteCache.getDocumentsDir();
        const proofsDir = pathMod.join(evidenceDir, 'proofs');
        const historyDestDir = pathMod.join(evidenceDir, 'history');
        await fs.mkdir(proofsDir, { recursive: true });
        await fs.mkdir(historyDestDir, { recursive: true });

        // Copy vote history chains into evidence directory
        const historySrcDir = pathMod.join(IPFS_STAGING_DIR, 'history');
        try {
            const historyFiles = await fs.readdir(historySrcDir);
            for (const file of historyFiles) {
                await fs.copyFile(
                    pathMod.join(historySrcDir, file),
                    pathMod.join(historyDestDir, file),
                );
            }
        } catch {
            // History dir may not exist if no votes were updated
        }

        for (const file of proofPackage.files) {
            const voterProof = {
                voterId: file.name,
                contentHashHex: file.contentHashHex,
                leafHashHex: file.leafHashHex,
                merkleRoot: evidenceMerkleRoot,
                proof: file.merkleProof,
            };
            await fs.writeFile(
                pathMod.join(proofsDir, `${file.name}.json`),
                JSON.stringify(voterProof, null, 2),
            );
        }

        // --- 6. Pin everything to IPFS ---
        // Pin results JSON
        const { cid: resultsCid } = await ipfs.pinJson('results.json', fullResults);

        // Pin proof package
        await ipfs.pinJson('proof-package.json', proofPackage);

        // Pin entire evidence directory (vote files + proofs/ + results)
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);

        // Update results with final CID
        fullResults.evidenceIpfsCid = evidenceDirectoryCid;

        // --- 6. Compute results hash ---
        const resultsHash = bytesToHex(blake2b256(JSON.stringify(fullResults)));

        // --- 7. Update (601) datum via TRP ---
        const { hash: txHash, attempts: finalizeAttempts } = await submitWithRetry(
            () => client.finalizeBallotTx({
                votingAuthority: admin_payment_address,
                ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
                ballotToken: Buffer.from(ballotName, 'hex'),
                ballotId: Buffer.from(ballotId, 'hex'),
                resultsHash: Buffer.from(resultsHash, 'hex'),
                evidenceCid: Buffer.from(evidenceDirectoryCid),
                merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
            }),
            (tx) => admin_wallet.signTx(tx),
            `0:${ballotName}`,
        );
        if (finalizeAttempts > 1) debug(`[finalize] Succeeded after ${finalizeAttempts} attempts`);

        return success(res, {
            txHash,
            resultsHash,
            evidenceDirectoryCid,
            resultsCid,
            evidenceMerkleRoot,
            totalVoters: allVotes.length,
            attempts: finalizeAttempts,
        });
    } catch (err: any) {
        console.error('Failed to finalize ballot:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to finalize ballot', 500);
    }
});

// ---------------------------------------------------------------------------
// POST /count — batch burn all voter tokens
// ---------------------------------------------------------------------------

/**
 * POST /count
 *
 * Burn all voter tokens in the head by iterating cached entries.
 * Must be called after /finalize and before /close.
 *
 * Burns are submitted sequentially (each tx depends on UTxO state
 * from the previous one).
 */
router.post('/count', async (req, res) => {
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

        const allVotes = voteCache.getAll();
        const results: Array<{ voterId: string; txHash?: string; attempts?: number; error?: string }> = [];

        for (const vote of allVotes) {
            const tokenName = voterIdToTokenName(vote.voterId);
            try {
                const { hash: txHash, attempts } = await submitWithRetry(
                    () => client.countVoteTx({
                        votingAuthority: admin_payment_address,
                        mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                        tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                        userId: Buffer.from(tokenName, 'hex'),
                    }),
                    (tx) => admin_wallet.signTx(tx),
                    `0:${tokenName}`,
                );
                if (attempts > 1) debug(`[count] Burn for ${vote.voterId} succeeded after ${attempts} attempts`);
                results.push({ voterId: vote.voterId, txHash, attempts });
            } catch (err: any) {
                console.error(`[count] FULL ERROR for ${vote.voterId}:`, err);
                results.push({ voterId: vote.voterId, error: err.message });
            }
        }

        const burned = results.filter((r) => r.txHash).length;
        const failed = results.filter((r) => r.error).length;

        return success(res, { burned, failed, total: allVotes.length, results });
    } catch (err: any) {
        console.error('[count] FULL ERROR:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to burn voter tokens', 500);
    }
});

// ---------------------------------------------------------------------------
// POST /settle — orchestrate full settlement: burn → decommit+finalize → close
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stepped settlement endpoints — break the monolithic /settle into discrete
// steps so each completes within normal HTTP timeout windows.
// ---------------------------------------------------------------------------

/**
 * POST /settle/burn
 *
 * Burn all voter tokens in the head. Non-blocking per-token — in direct mode
 * burns are batched concurrently. Returns burn results immediately.
 *
 * Call this repeatedly until `remaining === 0` before calling /settle/finalize.
 *
 * Body:
 *   ballotPolicy?: string   — optional, derived from admin wallet if omitted
 */
router.post('/settle/burn', async (req, res) => {
    // Ensure vote queue is drained before settlement begins
    if (!txQueue.isDrained()) {
        const qs = txQueue.status();
        return error(res, 'INVALID_INPUT', `Cannot settle: ${qs.built + qs.submitted + qs.accepted} vote(s) still in queue. Wait for queue to drain first.`, 400);
    }

    try {
        const { admin_wallet, client } = await initialize();
        if (!admin_wallet || !client) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet or client', 503);
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;
        const {
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY,
        } = createNativeScript(admin_payment_address);

        const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);
        const headVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);

        if (headVoters.length === 0) {
            return success(res, { burned: 0, failed: 0, remaining: 0, total: 0, message: 'No voter tokens to burn' });
        }

        // Save pre-burn ledger state to disk on the FIRST burn call only.
        // This is the authoritative record of every voter's on-chain state
        // at the moment settlement began. Subsequent burn calls (retries for
        // failed burns) must not overwrite it — the original snapshot is the
        // source of truth for /settle/finalize.
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const ledgerSnapshotPath = pathMod.join(IPFS_STAGING_DIR, 'pre-burn-ledger.json');

        let ledgerExists = false;
        try {
            await fs.access(ledgerSnapshotPath);
            ledgerExists = true;
        } catch { /* doesn't exist yet */ }

        if (!ledgerExists) {
            const ledgerSnapshot = headVoters.map(v => ({
                tokenName: v.tokenName,
                version: v.version,
                voteHash: v.voteHash,
                ipfsCid: v.ipfsCid,
            }));
            await fs.writeFile(ledgerSnapshotPath, JSON.stringify(ledgerSnapshot, null, 2));
            debug(`[settle/burn] Saved pre-burn ledger state: ${headVoters.length} voters → ${ledgerSnapshotPath}`);
        } else {
            debug(`[settle/burn] Pre-burn ledger already exists, skipping (retry burn call)`);
        }

        let burned = 0;
        let burnFailed = 0;

        if (TX_MODE === 'direct') {
            const BURN_BATCH_SIZE = 100;
            const burnTxs: Array<{ signedCborHex: string; unsignedCborHex: string; id: string }> = [];

            for (const voter of headVoters) {
                try {
                    const unsignedTx = buildCountVoteTx({
                        adminAddress: admin_payment_address,
                        tokenPolicy: TOKEN_POLICY as string,
                        tokenScript: TOKEN_SCRIPT as string,
                        userId: voter.tokenName,
                        inputRef: voter.ref,
                        inputValue: voter.value,
                    });
                    const signedTx = await admin_wallet.signTx(unsignedTx);
                    burnTxs.push({ signedCborHex: signedTx, unsignedCborHex: unsignedTx, id: voter.tokenName });
                } catch (err: any) {
                    console.error(`[settle/burn] Failed to build burn tx for ${voter.tokenName}:`, err.message);
                    burnFailed++;
                }
            }

            for (let i = 0; i < burnTxs.length; i += BURN_BATCH_SIZE) {
                const batch = burnTxs.slice(i, i + BURN_BATCH_SIZE);
                debug(`[settle/burn] Batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} (${batch.length} txs)…`);
                const { succeeded, failed } = await submitDirectBatch(batch);
                burned += succeeded.size;
                burnFailed += failed.size;
                for (const [id] of succeeded) deleteVoterUtxo(id);
            }
        } else {
            // TRP mode: batch burns concurrently (non-contending, each voter has own UTxO)
            const BURN_BATCH_SIZE = 100;
            for (let i = 0; i < headVoters.length; i += BURN_BATCH_SIZE) {
                const batch = headVoters.slice(i, i + BURN_BATCH_SIZE);
                debug(`[settle/burn] TRP batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} (${batch.length} txs)…`);
                const batchResults = await Promise.allSettled(batch.map(voter =>
                    submitWithRetry(
                        () => client.countVoteTx({
                            votingAuthority: admin_payment_address,
                            mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                            userId: Buffer.from(voter.tokenName, 'hex'),
                        }),
                        (tx) => admin_wallet.signTx(tx),
                        `0:${voter.tokenName}`,
                    ),
                ));
                for (let j = 0; j < batchResults.length; j++) {
                    if (batchResults[j].status === 'fulfilled') {
                        burned++;
                    } else {
                        console.error(`[settle/burn] FULL ERROR for ${batch[j].tokenName}:`, (batchResults[j] as PromiseRejectedResult).reason?.message);
                        burnFailed++;
                    }
                }
            }
        }

        // Check how many remain
        const remaining = await getVotersFromHead(wrangler, TOKEN_POLICY as string);

        return success(res, {
            burned,
            failed: burnFailed,
            remaining: remaining.length,
            total: headVoters.length,
        });
    } catch (err: any) {
        console.error('[settle/burn] Failed:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Burn failed', 500);
    }
});

/**
 * POST /settle/finalize
 *
 * Tally votes, verify evidence, pin to IPFS, update ballot datum.
 * Only succeeds when all voter tokens have been burned (0 remaining).
 *
 * Body:
 *   ballotId: string       — ballot identifier
 *   ballotName: string     — hex asset name of the (601) token
 *   ballotPolicy: string   — hex policy ID
 */
router.post('/settle/finalize', async (req, res) => {
    const { ballotId, ballotName, ballotPolicy } = req.body as {
        ballotId: string;
        ballotName: string;
        ballotPolicy: string;
    };

    if (!ballotId || !ballotName || !ballotPolicy) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: ballotId, ballotName, ballotPolicy', 400);
    }

    const ballot = getCachedBallot();
    if (!ballot) {
        return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached', 400);
    }

    try {
        const { admin_wallet, client } = await initialize();
        if (!admin_wallet || !client) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet or client', 503);
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;
        const { scriptHash: TOKEN_POLICY } = createNativeScript(admin_payment_address);
        const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);

        // Verify all voter tokens are burned
        const remainingVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);
        if (remainingVoters.length > 0) {
            return error(res, 'INVALID_INPUT', `Cannot finalize: ${remainingVoters.length} voter token(s) still in head. Call /settle/burn first.`, 400);
        }

        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const evidenceDir = voteCache.getDocumentsDir();

        // --- Load pre-burn ledger snapshot (written by /settle/burn) ---
        // This is the authoritative record of every voter's on-chain state
        // at the moment settlement began — the source of truth for the evidence package.
        const ledgerSnapshotPath = pathMod.join(IPFS_STAGING_DIR, 'pre-burn-ledger.json');
        let ledgerVoters: Array<{ tokenName: string; version: number; voteHash: string; ipfsCid: string }>;
        try {
            const raw = await fs.readFile(ledgerSnapshotPath, 'utf-8');
            ledgerVoters = JSON.parse(raw);
        } catch {
            return error(res, 'INVALID_INPUT', 'Pre-burn ledger snapshot not found. Call /settle/burn before /settle/finalize.', 400);
        }

        debug(`[settle/finalize] Loaded pre-burn ledger: ${ledgerVoters.length} voters`);

        // --- Verify evidence against pre-burn ledger state ---
        // Only voters with matching evidence files make it into the results.
        // Voters without evidence are flagged for transparency.
        const verifiedVoters: VoterRef[] = [];
        const excludedVoters: Array<{ tokenName: string; reason: string }> = [];

        for (const voter of ledgerVoters) {
            // Try to find matching evidence file on disk
            const evidenceFile = `vote-${voter.tokenName}-v${voter.version}.json`;
            const evidencePath = pathMod.join(evidenceDir, evidenceFile);
            try {
                const raw = await fs.readFile(evidencePath, 'utf-8');
                const evidence = JSON.parse(raw);
                const fileHash = bytesToHex(blake2b256(JSON.stringify(evidence)));
                if (fileHash === voter.voteHash) {
                    verifiedVoters.push({
                        tokenName: voter.tokenName,
                        version: voter.version,
                        voteHash: voter.voteHash,
                    });
                    continue;
                }
                // Hash mismatch
                excludedVoters.push({
                    tokenName: voter.tokenName,
                    reason: `evidence hash mismatch: file=${fileHash.slice(0, 16)}… ledger=${voter.voteHash.slice(0, 16)}…`,
                });
            } catch {
                excludedVoters.push({
                    tokenName: voter.tokenName,
                    reason: `evidence file not found: ${evidenceFile}`,
                });
            }
        }

        debug(`[settle/finalize] Verified: ${verifiedVoters.length}, excluded: ${excludedVoters.length}`);

        // Build merkle tree + tally from verified voters only
        const fileLeaves: FileLeaf[] = verifiedVoters.map(v => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;
        const { tallies, votersByRole } = await tallyVotes(ballot, verifiedVoters, evidenceDir);

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: verifiedVoters.length,
            votersByRole,
            evidenceIpfsCid: '',
            headId: getHeadId() ?? '',
            finalizedAt: new Date().toISOString(),
            excludedVoters: excludedVoters.length > 0 ? excludedVoters : undefined,
        };

        // Write proofs + history + exclusions
        const proofsDir = pathMod.join(evidenceDir, 'proofs');
        const historyDestDir = pathMod.join(evidenceDir, 'history');
        await fs.mkdir(proofsDir, { recursive: true });
        await fs.mkdir(historyDestDir, { recursive: true });

        // Save pre-burn ledger into evidence directory for auditors
        await fs.copyFile(ledgerSnapshotPath, pathMod.join(evidenceDir, 'pre-burn-ledger.json'));

        // Save exclusions manifest if any
        if (excludedVoters.length > 0) {
            await fs.writeFile(
                pathMod.join(evidenceDir, 'exclusions.json'),
                JSON.stringify(excludedVoters, null, 2),
            );
        }

        const historySrcDir = pathMod.join(IPFS_STAGING_DIR, 'history');
        try {
            const historyFiles = await fs.readdir(historySrcDir);
            for (const file of historyFiles) {
                await fs.copyFile(pathMod.join(historySrcDir, file), pathMod.join(historyDestDir, file));
            }
        } catch { /* history dir may not exist */ }

        for (const file of proofPackage.files) {
            await fs.writeFile(
                pathMod.join(proofsDir, `${file.name}.json`),
                JSON.stringify({ voterId: file.name, contentHashHex: file.contentHashHex, leafHashHex: file.leafHashHex, merkleRoot: evidenceMerkleRoot, proof: file.merkleProof }, null, 2),
            );
        }

        // Pin to IPFS
        await ipfs.pinJson('results.json', fullResults);
        await ipfs.pinJson('proof-package.json', proofPackage);
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);
        fullResults.evidenceIpfsCid = evidenceDirectoryCid;
        const resultsHash = bytesToHex(blake2b256(JSON.stringify(fullResults)));

        // Finalize ballot datum in-head
        let finalizeTxHash: string;

        if (TX_MODE === 'direct') {
            let ballotUtxo = getBallotUtxo();
            if (!ballotUtxo) {
                const snap = await wrangler.http.getSnapshotUtxo();
                for (const [ref, utxo] of Object.entries(snap)) {
                    const u = utxo as any;
                    for (const [pid, assets] of Object.entries(u.value)) {
                        if (pid === 'lovelace' || typeof assets !== 'object') continue;
                        for (const name of Object.keys(assets as Record<string, number>)) {
                            if (name.startsWith(BALLOT_INSTANCE_PREFIX)) {
                                const [txH, idx] = ref.split('#');
                                ballotUtxo = { ref: { txHash: txH, outputIndex: parseInt(idx) }, value: hydraValueToAmounts(u.value), datum: u.inlineDatum, address: u.address };
                                break;
                            }
                        }
                        if (ballotUtxo) break;
                    }
                    if (ballotUtxo) break;
                }
            }
            if (!ballotUtxo) throw new Error('Ballot UTxO not found for finalize');

            const unsignedTx = buildFinalizeBallotTx({
                adminAddress: admin_payment_address,
                ballotId, resultsHash,
                evidenceCid: evidenceDirectoryCid,
                merkleRoot: evidenceMerkleRoot,
                inputRef: ballotUtxo.ref,
                inputValue: ballotUtxo.value,
            });
            const signedTx = await admin_wallet.signTx(unsignedTx);
            const result = await submitDirect(signedTx, unsignedTx);
            finalizeTxHash = result.hash;
        } else {
            const result = await submitWithRetry(
                () => client.finalizeBallotTx({
                    votingAuthority: admin_payment_address,
                    ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
                    ballotToken: Buffer.from(ballotName, 'hex'),
                    ballotId: Buffer.from(ballotId, 'hex'),
                    resultsHash: Buffer.from(resultsHash, 'hex'),
                    evidenceCid: Buffer.from(evidenceDirectoryCid),
                    merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
                }),
                (tx) => admin_wallet.signTx(tx),
                `0:${ballotName}`,
            );
            finalizeTxHash = result.hash;
        }

        return success(res, {
            txHash: finalizeTxHash,
            resultsHash,
            evidenceDirectoryCid,
            evidenceMerkleRoot,
            totalVoters: verifiedVoters.length,
            excludedVoters: excludedVoters.length > 0 ? excludedVoters : undefined,
        });
    } catch (err: any) {
        console.error('[settle/finalize] Failed:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Finalize failed', 500);
    }
});

/**
 * POST /settle/close
 *
 * Close the Hydra head after finalization. Triggers L1 close + fanout.
 *
 * Body:
 *   closeToken: string — required to authorize head close
 */
router.post('/settle/close', async (req, res) => {
    const { closeToken } = req.body as { closeToken: string };

    if (!closeToken || closeToken !== CLOSE_TOKEN) {
        return error(res, 'CLOSE_TOKEN_INVALID', 'Incorrect close token', 400);
    }

    try {
        const currentStatus = hydraMonitor.headStatus;
        debug(`[settle/close] Current status: ${currentStatus}`);

        if (currentStatus === 'FINAL') {
            return success(res, { status: 'FINAL', message: 'Head already finalized' });
        }

        if (currentStatus === 'FANOUT_POSSIBLE') {
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
            return success(res, { status: 'FINAL' });
        }

        if (currentStatus === 'CLOSED') {
            await hydraMonitor.waitForStatus('FANOUT_POSSIBLE', 300_000);
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
            return success(res, { status: 'FINAL' });
        }

        // Head is still Open — close it
        hydraMonitor.ws.send({ tag: 'Close' });

        const onStatus = (status: string) => {
            if (status === 'FANOUT_POSSIBLE') {
                debug('[settle/close] Fanout possible, sending Fanout…');
                hydraMonitor.ws.send({ tag: 'Fanout' });
            }
        };
        hydraMonitor.on('status', onStatus);

        try {
            await hydraMonitor.waitForStatus('FINAL', 600_000);
        } finally {
            hydraMonitor.removeListener('status', onStatus);
        }

        return success(res, { status: 'FINAL' });
    } catch (err: any) {
        console.error('[settle/close] Failed:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Close failed', 500);
    }
});

// ---------------------------------------------------------------------------
// POST /settle — monolithic settlement (kept for backwards compatibility)
// ---------------------------------------------------------------------------

/**
 * POST /settle
 *
 * Full settlement orchestration (single request).
 *   1. Burn all voter tokens (in-head via TRP)
 *   2. Tally votes + pin evidence to IPFS
 *   3. Build finalize tx via TRP and submit it as a **decommit** — the ballot
 *      token leaves the head with its updated BallotResult datum and settles
 *      directly to L1, bypassing fanout entirely
 *   4. Close the head — fanout is trivial (ADA-only, no datums/tokens)
 *
 * Body:
 *   ballotId: string       — ballot identifier (ULID or tx hash)
 *   ballotName: string     — hex fingerprint of the ballot tokens
 *   ballotPolicy: string   — hex policy ID of the ballot tokens
 *   closeToken: string     — required to authorize head close
 */
router.post('/settle', async (req, res) => {
    const { ballotId, ballotName, ballotPolicy, closeToken } = req.body as {
        ballotId: string;
        ballotName: string;
        ballotPolicy: string;
        closeToken: string;
    };

    if (!ballotId || !ballotName || !ballotPolicy || !closeToken) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: ballotId, ballotName, ballotPolicy, closeToken', 400);
    }

    if (closeToken !== CLOSE_TOKEN) {
        return error(res, 'CLOSE_TOKEN_INVALID', 'Incorrect close token', 400);
    }

    const steps: Array<{ step: string; status: string; data?: any; error?: string }> = [];

    try {
        const ballot = getCachedBallot();
        if (!ballot) {
            return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached', 400);
        }

        const { admin_wallet, client } = await initialize();
        if (!admin_wallet || !client) {
            return error(res, 'WALLET_INIT_FAILED', 'Could not initialize admin wallet or client', 503);
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;
        const {
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY,
        } = createNativeScript(admin_payment_address);

        const wrangler = new Wrangler(process.env.HYDRA_API_URL, undefined, hydraMonitor);

        // --- Step 0: Snapshot + query authoritative voter list from head UTxOs ---
        // The head's UTxO set is the ground truth. The disk cache can have
        // stale entries from previous sessions — never use it for settlement.
        await logHeadSnapshot('pre-burn', wrangler);
        const headVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);

        // --- Step 1: Burn all voter tokens ---
        // Burns use the UTxO refs captured in the single snapshot from Step 0.
        // All voters are burned regardless of evidence verification status.
        // Burns are non-contending (each spends a unique voter UTxO), so they
        // can be batched concurrently in direct mode.
        let burned = 0;
        let burnFailed = 0;
        let burnTotalAttempts = 0;
        let burnMaxAttempts = 0;

        if (TX_MODE === 'direct') {
            // Build all burn txs, then submit in batches
            const BURN_BATCH_SIZE = 100;
            const burnTxs: Array<{ signedCborHex: string; unsignedCborHex: string; id: string }> = [];

            for (const voter of headVoters) {
                try {
                    const unsignedTx = buildCountVoteTx({
                        adminAddress: admin_payment_address,
                        tokenPolicy: TOKEN_POLICY as string,
                        tokenScript: TOKEN_SCRIPT as string,
                        userId: voter.tokenName,
                        inputRef: voter.ref,
                        inputValue: voter.value,
                    });
                    const signedTx = await admin_wallet.signTx(unsignedTx);
                    burnTxs.push({ signedCborHex: signedTx, unsignedCborHex: unsignedTx, id: voter.tokenName });
                } catch (err: any) {
                    console.error(`[settle/burn] Failed to build burn tx for ${voter.tokenName}:`, err.message);
                    burnFailed++;
                }
            }

            // Submit in batches
            for (let i = 0; i < burnTxs.length; i += BURN_BATCH_SIZE) {
                const batch = burnTxs.slice(i, i + BURN_BATCH_SIZE);
                debug(`[settle/burn] Submitting batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} (${batch.length} txs)…`);
                const { succeeded, failed } = await submitDirectBatch(batch);
                burned += succeeded.size;
                burnFailed += failed.size;
                burnTotalAttempts += batch.length;

                for (const [id] of succeeded) deleteVoterUtxo(id);
                for (const [id, reason] of failed) {
                    console.error(`[settle/burn] Batch burn failed for ${id}: ${reason.slice(0, 100)}`);
                }
            }
        } else {
            // TRP mode: batched burns (non-contending, each voter has own UTxO)
            const BURN_BATCH_SIZE = 100;
            for (let i = 0; i < headVoters.length; i += BURN_BATCH_SIZE) {
                const batch = headVoters.slice(i, i + BURN_BATCH_SIZE);
                debug(`[settle/burn] TRP batch ${Math.floor(i / BURN_BATCH_SIZE) + 1} (${batch.length} txs)…`);
                const batchResults = await Promise.allSettled(batch.map(voter =>
                    submitWithRetry(
                        () => client.countVoteTx({
                            votingAuthority: admin_payment_address,
                            mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                            userId: Buffer.from(voter.tokenName, 'hex'),
                        }),
                        (tx) => admin_wallet.signTx(tx),
                        `0:${voter.tokenName}`,
                    ),
                ));
                for (let j = 0; j < batchResults.length; j++) {
                    const r = batchResults[j];
                    if (r.status === 'fulfilled') {
                        const { attempts } = r.value;
                        burnTotalAttempts += attempts;
                        burnMaxAttempts = Math.max(burnMaxAttempts, attempts);
                        burned++;
                    } else {
                        console.error(`[settle/burn] FULL ERROR for ${batch[j].tokenName}:`, r.reason?.message);
                        burnFailed++;
                    }
                }
            }
        }

        // Verify all voter tokens are burned — re-query snapshot and retry any remaining
        if (burnFailed > 0) {
            debug(`[settle/burn] ${burnFailed} burns failed, checking head for remaining voter tokens…`);
            const retryVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);
            if (retryVoters.length > 0) {
                debug(`[settle/burn] ${retryVoters.length} voter tokens still in head, retrying…`);
                for (const voter of retryVoters) {
                    try {
                        if (TX_MODE === 'direct') {
                            const unsignedTx = buildCountVoteTx({
                                adminAddress: admin_payment_address,
                                tokenPolicy: TOKEN_POLICY as string,
                                tokenScript: TOKEN_SCRIPT as string,
                                userId: voter.tokenName,
                                inputRef: voter.ref,
                                inputValue: voter.value,
                            });
                            const signedTx = await admin_wallet.signTx(unsignedTx);
                            await submitDirect(signedTx, unsignedTx, { awaitSnapshot: false });
                        } else {
                            await submitWithRetry(
                                () => client.countVoteTx({
                                    votingAuthority: admin_payment_address,
                                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                                    userId: Buffer.from(voter.tokenName, 'hex'),
                                }),
                                (tx) => admin_wallet.signTx(tx),
                                `0:${voter.tokenName}`,
                            );
                        }
                        burned++;
                        burnFailed--;
                        debug(`[settle/burn] Retry burn succeeded for ${voter.tokenName}`);
                    } catch (retryErr: any) {
                        console.error(`[settle/burn] Retry burn FAILED for ${voter.tokenName}:`, retryErr.message);
                    }
                }
            }
        }

        // Final check: head must have only the ballot token before proceeding
        const postBurnVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);
        if (postBurnVoters.length > 0) {
            const remaining = postBurnVoters.map(v => v.tokenName.slice(0, 16)).join(', ');
            return error(res, 'INTERNAL_ERROR', `Cannot finalize: ${postBurnVoters.length} voter token(s) still in head (${remaining}…). All tokens must be burned before close.`, 500);
        }

        const burnRetries = burnTotalAttempts - burned;
        steps.push({
            step: 'burn',
            status: burnFailed === 0 ? 'SUCCESS' : 'PARTIAL',
            data: { burned, failed: burnFailed, total: headVoters.length, retries: burnRetries, maxAttempts: burnMaxAttempts },
        });

        // --- Step 2: Verify evidence against on-chain state ---
        // The head's UTxO set is the source of truth. Only voters whose
        // on-chain voteHash can be matched to a local evidence file are
        // included in the results. This ensures the evidence package
        // reflects strictly the final Hydra ledger state.
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const evidenceDir = voteCache.getDocumentsDir();

        const allCached = voteCache.getAll();
        const cacheByTokenName = new Map(allCached.map(v => {
            try { return [voterIdToTokenName(v.voterId), v] as const; }
            catch { return ['', v] as const; }
        }));

        const verifiedVoters: HeadVoterInfo[] = [];
        const excludedVoters: Array<{ tokenName: string; reason: string }> = [];

        for (const voter of headVoters) {
            const cached = cacheByTokenName.get(voter.tokenName);

            // Case 1: cache matches on-chain
            if (cached && cached.voteHash === voter.voteHash) {
                verifiedVoters.push(voter);
                continue;
            }

            // Case 2: cache mismatch or missing — look for evidence file on disk for on-chain version
            const evidenceFile = `vote-${voter.tokenName}-v${voter.version}.json`;
            const evidencePath = pathMod.join(evidenceDir, evidenceFile);
            try {
                const raw = await fs.readFile(evidencePath, 'utf-8');
                const evidence = JSON.parse(raw);
                const fileHash = bytesToHex(blake2b256(JSON.stringify(evidence)));
                if (fileHash === voter.voteHash) {
                    verifiedVoters.push(voter);
                    debug(`[settle] Recovered evidence for ${voter.tokenName} v${voter.version} from disk`);
                    continue;
                }
            } catch { /* file not found */ }

            // Case 3: no matching evidence anywhere — exclude
            const reason = cached
                ? `cache has v${cached.version} (hash=${cached.voteHash.slice(0, 16)}…) but on-chain is v${voter.version} (hash=${voter.voteHash.slice(0, 16)}…)`
                : 'not in local cache and no evidence file on disk';
            console.warn(`[settle] Excluding ${voter.tokenName}: ${reason}`);
            excludedVoters.push({ tokenName: voter.tokenName, reason });
        }

        debug(`[settle] Verified: ${verifiedVoters.length}, excluded: ${excludedVoters.length}`);

        // --- Step 3: Tally + IPFS evidence (verified voters only) ---
        const fileLeaves: FileLeaf[] = verifiedVoters.map((v) => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;
        const { tallies, votersByRole } = await tallyVotes(ballot, verifiedVoters, evidenceDir);

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: verifiedVoters.length,
            votersByRole,
            evidenceIpfsCid: '',
            headId: getHeadId() ?? '',
            finalizedAt: new Date().toISOString(),
            excludedVoters: excludedVoters.length > 0 ? excludedVoters : undefined,
        };

        const proofsDir = pathMod.join(evidenceDir, 'proofs');
        const historyDestDir = pathMod.join(evidenceDir, 'history');
        await fs.mkdir(proofsDir, { recursive: true });
        await fs.mkdir(historyDestDir, { recursive: true });

        // Write exclusions manifest if any voters were excluded
        if (excludedVoters.length > 0) {
            await fs.writeFile(
                pathMod.join(evidenceDir, 'exclusions.json'),
                JSON.stringify(excludedVoters, null, 2),
            );
        }

        // Copy vote history chains into evidence directory so auditors
        // can verify the full vote update trail (nonce progression,
        // prevTxHash linkage) alongside the evidence files.
        const historySrcDir = pathMod.join(IPFS_STAGING_DIR, 'history');
        try {
            const historyFiles = await fs.readdir(historySrcDir);
            for (const file of historyFiles) {
                await fs.copyFile(
                    pathMod.join(historySrcDir, file),
                    pathMod.join(historyDestDir, file),
                );
            }
            debug(`[settle] Copied ${historyFiles.length} history files into evidence directory`);
        } catch {
            // History dir may not exist if no votes were updated
        }

        for (const file of proofPackage.files) {
            const voterProof = {
                voterId: file.name,
                contentHashHex: file.contentHashHex,
                leafHashHex: file.leafHashHex,
                merkleRoot: evidenceMerkleRoot,
                proof: file.merkleProof,
            };
            await fs.writeFile(
                pathMod.join(proofsDir, `${file.name}.json`),
                JSON.stringify(voterProof, null, 2),
            );
        }

        await ipfs.pinJson('results.json', fullResults);
        await ipfs.pinJson('proof-package.json', proofPackage);
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);
        fullResults.evidenceIpfsCid = evidenceDirectoryCid;
        const resultsHash = bytesToHex(blake2b256(JSON.stringify(fullResults)));

        await logHeadSnapshot('post-burn', wrangler);

        // --- Step 3: Finalize ballot datum in-head ---
        let finalizeTxHash: string;
        let finalizeAttempts = 1;

        if (TX_MODE === 'direct') {
            let ballotUtxo = getBallotUtxo();
            if (!ballotUtxo) {
                // Fallback: find from snapshot
                const snap = await wrangler.http.getSnapshotUtxo();
                for (const [ref, utxo] of Object.entries(snap)) {
                    const u = utxo as any;
                    for (const [pid, assets] of Object.entries(u.value)) {
                        if (pid === 'lovelace' || typeof assets !== 'object') continue;
                        for (const name of Object.keys(assets as Record<string, number>)) {
                            if (name.startsWith(BALLOT_INSTANCE_PREFIX)) {
                                const [txH, idx] = ref.split('#');
                                ballotUtxo = {
                                    ref: { txHash: txH, outputIndex: parseInt(idx) },
                                    value: hydraValueToAmounts(u.value),
                                    datum: u.inlineDatum,
                                    address: u.address,
                                };
                                break;
                            }
                        }
                        if (ballotUtxo) break;
                    }
                    if (ballotUtxo) break;
                }
            }
            if (!ballotUtxo) throw new Error('Ballot UTxO not found for finalize');

            const unsignedTx = buildFinalizeBallotTx({
                adminAddress: admin_payment_address,
                ballotId,
                resultsHash,
                evidenceCid: evidenceDirectoryCid,
                merkleRoot: evidenceMerkleRoot,
                inputRef: ballotUtxo.ref,
                inputValue: ballotUtxo.value,
            });
            const signedTx = await admin_wallet.signTx(unsignedTx);
            const result = await submitDirect(signedTx, unsignedTx);
            finalizeTxHash = result.hash;

            setBallotUtxo({
                ref: { txHash: finalizeTxHash, outputIndex: 0 },
                value: ballotUtxo.value,
                datum: ballotUtxo.datum,
                address: ballotUtxo.address,
            });
        } else {
            const result = await submitWithRetry(
                () => client.finalizeBallotTx({
                    votingAuthority: admin_payment_address,
                    ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
                    ballotToken: Buffer.from(ballotName, 'hex'),
                    ballotId: Buffer.from(ballotId, 'hex'),
                    resultsHash: Buffer.from(resultsHash, 'hex'),
                    evidenceCid: Buffer.from(evidenceDirectoryCid),
                    merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
                }),
                (tx) => admin_wallet.signTx(tx),
                `0:${ballotName}`,
            );
            finalizeTxHash = result.hash;
            finalizeAttempts = result.attempts;
            if (finalizeAttempts > 1) debug(`[settle/finalize] Succeeded after ${finalizeAttempts} attempts`);
        }

        steps.push({
            step: 'finalize',
            status: 'SUCCESS',
            data: { txHash: finalizeTxHash, resultsHash, evidenceDirectoryCid, totalVoters: headVoters.length, attempts: finalizeAttempts },
        });

        await logHeadSnapshot('post-finalize', wrangler);

        // --- Step 4: Close head — fanout includes ballot token with finalized datum ---
        // Use the monitor's status tracking to avoid missing events that fired
        // before the listener was registered (race condition with shared WebSocket).
        const currentStatus = hydraMonitor.headStatus;
        debug(`[settle/close] Current monitor status: ${currentStatus}`);

        if (currentStatus === 'FINAL') {
            debug('[settle/close] Head already finalized');
        } else if (currentStatus === 'FANOUT_POSSIBLE') {
            debug('[settle/close] Fanout possible, sending Fanout…');
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
        } else if (currentStatus === 'CLOSED') {
            debug('[settle/close] Head closed, waiting for fanout…');
            await hydraMonitor.waitForStatus('FANOUT_POSSIBLE', 300_000);
            hydraMonitor.ws.send({ tag: 'Fanout' });
            await hydraMonitor.waitForStatus('FINAL', 600_000);
        } else {
            // Head is still Open — send Close and wait through the full lifecycle
            debug('[settle/close] Closing head…');
            hydraMonitor.ws.send({ tag: 'Close' });

            // Listen for ReadyToFanout to send Fanout command
            const onStatus = (status: string) => {
                if (status === 'FANOUT_POSSIBLE') {
                    debug('[settle/close] Fanout possible, sending Fanout…');
                    hydraMonitor.ws.send({ tag: 'Fanout' });
                }
            };
            hydraMonitor.on('status', onStatus);

            try {
                await hydraMonitor.waitForStatus('FINAL', 600_000);
            } finally {
                hydraMonitor.removeListener('status', onStatus);
            }
        }

        steps.push({ step: 'close', status: 'SUCCESS' });

        return success(res, {
            steps,
            resultsHash,
            evidenceDirectoryCid,
            evidenceMerkleRoot,
            totalVoters: headVoters.length,
        });
    } catch (err: any) {
        console.error('Settlement failed:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Settlement failed', 500);
    }
});

export default router;
