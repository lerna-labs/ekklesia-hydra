import { Router } from 'express';
import { createNativeScript, submitTx, Wrangler } from '@lerna-labs/hydra-sdk';
import { blake2b256, bytesToHex, computePackage } from '@lerna-labs/hydra-proof';
import type { FileLeaf } from '@lerna-labs/hydra-proof';
import { initialize, voterIdToTokenName, TRP_URL, CLOSE_TOKEN, VERBOSE, ipfs, voteCache, success, error, debug, parseTrpSubmitResponse } from '../helpers.js';
import { getCachedBallot } from './lifecycle.js';
import { BALLOT_INSTANCE_PREFIX, BALLOT_DEFINITION_PREFIX } from '../types.js';
import type {
    FullResults,
    QuestionTally,
    OptionTally,
    BallotDefinition,
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

    for (const [, utxo] of Object.entries(snapshotUtxos)) {
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

            voters.push({
                tokenName: assetName,
                version: datum.fields[1].int,
                voteHash: datum.fields[3].bytes,
                ipfsCid: Buffer.from(datum.fields[4].bytes, 'hex').toString('utf-8'),
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
async function tallyVotes(
    ballot: BallotDefinition,
    voters: VoterRef[],
    evidenceDir: string,
): Promise<QuestionTally[]> {
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

    return ballot.questions.map((q) => {
        const counts = new Map<number, number>();
        if (q.options) {
            for (const opt of q.options) {
                counts.set(opt.value, 0);
            }
        }

        for (const evidence of evidenceList) {
            const answer = evidence.answers.find((a) => a.questionId === q.questionId);
            if (!answer) continue;

            if (answer.selection) {
                for (const v of answer.selection) {
                    counts.set(v, (counts.get(v) ?? 0) + 1);
                }
            }
            if (answer.ranking) {
                const firstPref = answer.ranking[0];
                if (firstPref !== undefined) {
                    counts.set(firstPref, (counts.get(firstPref) ?? 0) + 1);
                }
            }
            if (answer.weights) {
                for (const w of answer.weights) {
                    counts.set(w.option, (counts.get(w.option) ?? 0) + w.weight);
                }
            }
        }

        const results: OptionTally[] = Array.from(counts.entries()).map(
            ([option, count]) => ({
                option,
                count,
                weight: '0',
            }),
        );

        return {
            questionId: q.questionId,
            roleResults: {
                raw: {
                    weightingMode: 'Unweighted',
                    results,
                },
            },
        };
    });
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
        const tallies = await tallyVotes(ballot, voterRefs, voteCache.getDocumentsDir());

        // --- 4. Build full results object ---
        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: allVotes.length,
            evidenceIpfsCid: '', // filled after pinning
            headId: process.env.HYDRA_API_URL ?? '',
            finalizedAt: new Date().toISOString(),
        };

        // --- 5. Write per-voter proof files to disk ---
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const evidenceDir = voteCache.getDocumentsDir();
        const proofsDir = pathMod.join(evidenceDir, 'proofs');
        await fs.mkdir(proofsDir, { recursive: true });

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
        const trp_response = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
            ballotName: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            totalVoters: allVotes.length,
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
        });

        debug(`[finalize] unsigned tx (${trp_response.tx?.length ?? 0} chars):`, trp_response.tx);
        const signedTx = await admin_wallet.signTx(trp_response.tx);
        debug(`[finalize] signed tx (${signedTx?.length ?? 0} chars):`, signedTx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${ballotName}`);
        const submit_text = await submit_response.text();
        debug(`[finalize] submitTx response (${submit_response.status}):`, submit_text);
        const { hash: txHash } = parseTrpSubmitResponse(submit_text);

        return success(res, {
            txHash,
            resultsHash,
            evidenceDirectoryCid,
            resultsCid,
            evidenceMerkleRoot,
            totalVoters: allVotes.length,
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
        const results: Array<{ voterId: string; txHash?: string; error?: string }> = [];

        for (const vote of allVotes) {
            const tokenName = voterIdToTokenName(vote.voterId);
            try {
                const trp_response = await client.countVoteTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                });

                debug(`[count] unsigned tx for ${vote.voterId} (${trp_response.tx?.length ?? 0} chars):`, trp_response.tx);
                const signedTx = await admin_wallet.signTx(trp_response.tx);
                debug(`[count] signed tx for ${vote.voterId} (${signedTx?.length ?? 0} chars):`, signedTx);
                const submit_response = await submitTx(TRP_URL, signedTx, `0:${tokenName}`);
                const submit_text = await submit_response.text();
                debug(`[count] submitTx response for ${vote.voterId} (${submit_response.status}):`, submit_text);
                const { hash: txHash } = parseTrpSubmitResponse(submit_text);
                results.push({ voterId: vote.voterId, txHash });
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

/**
 * POST /settle
 *
 * Full settlement orchestration:
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

        const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);

        // --- Step 0: Snapshot + query authoritative voter list from head UTxOs ---
        // The head's UTxO set is the ground truth. The disk cache can have
        // stale entries from previous sessions — never use it for settlement.
        await logHeadSnapshot('pre-burn', wrangler);
        const headVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);

        // --- Step 1: Burn all voter tokens (in-head via TRP) ---
        let burned = 0;
        let burnFailed = 0;
        for (const voter of headVoters) {
            try {
                const burnTrp = await client.countVoteTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(voter.tokenName, 'hex'),
                });
                const burnSignedTx = await admin_wallet.signTx(burnTrp.tx);
                const burnSubmitText = await (await submitTx(TRP_URL, burnSignedTx, `0:${voter.tokenName}`)).text();
                parseTrpSubmitResponse(burnSubmitText);
                burned++;
            } catch (err: any) {
                console.error(`[settle/burn] FULL ERROR for token ${voter.tokenName}:`, err);
                burnFailed++;
            }
        }

        steps.push({
            step: 'burn',
            status: burnFailed === 0 ? 'SUCCESS' : 'PARTIAL',
            data: { burned, failed: burnFailed, total: headVoters.length },
        });

        // --- Step 2: Tally + IPFS evidence ---
        const fileLeaves: FileLeaf[] = headVoters.map((v) => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;
        const tallies = await tallyVotes(ballot, headVoters, voteCache.getDocumentsDir());

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: headVoters.length,
            evidenceIpfsCid: '',
            headId: process.env.HYDRA_API_URL ?? '',
            finalizedAt: new Date().toISOString(),
        };

        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const evidenceDir = voteCache.getDocumentsDir();
        const proofsDir = pathMod.join(evidenceDir, 'proofs');
        await fs.mkdir(proofsDir, { recursive: true });

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

        // --- Step 3: Build finalize tx via TRP, submit as decommit ---
        // The finalize tx spends the ballot token + gas, and produces the ballot
        // token with updated BallotResult datum + gas return. By submitting this
        // as a decommit instead of an in-head tx, both outputs leave the head
        // and settle directly to L1 — the ballot arrives on L1 with the finalized
        // datum intact, bypassing the fanout Plutus validator entirely.
        const finalizeTrp = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
            ballotName: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            totalVoters: headVoters.length,
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
        });

        debug(`[settle/decommit] finalize tx (${finalizeTrp.tx?.length ?? 0} chars):`, finalizeTrp.tx);
        const finalizeSignedTx = await admin_wallet.signTx(finalizeTrp.tx);

        const decommitTx = {
            type: 'Tx ConwayEra' as const,
            cborHex: finalizeSignedTx,
            description: 'Decommit finalized ballot token to L1',
        };

        // POST directly to Hydra node — the SDK's publishDecommit wraps the
        // payload in { tag: 'Decommit', transaction: ... } but the Hydra 1.x
        // REST API expects the raw transaction envelope at the top level.
        const hydraApiUrl = (process.env.HYDRA_API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
        debug('[settle/decommit] POSTing decommit to', `${hydraApiUrl}/decommit`);

        const decommitRes = await fetch(`${hydraApiUrl}/decommit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(decommitTx),
        });

        if (!decommitRes.ok && decommitRes.status !== 202) {
            const body = await decommitRes.text().catch(() => '');
            throw new Error(`Decommit rejected (${decommitRes.status}): ${body}`);
        }

        debug('[settle/decommit] Decommit accepted, waiting for approval…');

        // Poll the head snapshot until the ballot token disappears (decommit confirmed)
        const DECOMMIT_TIMEOUT = 120_000;
        const POLL_INTERVAL = 3_000;
        const deadline = Date.now() + DECOMMIT_TIMEOUT;

        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL));
            const snapshot = await wrangler.http.getSnapshotUtxo();
            const stillInHead = Object.values(snapshot).some((utxo: any) => {
                for (const [pid, assets] of Object.entries(utxo.value)) {
                    if (pid === 'lovelace' || typeof assets !== 'object') continue;
                    for (const name of Object.keys(assets as Record<string, number>)) {
                        if (name.startsWith(BALLOT_INSTANCE_PREFIX)) return true;
                    }
                }
                return false;
            });
            if (!stillInHead) {
                debug('[settle/decommit] Ballot token decommitted — no longer in head');
                break;
            }
            debug('[settle/decommit] Ballot token still in head, polling…');
        }

        if (Date.now() >= deadline) {
            throw new Error('Timeout waiting for decommit to be confirmed');
        }

        steps.push({
            step: 'decommit-finalize',
            status: 'SUCCESS',
            data: { resultsHash, evidenceDirectoryCid, totalVoters: headVoters.length },
        });

        await logHeadSnapshot('post-decommit', wrangler);

        // --- Step 4: Close head (only ADA remains — trivial fanout) ---
        await wrangler.waitForHeadClose(180000);

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
