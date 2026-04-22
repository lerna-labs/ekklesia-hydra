import { Router } from 'express';
import { createNativeScript, Wrangler } from '@lerna-labs/hydra-sdk';
import { blake2b256, bytesToHex, computePackage } from '@lerna-labs/hydra-proof';
import type { FileLeaf } from '@lerna-labs/hydra-proof';
import { initialize, voterIdToTokenName, CLOSE_TOKEN, VERBOSE, IPFS_STAGING_DIR, ipfs, voteCache, success, error, debug, hydraMonitor, getHeadId, txQueue, enqueueAndWait, driveHeadToFinal } from '../helpers.js';
import { hydraValueToAmounts } from '../tx-builder.js';
import { getCachedBallot, getCachedBallotId, getCachedBallotIdentity, getCachedResultsAddress } from './lifecycle.js';
import { BALLOT_INSTANCE_PREFIX, BALLOT_DEFINITION_PREFIX, HRP_TO_ROLE } from '../types.js';
import type {
    BallotDefinition,
    BallotOption,
    BallotQuestion,
    BordaEntry,
    DistributionEntry,
    FullResults,
    LikertOptionTally,
    MethodTally,
    OptionCount,
    PairwiseMatrix,
    QuestionTally,
    RangeStats,
    SelectionEntry,
    VoteCacheEntry,
    VoteEvidence,
    VoteMethod,
    VoteSelection,
    WeightedOptionTally,
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

// ---------------------------------------------------------------------------
// Per-method tally helpers — all deterministic functions of the evidence.
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
    return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/** Population standard deviation. */
function stdDev(xs: number[]): number {
    if (xs.length === 0) return 0;
    const m = mean(xs);
    const variance = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
    return Math.sqrt(variance);
}

function initOptionCounts(options: BallotOption[] | undefined): Map<number, number> {
    const counts = new Map<number, number>();
    if (options) for (const o of options) counts.set(o.value, 0);
    return counts;
}

function asNumberArray(s: VoteSelection['selection']): number[] | null {
    return Array.isArray(s) && s.every((x) => typeof x === 'number') ? (s as number[]) : null;
}

function asEntryArray(s: VoteSelection['selection']): SelectionEntry[] | null {
    return Array.isArray(s) &&
        s.every(
            (x) =>
                typeof x === 'object' &&
                x !== null &&
                typeof (x as SelectionEntry).option === 'number' &&
                typeof (x as SelectionEntry).value === 'number',
        )
        ? (s as SelectionEntry[])
        : null;
}

/** Enumerate every integer grid position in [min, max] at `step`. */
function gridValues(grid: { min: number; max: number; step?: number }): number[] {
    const step = grid.step ?? 1;
    const values: number[] = [];
    for (let v = grid.min; v <= grid.max; v += step) values.push(v);
    return values;
}

/** Tally binary, single-choice, multi-choice — simple {option, count} per option. */
function tallySimple(
    method: 'binary' | 'single-choice' | 'multi-choice',
    answers: VoteSelection[],
    options: BallotOption[] | undefined,
): MethodTally {
    const counts = initOptionCounts(options);
    for (const a of answers) {
        const values = asNumberArray(a.selection);
        if (!values) continue;
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return {
        method,
        results: Array.from(counts.entries())
            .map(([option, count]) => ({ option, count }))
            .sort((a, b) => a.option - b.option),
    };
}

/**
 * Tally range — histogram + aggregate stats.
 *
 * `distribution` is zero-filled across the full valueRange grid so auditors
 * can replay the histogram without reconstructing the grid. Stats are
 * computed over observed values only.
 */
function tallyRange(
    answers: VoteSelection[],
    valueRange: { min: number; max: number; step?: number } | undefined,
): MethodTally {
    const observed: number[] = [];
    for (const a of answers) {
        const values = asNumberArray(a.selection);
        if (!values || values.length !== 1) continue;
        observed.push(values[0]);
    }
    const counts = new Map<number, number>();
    if (valueRange) for (const v of gridValues(valueRange)) counts.set(v, 0);
    for (const v of observed) counts.set(v, (counts.get(v) ?? 0) + 1);

    const distribution: DistributionEntry[] = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value);

    const stats: RangeStats = {
        n: observed.length,
        mean: mean(observed),
        median: median(observed),
        min: observed.length ? Math.min(...observed) : 0,
        max: observed.length ? Math.max(...observed) : 0,
        stdDev: stdDev(observed),
    };
    return { method: 'range', distribution, stats };
}

/**
 * Tally ranked — first-preference counts, Borda scores, and pairwise matrix.
 * Borda convention: with N ranked positions, position 0 (1st place) gets N-1
 * points, position 1 gets N-2, …, position N-1 gets 0. Deterministic —
 * Hydra does not compute IRV since tie-break rules are not canonical.
 */
function tallyRanked(
    answers: VoteSelection[],
    options: BallotOption[] | undefined,
): MethodTally {
    // Sort option values ascending so pairwise.options has a deterministic
    // order independent of the ballot-authoring order.
    const sortedValues = (options ? options.map((o) => o.value) : []).slice().sort((a, b) => a - b);
    const firstPrefCounts = new Map<number, number>(sortedValues.map((v) => [v, 0]));
    const bordaScores = new Map<number, number>(sortedValues.map((v) => [v, 0]));
    const indexOf = new Map(sortedValues.map((v, i) => [v, i]));
    const matrix: number[][] = sortedValues.map(() => sortedValues.map(() => 0));

    for (const a of answers) {
        const ranking = asNumberArray(a.selection);
        if (!ranking || ranking.length === 0) continue;

        firstPrefCounts.set(ranking[0], (firstPrefCounts.get(ranking[0]) ?? 0) + 1);

        const n = ranking.length;
        for (let i = 0; i < n; i++) {
            bordaScores.set(ranking[i], (bordaScores.get(ranking[i]) ?? 0) + (n - 1 - i));
        }

        for (let i = 0; i < n; i++) {
            const ai = indexOf.get(ranking[i]);
            if (ai === undefined) continue;
            for (let j = i + 1; j < n; j++) {
                const aj = indexOf.get(ranking[j]);
                if (aj === undefined) continue;
                matrix[ai][aj] += 1;
            }
        }
    }

    const firstPreference: OptionCount[] = sortedValues.map((option) => ({
        option,
        count: firstPrefCounts.get(option) ?? 0,
    }));
    const borda: BordaEntry[] = sortedValues.map((option) => ({
        option,
        score: bordaScores.get(option) ?? 0,
    }));
    const pairwise: PairwiseMatrix = { options: sortedValues, matrix };

    return { method: 'ranked', firstPreference, borda, pairwise };
}

/** Tally weighted — per-option totalPoints, voterCount, mean, stdDev. */
function tallyWeighted(
    answers: VoteSelection[],
    options: BallotOption[] | undefined,
): MethodTally {
    const perOption = new Map<number, number[]>();
    if (options) for (const o of options) perOption.set(o.value, []);

    let answeringBallots = 0;
    for (const a of answers) {
        const entries = asEntryArray(a.selection);
        if (!entries) continue;
        answeringBallots += 1;
        // Record each allocation, filling zeros for options this ballot didn't mention.
        const mentioned = new Set<number>();
        for (const e of entries) {
            if (!perOption.has(e.option)) perOption.set(e.option, []);
            perOption.get(e.option)!.push(e.value);
            mentioned.add(e.option);
        }
        if (options) {
            for (const o of options) {
                if (!mentioned.has(o.value)) perOption.get(o.value)!.push(0);
            }
        }
    }

    const results: WeightedOptionTally[] = Array.from(perOption.entries()).map(
        ([option, values]) => ({
            option,
            totalPoints: values.reduce((s, v) => s + v, 0),
            voterCount: values.filter((v) => v > 0).length,
            mean: answeringBallots === 0 ? 0 : values.reduce((s, v) => s + v, 0) / answeringBallots,
            stdDev: stdDev(values),
        }),
    );

    return { method: 'weighted', results };
}

/**
 * Tally likert — per-option sum/count/mean/median + full rating distribution.
 *
 * `distribution` is zero-filled across every valid rating grid position so
 * auditors can replay the histogram without having to reconstruct the grid.
 * `median` uses the classical definition: for even counts it is the mean of
 * the two middle values. Backend consumers must match this to keep numbers
 * byte-aligned with `results.json`.
 */
function tallyLikert(
    answers: VoteSelection[],
    options: BallotOption[] | undefined,
    ratingRange: { min: number; max: number; step?: number } | undefined,
): MethodTally {
    const perOption = new Map<number, number[]>();
    if (options) for (const o of options) perOption.set(o.value, []);

    for (const a of answers) {
        const entries = asEntryArray(a.selection);
        if (!entries) continue;
        for (const e of entries) {
            if (!perOption.has(e.option)) perOption.set(e.option, []);
            perOption.get(e.option)!.push(e.value);
        }
    }

    const gridKeys = ratingRange ? gridValues(ratingRange) : [];

    const results: LikertOptionTally[] = Array.from(perOption.entries()).map(
        ([option, ratings]) => {
            const distribution: Record<number, number> = {};
            for (const k of gridKeys) distribution[k] = 0;
            for (const r of ratings) distribution[r] = (distribution[r] ?? 0) + 1;
            return {
                option,
                sum: ratings.reduce((s, v) => s + v, 0),
                count: ratings.length,
                mean: mean(ratings),
                median: median(ratings),
                distribution,
            };
        },
    );

    return { method: 'likert', results };
}

/** Dispatch to the correct per-method tally. Abstain answers are filtered out by the caller. */
function tallyForMethod(q: BallotQuestion, answers: VoteSelection[]): MethodTally {
    switch (q.method) {
        case 'binary':
        case 'single-choice':
        case 'multi-choice':
            return tallySimple(q.method, answers, q.options);
        case 'range':
            return tallyRange(answers, q.valueRange);
        case 'ranked':
            return tallyRanked(answers, q.options);
        case 'weighted':
            return tallyWeighted(answers, q.options);
        case 'likert':
            return tallyLikert(answers, q.options, q.ratingRange);
    }
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

    // The set of roles that must appear in every QuestionTally.roleResults:
    // every role declared on the ballot's roleWeighting, plus every role
    // observed in evidence (safety net for mismatched authoring), plus `raw`.
    const declaredRoles = new Set<string>(Object.keys(ballot.roleWeighting ?? {}));
    const observedRoles = new Set<string>(Object.keys(votersByRole));
    const allRoles = new Set<string>([...declaredRoles, ...observedRoles, 'raw']);

    // Bucket every ballot's answer by role. Abstain answers go into a
    // separate map so they show up in `abstainedByRole` but not in any
    // MethodTally aggregate.
    const answersByQuestionRole = new Map<string, Map<string, VoteSelection[]>>();
    const abstainByQuestionRole = new Map<string, Map<string, number>>();
    for (const q of ballot.questions) {
        const roleAnswers = new Map<string, VoteSelection[]>();
        const roleAbstain = new Map<string, number>();
        for (const r of allRoles) {
            roleAnswers.set(r, []);
            roleAbstain.set(r, 0);
        }
        answersByQuestionRole.set(q.questionId, roleAnswers);
        abstainByQuestionRole.set(q.questionId, roleAbstain);
    }

    for (const evidence of evidenceList) {
        const hrp = evidence.ekklesia?.credentialHrp ?? 'drep';
        const role = HRP_TO_ROLE[hrp] ?? evidence.responderRole ?? 'Unknown';
        for (const answer of evidence.answers) {
            const perRoleAnswers = answersByQuestionRole.get(answer.questionId);
            const perRoleAbstain = abstainByQuestionRole.get(answer.questionId);
            if (!perRoleAnswers || !perRoleAbstain) continue;
            for (const bucket of [role, 'raw']) {
                if (answer.abstain === true) {
                    perRoleAbstain.set(bucket, (perRoleAbstain.get(bucket) ?? 0) + 1);
                } else {
                    if (!perRoleAnswers.has(bucket)) perRoleAnswers.set(bucket, []);
                    perRoleAnswers.get(bucket)!.push(answer);
                }
            }
        }
    }

    const tallies: QuestionTally[] = ballot.questions.map((q) => {
        const perRoleAnswers = answersByQuestionRole.get(q.questionId) ?? new Map();
        const perRoleAbstain = abstainByQuestionRole.get(q.questionId) ?? new Map();

        const roleResults: Record<string, MethodTally> = {};
        for (const [role, answers] of perRoleAnswers) {
            roleResults[role] = tallyForMethod(q, answers);
        }

        const abstainedByRole: Record<string, number> = {};
        for (const [role, count] of perRoleAbstain) {
            if (count > 0) abstainedByRole[role] = count;
        }

        const tally: QuestionTally = {
            questionId: q.questionId,
            method: q.method,
            roleResults,
        };
        if (Object.keys(abstainedByRole).length > 0) {
            tally.abstainedByRole = abstainedByRole;
        }
        return tally;
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
router.post('/finalize', async (_req, res) => {
    const ballot = getCachedBallot();
    if (!ballot) {
        return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached. Was /start called with ballotIpfsCid?', 400);
    }

    const identity = getCachedBallotIdentity();
    const ballotId = getCachedBallotId();
    if (!identity || !ballotId) {
        return error(res, 'NO_BALLOT_CACHED', 'Ballot identity not cached. Call /start with ballotPolicy and ballotToken first.', 400);
    }
    const { ballotPolicy, ballotToken: ballotName } = identity;

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
        // computePackage() crashes on an empty leaf set — guard for
        // zero-voter ballots and emit an empty root.
        const fileLeaves: FileLeaf[] = voterRefs.map((v) => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));

        const proofPackage = fileLeaves.length > 0
            ? computePackage(fileLeaves, 'content+path')
            : null;
        const evidenceMerkleRoot = proofPackage?.rootHex ?? '';

        // --- 3. Tally ---
        const { tallies, votersByRole } = await tallyVotes(ballot, voterRefs, voteCache.getDocumentsDir());

        // --- 4. Build full results object ---
        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            tallies,
            totalVoters: allVotes.length,
            votersByRole,
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

        if (proofPackage) {
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
        }

        // --- 6. Write results + proof package into evidence dir and pin ---
        // Serialize once — on-chain resultsHash hashes the exact bytes written to disk.
        const resultsJson = JSON.stringify(fullResults, null, 2);
        await fs.writeFile(pathMod.join(evidenceDir, 'results.json'), resultsJson);
        if (proofPackage) {
            await fs.writeFile(
                pathMod.join(evidenceDir, 'proof-package.json'),
                JSON.stringify(proofPackage, null, 2),
            );
        }
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);
        const resultsHash = bytesToHex(blake2b256(resultsJson));

        // --- 7. Update (601) datum via TRP + queue worker ---
        const { tx: unsignedFinalizeTx } = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
            ballotToken: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
            resultsAddress: getCachedResultsAddress() ?? admin_payment_address,
        });
        const signedFinalizeTx = await admin_wallet.signTx(unsignedFinalizeTx);
        const { txHash } = await enqueueAndWait({
            id: `finalize:${ballotName}`,
            type: 'finalize',
            unsignedCborHex: unsignedFinalizeTx,
            signedCborHex: signedFinalizeTx,
        });

        return success(res, {
            txHash,
            resultsHash,
            evidenceDirectoryCid,
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

        // Resolve + sign + enqueue every burn, then wait for the worker to
        // dispatch them all. Burns are non-contending so the worker pipelines
        // them up to MAX_IN_FLIGHT in parallel.
        const results = await Promise.allSettled(allVotes.map(async (vote) => {
            const tokenName = voterIdToTokenName(vote.voterId);
            const { tx: unsignedTx } = await client.countVoteTx({
                votingAuthority: admin_payment_address,
                mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                userId: Buffer.from(tokenName, 'hex'),
            });
            const signedTx = await admin_wallet.signTx(unsignedTx);
            const { txHash } = await enqueueAndWait({
                id: `burn:${tokenName}`,
                type: 'count_vote',
                unsignedCborHex: unsignedTx,
                signedCborHex: signedTx,
            });
            return { voterId: vote.voterId, txHash };
        }));

        const detailed = results.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            const reason = (r.reason as Error)?.message ?? 'unknown';
            console.error(`[count] FULL ERROR for ${allVotes[i].voterId}:`, reason);
            return { voterId: allVotes[i].voterId, error: reason };
        });

        const burned = detailed.filter((r) => 'txHash' in r).length;
        const failed = detailed.filter((r) => 'error' in r).length;

        return success(res, { burned, failed, total: allVotes.length, results: detailed });
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
 * No body — voter token policy is derived from the admin wallet's native
 * script; ballot identity comes from the cache populated by /start.
 */
router.post('/settle/burn', async (_req, res) => {
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

        // Save pre-burn ledger state to disk on the FIRST burn call only.
        // This is the authoritative record of every voter's on-chain state
        // at the moment settlement began. Subsequent burn calls (retries for
        // failed burns) must not overwrite it — the original snapshot is the
        // source of truth for /settle/finalize.
        //
        // Written unconditionally (including as an empty array when the head
        // has no voter tokens) so /settle/finalize can always locate it. An
        // empty ballot is still a valid ballot — it finalizes with 0 voters.
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

        if (headVoters.length === 0) {
            return success(res, { burned: 0, failed: 0, remaining: 0, total: 0, message: 'No voter tokens to burn (empty ballot). Pre-burn ledger snapshot written; proceed to /settle/finalize.' });
        }

        // Resolve + sign + enqueue every burn. The worker dispatches in
        // parallel up to MAX_IN_FLIGHT. Burns are non-contending so they
        // pipeline freely. Idempotent: if a burn entry already exists in
        // the WAL (e.g., from a previous /settle/burn call), enqueueing
        // again with the same id overwrites the prior state — but we'd
        // also re-await its acceptance, so retries Just Work.
        const burnResults = await Promise.allSettled(headVoters.map(async (voter) => {
            const { tx: unsignedTx } = await client.countVoteTx({
                votingAuthority: admin_payment_address,
                mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                userId: Buffer.from(voter.tokenName, 'hex'),
            });
            const signedTx = await admin_wallet.signTx(unsignedTx);
            return enqueueAndWait({
                id: `burn:${voter.tokenName}`,
                type: 'count_vote',
                unsignedCborHex: unsignedTx,
                signedCborHex: signedTx,
            });
        }));

        let burned = 0;
        let burnFailed = 0;
        for (let i = 0; i < burnResults.length; i++) {
            if (burnResults[i].status === 'fulfilled') {
                burned++;
            } else {
                console.error(`[settle/burn] FULL ERROR for ${headVoters[i].tokenName}:`, (burnResults[i] as PromiseRejectedResult).reason?.message);
                burnFailed++;
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
 * No body — identity (ballotId, ballotName, ballotPolicy) is read from the
 * cache populated by /start. One head, one ballot.
 */
router.post('/settle/finalize', async (_req, res) => {
    const ballot = getCachedBallot();
    if (!ballot) {
        return error(res, 'NO_BALLOT_CACHED', 'No ballot definition cached', 400);
    }

    const identity = getCachedBallotIdentity();
    const ballotId = getCachedBallotId();
    if (!identity || !ballotId) {
        return error(res, 'NO_BALLOT_CACHED', 'Ballot identity not cached. Call /start with ballotPolicy and ballotToken first.', 400);
    }
    const { ballotPolicy, ballotToken: ballotName } = identity;

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
        //
        // If the snapshot is missing but the head also has zero voter tokens,
        // we treat that as an empty-ballot finalize and synthesize an empty
        // snapshot on the fly. This keeps /settle/finalize usable in the
        // unusual case where /settle/burn was never called (e.g. ballots
        // that had no voter activity and skipped straight to finalize).
        const ledgerSnapshotPath = pathMod.join(IPFS_STAGING_DIR, 'pre-burn-ledger.json');
        let ledgerVoters: Array<{ tokenName: string; version: number; voteHash: string; ipfsCid: string }>;
        try {
            const raw = await fs.readFile(ledgerSnapshotPath, 'utf-8');
            ledgerVoters = JSON.parse(raw);
        } catch {
            // We already confirmed remainingVoters.length === 0 above, so the
            // head genuinely has no voter tokens. Write an empty snapshot and
            // continue — the finalized results will reflect a zero-voter ballot.
            ledgerVoters = [];
            await fs.writeFile(ledgerSnapshotPath, JSON.stringify(ledgerVoters, null, 2));
            debug(`[settle/finalize] No pre-burn snapshot found AND head has no voter tokens — synthesized empty snapshot at ${ledgerSnapshotPath}`);
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

        // Build merkle tree + tally from verified voters only.
        // computePackage() crashes on an empty leaf set (buildTree returns
        // no levels, so `levels.at(-1)[0]` is undefined). For zero-voter
        // ballots we skip the merkle construction and emit an empty root.
        const fileLeaves: FileLeaf[] = verifiedVoters.map(v => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = fileLeaves.length > 0
            ? computePackage(fileLeaves, 'content+path')
            : null;
        const evidenceMerkleRoot = proofPackage?.rootHex ?? '';
        const { tallies, votersByRole } = await tallyVotes(ballot, verifiedVoters, evidenceDir);

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            tallies,
            totalVoters: verifiedVoters.length,
            votersByRole,
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

        if (proofPackage) {
            for (const file of proofPackage.files) {
                await fs.writeFile(
                    pathMod.join(proofsDir, `${file.name}.json`),
                    JSON.stringify({ voterId: file.name, contentHashHex: file.contentHashHex, leafHashHex: file.leafHashHex, merkleRoot: evidenceMerkleRoot, proof: file.merkleProof }, null, 2),
                );
            }
        }

        // Write results + proof package into evidence dir, then pin.
        // On-chain resultsHash hashes the exact bytes written to disk.
        const resultsJson = JSON.stringify(fullResults, null, 2);
        await fs.writeFile(pathMod.join(evidenceDir, 'results.json'), resultsJson);
        if (proofPackage) {
            await fs.writeFile(
                pathMod.join(evidenceDir, 'proof-package.json'),
                JSON.stringify(proofPackage, null, 2),
            );
        }
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);
        const resultsHash = bytesToHex(blake2b256(resultsJson));

        // Finalize ballot datum in-head — TRP resolves, worker dispatches.
        const { tx: unsignedFinalizeTx } = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
            ballotToken: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
            resultsAddress: getCachedResultsAddress() ?? admin_payment_address,
        });
        const signedFinalizeTx = await admin_wallet.signTx(unsignedFinalizeTx);
        const { txHash: finalizeTxHash } = await enqueueAndWait({
            id: `finalize:${ballotName}`,
            type: 'finalize',
            unsignedCborHex: unsignedFinalizeTx,
            signedCborHex: signedFinalizeTx,
        });

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
        const wasAlreadyFinal = hydraMonitor.headStatus === 'FINAL';
        await driveHeadToFinal('settle/close');
        return success(res, wasAlreadyFinal
            ? { status: 'FINAL', message: 'Head already finalized' }
            : { status: 'FINAL' });
    } catch (err: any) {
        if (err?.code === 'HEAD_NOT_CLOSEABLE') {
            return error(res, 'CONFLICT', err.message, 409);
        }
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
 *   closeToken: string     — required to authorize head close
 *
 * Identity fields (ballotId, ballotName, ballotPolicy) are read from the
 * cache populated by /start. One head, one ballot.
 */
router.post('/settle', async (req, res) => {
    const { closeToken } = req.body as { closeToken: string };

    if (!closeToken) {
        return error(res, 'MISSING_FIELDS', 'Missing required field: closeToken', 400);
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

        const identity = getCachedBallotIdentity();
        const ballotId = getCachedBallotId();
        if (!identity || !ballotId) {
            return error(res, 'NO_BALLOT_CACHED', 'Ballot identity not cached. Call /start with ballotPolicy and ballotToken first.', 400);
        }
        const { ballotPolicy, ballotToken: ballotName } = identity;

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
        // Burns are enqueued to the WAL; the worker dispatches them via
        // WebSocket up to MAX_IN_FLIGHT in parallel. Each burn spends a
        // unique voter UTxO so there's no contention. The worker handles
        // retries on transient errors.
        const burnResults = await Promise.allSettled(headVoters.map(async (voter) => {
            const { tx: unsignedTx } = await client.countVoteTx({
                votingAuthority: admin_payment_address,
                mintingScript: Buffer.from(TOKEN_SCRIPT as string, 'hex'),
                tokenPolicy: Buffer.from(TOKEN_POLICY as string, 'hex'),
                userId: Buffer.from(voter.tokenName, 'hex'),
            });
            const signedTx = await admin_wallet.signTx(unsignedTx);
            return enqueueAndWait({
                id: `burn:${voter.tokenName}`,
                type: 'count_vote',
                unsignedCborHex: unsignedTx,
                signedCborHex: signedTx,
            });
        }));

        let burned = 0;
        let burnFailed = 0;
        for (let i = 0; i < burnResults.length; i++) {
            if (burnResults[i].status === 'fulfilled') {
                burned++;
            } else {
                console.error(`[settle/burn] FULL ERROR for ${headVoters[i].tokenName}:`, (burnResults[i] as PromiseRejectedResult).reason?.message);
                burnFailed++;
            }
        }

        // Final check: head must have only the ballot token before proceeding
        const postBurnVoters = await getVotersFromHead(wrangler, TOKEN_POLICY as string);
        if (postBurnVoters.length > 0) {
            const remaining = postBurnVoters.map(v => v.tokenName.slice(0, 16)).join(', ');
            return error(res, 'INTERNAL_ERROR', `Cannot finalize: ${postBurnVoters.length} voter token(s) still in head (${remaining}…). All tokens must be burned before close.`, 500);
        }

        steps.push({
            step: 'burn',
            status: burnFailed === 0 ? 'SUCCESS' : 'PARTIAL',
            data: { burned, failed: burnFailed, total: headVoters.length },
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
        // Guard computePackage for empty-voter ballots.
        const fileLeaves: FileLeaf[] = verifiedVoters.map((v) => ({
            name: v.tokenName,
            contentHashHex: v.voteHash,
        }));
        const proofPackage = fileLeaves.length > 0
            ? computePackage(fileLeaves, 'content+path')
            : null;
        const evidenceMerkleRoot = proofPackage?.rootHex ?? '';
        const { tallies, votersByRole } = await tallyVotes(ballot, verifiedVoters, evidenceDir);

        const fullResults: FullResults = {
            specVersion: '0.3.0',
            ballotId,
            tallies,
            totalVoters: verifiedVoters.length,
            votersByRole,
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

        if (proofPackage) {
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
        }

        // Write results + proof package into evidence dir, then pin.
        // On-chain resultsHash hashes the exact bytes written to disk.
        const resultsJson = JSON.stringify(fullResults, null, 2);
        await fs.writeFile(pathMod.join(evidenceDir, 'results.json'), resultsJson);
        if (proofPackage) {
            await fs.writeFile(
                pathMod.join(evidenceDir, 'proof-package.json'),
                JSON.stringify(proofPackage, null, 2),
            );
        }
        const { cid: evidenceDirectoryCid } = await ipfs.pinDirectory(evidenceDir);
        const resultsHash = bytesToHex(blake2b256(resultsJson));

        await logHeadSnapshot('post-burn', wrangler);

        // --- Step 3: Finalize ballot datum in-head ---
        const { tx: unsignedFinalizeTx } = await client.finalizeBallotTx({
            votingAuthority: admin_payment_address,
            ballotPolicy: Buffer.from(ballotPolicy, 'hex'),
            ballotToken: Buffer.from(ballotName, 'hex'),
            ballotId: Buffer.from(ballotId, 'hex'),
            resultsHash: Buffer.from(resultsHash, 'hex'),
            evidenceCid: Buffer.from(evidenceDirectoryCid),
            merkleRoot: Buffer.from(evidenceMerkleRoot, 'hex'),
            resultsAddress: getCachedResultsAddress() ?? admin_payment_address,
        });
        const signedFinalizeTx = await admin_wallet.signTx(unsignedFinalizeTx);
        const { txHash: finalizeTxHash } = await enqueueAndWait({
            id: `finalize:${ballotName}`,
            type: 'finalize',
            unsignedCborHex: unsignedFinalizeTx,
            signedCborHex: signedFinalizeTx,
        });

        steps.push({
            step: 'finalize',
            status: 'SUCCESS',
            data: { txHash: finalizeTxHash, resultsHash, evidenceDirectoryCid, totalVoters: headVoters.length },
        });

        await logHeadSnapshot('post-finalize', wrangler);

        // --- Step 4: Close head — fanout includes ballot token with finalized datum ---
        await driveHeadToFinal('settle');

        steps.push({ step: 'close', status: 'SUCCESS' });

        return success(res, {
            steps,
            resultsHash,
            evidenceDirectoryCid,
            evidenceMerkleRoot,
            totalVoters: headVoters.length,
        });
    } catch (err: any) {
        console.error('Settlement failed:', err?.message, err?.stack);
        return error(res, 'INTERNAL_ERROR', err.message || 'Settlement failed', 500);
    }
});

export default router;
