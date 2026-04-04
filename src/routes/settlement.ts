import { Router } from 'express';
import { createNativeScript, submitTx, Wrangler } from '@lerna-labs/hydra-sdk';
import { blake2b256, bytesToHex, computePackage } from '@lerna-labs/hydra-proof';
import type { FileLeaf } from '@lerna-labs/hydra-proof';
import { initialize, voterIdToTokenName, TRP_URL, CLOSE_TOKEN, ipfs, voteCache, success, error, debug } from '../helpers.js';
import { getCachedBallot } from './lifecycle.js';
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
// Tallying logic
// ---------------------------------------------------------------------------

/**
 * Build raw (unweighted) tallies from all cached votes.
 *
 * Ekklesia provides only cryptographically verified vote intents.
 * Stake-based weighting is intentionally external — the snapshot amounts
 * are a separate concern and potential point of contention.
 *
 * Consumers of the results (governance tools, frontends) apply their own
 * weighting using L1 stake snapshots + the verified voter credentials.
 */
async function tallyVotes(
    ballot: BallotDefinition,
    votes: VoteCacheEntry[],
    evidenceDir: string,
): Promise<QuestionTally[]> {
    // Load full evidence for each voter to extract their selections
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const evidenceByVoter = new Map<string, VoteEvidence>();
    for (const vote of votes) {
        try {
            const filePath = path.join(evidenceDir, `vote-${voterIdToTokenName(vote.voterId)}-v${vote.version}.json`);
            const raw = await fs.readFile(filePath, 'utf-8');
            evidenceByVoter.set(vote.voterId, JSON.parse(raw));
        } catch {
            // If evidence file missing, skip this voter in tally
            console.warn(`Missing evidence file for voter ${vote.voterId}, skipping`);
        }
    }

    return ballot.questions.map((q) => {
        // Raw counts per option value (unweighted — 1 vote = 1 count)
        const counts = new Map<number, number>();
        if (q.options) {
            for (const opt of q.options) {
                counts.set(opt.value, 0);
            }
        }

        for (const [, evidence] of evidenceByVoter) {
            const answer = evidence.answers.find((a) => a.questionId === q.questionId);
            if (!answer) continue;

            // Handle different method types
            if (answer.selection) {
                for (const v of answer.selection) {
                    counts.set(v, (counts.get(v) ?? 0) + 1);
                }
            }
            // For ranked/weighted, store raw counts of participation
            // The full ranked/weighted data is in the IPFS evidence for
            // consumers to apply their own interpretation
            if (answer.ranking) {
                // Count first-preference for basic tally; full ranking in evidence
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
                weight: '0', // Unweighted — consumers apply stake weights externally
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
    const { ballotId, ballotName } = req.body as {
        ballotId: string;
        ballotName: string;
    };

    if (!ballotId || !ballotName) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: ballotId, ballotName', 400);
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

        // --- 1. Gather all votes ---
        const allVotes = voteCache.getAll();

        // --- 2. Build merkle tree of vote evidence ---
        const fileLeaves: FileLeaf[] = allVotes.map((v) => ({
            name: v.voterId,
            contentHashHex: v.voteHash,
        }));

        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;

        // --- 3. Tally ---
        const tallies = await tallyVotes(ballot, allVotes, voteCache.getDocumentsDir());

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
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
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
        let response_json: { hash?: string };
        try {
            response_json = JSON.parse(submit_text);
        } catch {
            console.error('[finalize] Failed to parse submit response:', submit_text);
            response_json = {};
        }

        return success(res, {
            txHash: response_json.hash,
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
                let response_json: { hash?: string };
                try {
                    response_json = JSON.parse(submit_text);
                } catch {
                    response_json = {};
                }

                results.push({ voterId: vote.voterId, txHash: response_json.hash });
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
// POST /settle — orchestrate full settlement: finalize → burn → close → fanout
// ---------------------------------------------------------------------------

/**
 * POST /settle
 *
 * Full settlement orchestration. Calls finalize, burns all voter tokens,
 * then closes the head (which triggers fanout).
 *
 * Body:
 *   ballotId: string       — ballot identifier (ULID or tx hash)
 *   ballotName: string     — hex fingerprint of the ballot tokens
 *   closeToken: string     — required to authorize head close
 */
router.post('/settle', async (req, res) => {
    const { ballotId, ballotName, closeToken } = req.body as {
        ballotId: string;
        ballotName: string;
        closeToken: string;
    };

    if (!ballotId || !ballotName || !closeToken) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: ballotId, ballotName, closeToken', 400);
    }

    if (closeToken !== CLOSE_TOKEN) {
        return error(res, 'CLOSE_TOKEN_INVALID', 'Incorrect close token', 400);
    }

    const steps: Array<{ step: string; status: string; data?: any; error?: string }> = [];

    try {
        // --- Step 1: Finalize ---
        // We call the finalization logic inline rather than HTTP to avoid circular deps
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

        const allVotes = voteCache.getAll();

        // Tally
        const fileLeaves: FileLeaf[] = allVotes.map((v) => ({
            name: v.voterId,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = computePackage(fileLeaves, 'content+path');
        const evidenceMerkleRoot = proofPackage.rootHex;
        const tallies = await tallyVotes(ballot, allVotes, voteCache.getDocumentsDir());

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            status: 'finalized',
            tallies,
            totalVoters: allVotes.length,
            evidenceIpfsCid: '',
            headId: process.env.HYDRA_API_URL ?? '',
            finalizedAt: new Date().toISOString(),
        };

        // Write per-voter proof files + pin evidence
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

        // Update (601) datum
        const finalizeTrp = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
            ballotName: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            totalVoters: allVotes.length,
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
        });

        const finalizeSignedTx = await admin_wallet.signTx(finalizeTrp.tx);
        const finalizeSubmit = await submitTx(TRP_URL, finalizeSignedTx, `0:${ballotName}`);
        const finalizeJson = await finalizeSubmit.json() as { hash?: string };

        steps.push({
            step: 'finalize',
            status: 'SUCCESS',
            data: { txHash: finalizeJson.hash, resultsHash, evidenceDirectoryCid, totalVoters: allVotes.length },
        });

        // --- Step 2: Burn all voter tokens ---
        let burned = 0;
        let burnFailed = 0;
        for (const vote of allVotes) {
            const tokenName = voterIdToTokenName(vote.voterId);
            try {
                const burnTrp = await client.countVoteTx({
                    votingAuthority: admin_payment_address,
                    mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                    tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                    userId: Buffer.from(tokenName, 'hex'),
                });
                const burnSignedTx = await admin_wallet.signTx(burnTrp.tx);
                await submitTx(TRP_URL, burnSignedTx, `0:${tokenName}`);
                burned++;
            } catch (err: any) {
                console.error(`[settle/burn] FULL ERROR for ${vote.voterId}:`, err);
                burnFailed++;
            }
        }

        steps.push({
            step: 'burn',
            status: burnFailed === 0 ? 'SUCCESS' : 'PARTIAL',
            data: { burned, failed: burnFailed, total: allVotes.length },
        });

        // --- Step 3: Close head ---
        const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
        await wrangler.waitForHeadClose(180000);

        steps.push({ step: 'close', status: 'SUCCESS' });

        return success(res, {
            steps,
            resultsHash,
            evidenceDirectoryCid,
            evidenceMerkleRoot,
            totalVoters: allVotes.length,
        });
    } catch (err: any) {
        console.error('Settlement failed:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Settlement failed', 500);
    }
});

export default router;
