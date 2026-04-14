import {Router} from 'express';
import {BlockfrostProvider, MeshTxBuilder, MeshWallet} from '@meshsdk/core';
import {createNativeScript, getAdmin} from '@lerna-labs/hydra-sdk';
import type {FileLeaf} from '@lerna-labs/hydra-proof';
import {blake2b256, bytesToHex, computePackage} from '@lerna-labs/hydra-proof';
import {blake2b} from 'blakejs';
import {checkBallotModifiable, error, HYDRA_NETWORK, hydraMonitor, ipfs, success} from '../helpers.js';
import {getCachedResultsAddress} from './lifecycle.js';
import {toBallotSurveyDetails} from '../cip179.js';
import type {BallotDefinition} from '../types.js';
import {BALLOT_DEFINITION_PREFIX, BALLOT_INSTANCE_PREFIX, buildAssetName} from '../types.js';

const router = Router();

/**
 * Convert a UTC ISO timestamp to an absolute Cardano slot number.
 *
 * Uses Blockfrost's /genesis endpoint to get the network's Shelley genesis
 * parameters (start time + slot length). Works across preview, preprod,
 * and mainnet — the Blockfrost API key determines the network.
 *
 * Post-Shelley slot length is 1 second on all networks, but we read it
 * from genesis to be safe.
 */
async function timestampToSlot(isoTimestamp: string, blockfrostKey: string): Promise<number> {
    const networkPrefix = blockfrostKey.startsWith('mainnet')
        ? 'cardano-mainnet'
        : blockfrostKey.startsWith('preprod')
            ? 'cardano-preprod'
            : 'cardano-preview';

    const genesisRes = await fetch(
        `https://${networkPrefix}.blockfrost.io/api/v0/genesis`,
        { headers: { project_id: blockfrostKey } },
    );

    if (!genesisRes.ok) {
        throw new Error(`Blockfrost /genesis failed: ${genesisRes.status}`);
    }

    const genesis = await genesisRes.json() as {
        network_magic: number;
        slot_length: number;           // seconds (1 for post-Shelley)
        active_slots_coefficient: number;
        epoch_length: number;
        byron_slot_length: number;     // seconds (20 for Byron)
        byron_epoch_length: number;
        max_lovelace_supply: string;
    };

    // For post-Shelley networks, the simplest reliable approach:
    // Fetch the latest block to get a known (slot, time) anchor point
    const latestBlockRes = await fetch(
        `https://${networkPrefix}.blockfrost.io/api/v0/blocks/latest`,
        { headers: { project_id: blockfrostKey } },
    );

    if (!latestBlockRes.ok) {
        throw new Error(`Blockfrost /blocks/latest failed: ${latestBlockRes.status}`);
    }

    const latestBlock = await latestBlockRes.json() as {
        slot: number;
        time: number; // unix timestamp (seconds)
    };

    // From a known anchor (slot, time), extrapolate using 1-second slots
    const targetUnix = Math.floor(new Date(isoTimestamp).getTime() / 1000);
    const slotLength = genesis.slot_length; // 1 second post-Shelley
    return latestBlock.slot + Math.floor((targetUnix - latestBlock.time) / slotLength);
}

/**
 * POST /prepare
 *
 * Mint the (600) ballot definition + (601) ballot instance token pair on L1.
 * Pin full ballot definition to IPFS. The (600) stays on L1 as an immutable
 * anchor; the (601) is intended to be committed into the Hydra head.
 *
 * The minting policy is timelocked: tokens can only be minted before the
 * voting window opens. After that slot, the policy is permanently locked —
 * no one can mint or burn tokens under it.
 *
 * Body:
 *   namespace: string        — e.g. "vote.ekklesia.intersect.budget2026"
 *   ballot: BallotDefinition — full ballot spec (CIP-179 core + ekklesia extension)
 *   gasAmount?: number       — ADA to include as gas UTxOs for in-head ops (default 100)
 *   cip179?: boolean         — if true, attach CIP-179 surveyDetails as label 17 metadata (default false)
 */
router.post('/prepare', async (req, res) => {
    const { namespace, ballot, gasAmount, cip179, resultsAddress } = req.body as {
        namespace: string;
        ballot: BallotDefinition;
        gasAmount?: number;
        cip179?: boolean;
        resultsAddress?: string;
    };

    if (!namespace || !ballot) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: namespace, ballot', 400);
    }

    try {
        // --- 1. Initialize wallet with L1 fetcher and timelocked native script ---
        const blockfrostKey = process.env.BLOCKFROST_API_KEY as string;
        const blockfrost = new BlockfrostProvider(blockfrostKey);
        const admin_wallet: MeshWallet = await getAdmin(blockfrostKey);
        const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        // Convert voting window open time to a slot for the timelock
        const votingOpenSlot = await timestampToSlot(
            ballot.ekklesia.votingWindow.open,
            process.env.BLOCKFROST_API_KEY as string,
        );

        // Create timelocked script: all:[sig(admin), before(votingOpenSlot)]
        // After this slot, tokens cannot be minted or burned under this policy
        const {
            scriptCbor: SCRIPT_CBOR,
            scriptHash: POLICY_ID,
        } = createNativeScript(admin_address, {
            invalidHereafter: votingOpenSlot,
            networkId: HYDRA_NETWORK,
        });

        if (!SCRIPT_CBOR || !POLICY_ID) {
            return error(res, 'WALLET_INIT_FAILED', 'Failed to derive native script from admin wallet', 503);
        }

        // --- 2. Compute ballot fingerprint and asset names ---
        const fingerprintBytes = blake2b(Buffer.from(namespace, 'utf8'), undefined, 28);
        const fingerprint = bytesToHex(fingerprintBytes);
        const definitionAssetName = buildAssetName(BALLOT_DEFINITION_PREFIX, fingerprint);
        const instanceAssetName = buildAssetName(BALLOT_INSTANCE_PREFIX, fingerprint);

        // --- 3. Build ballot content merkle tree ---
        // Each question becomes a leaf: name = questionId, content = blake2b_256(question JSON)
        const questionLeaves: FileLeaf[] = ballot.questions.map((q) => ({
            name: q.questionId,
            contentHashHex: bytesToHex(blake2b256(JSON.stringify(q))),
        }));
        const ballotProofPackage = computePackage(questionLeaves, 'content+path');
        const ballotContentHash = ballotProofPackage.rootHex;

        // --- 4. Pin full ballot definition + proof package to IPFS ---
        // Fill in the ekklesia extension with computed values before pinning
        const ballotWithMerkle: BallotDefinition = {
            ...ballot,
            ekklesia: {
                ...ballot.ekklesia,
                namespace,
                merkleRoot: ballotContentHash,
                ballotIpfsCid: '', // will be filled after pinning
            },
        };

        const { cid: ballotIpfsCid } = await ipfs.pinJson(
            `ballot-${fingerprint}.json`,
            { ...ballotWithMerkle, ekklesia: { ...ballotWithMerkle.ekklesia, ballotIpfsCid: 'self' } },
        );
        ballotWithMerkle.ekklesia.ballotIpfsCid = ballotIpfsCid;

        // Pin the ballot content proof package (for auditor verification of questions)
        await ipfs.pinJson(`ballot-proof-${fingerprint}.json`, ballotProofPackage);

        // --- 5. Build inline datums as Constr 0 [[ordered_fields], version] ---
        // Both (600) and (601) use the same shape so they can be read
        // consistently on L1. The inner list holds the data fields; the
        // trailing integer is the datum schema version.

        const toHex = (s: string) => s ? Buffer.from(s, 'utf-8').toString('hex') : '';

        // (600) Ballot Definition datum
        const definitionDatumPlutus = {
            alternative: 0,
            fields: [
                [   // ordered field set
                    toHex(ballot.title),                              // Title: Bytes
                    toHex(namespace),                                 // Namespace: Bytes
                    toHex(admin_address),                             // VotingAuthority: Bytes
                    ballotContentHash,                                // ContentHash: Bytes (already hex)
                    toHex(ballotIpfsCid),                             // BallotCid: Bytes
                    ballot.questions.length,                          // QuestionCount: Int
                    toHex(ballot.ekklesia.votingWindow.open),         // VotingWindowOpen: Bytes
                    toHex(ballot.ekklesia.votingWindow.close),        // VotingWindowClose: Bytes
                    ballot.endEpoch,                                  // EndEpoch: Int
                ],
                1,  // datum schema version
            ],
        };

        // (601) Ballot Instance datum — initial state (all fields empty).
        // Must match the tx3 BallotResult shape so TRP can resolve via datum_is.
        const instanceDatumPlutus = {
            alternative: 0,
            fields: [
                [   // ordered field set
                    '',  // BallotId: empty bytes
                    '',  // ResultsHash: empty bytes
                    '',  // EvidenceCid: empty bytes
                    '',  // MerkleRoot: empty bytes
                ],
                1,  // datum schema version
            ],
        };

        // --- 5. Build the L1 minting transaction ---
        const txBuilder = new MeshTxBuilder({
            fetcher: blockfrost,
            evaluator: blockfrost,
        });

        const gas = gasAmount ?? 3;
        const gasLovelace = String(gas * 1_000_000);

        // Both tokens mint to admin. (601) must stay at Voting_Authority
        // throughout voting (the tx3 templates require it), and keeping (600)
        // at admin too lets update/cancel run freely until the head opens.
        // Post-open custody is moved via /prepare/handoff.

        // Build the transaction
        txBuilder
            // Mint (600) ballot definition token (qty 1)
            .mint('1', POLICY_ID, definitionAssetName)
            .mintingScript(SCRIPT_CBOR)
            // Mint (601) ballot instance token (qty 1)
            .mint('1', POLICY_ID, instanceAssetName)
            .mintingScript(SCRIPT_CBOR)
            // Output: (600) token with inline datum → stays on L1
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: '5000000' },
                { unit: POLICY_ID + definitionAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(definitionDatumPlutus)
            // Output: (601) token with gas ADA + inline datum → committed to Hydra
            // The ballot token carries all the ADA for in-head operations.
            // No separate gas UTxO — the ballot token IS the gas.
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: gasLovelace },
                { unit: POLICY_ID + instanceAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(instanceDatumPlutus)
            // Output: ADA-only collateral UTxO for Hydra node L1 transactions
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: '5000000' },
            ]);

        // Transaction validity must not exceed the timelocked script's invalidHereafter.
        // The voting window open time MUST be in the future to allow minting.
        txBuilder.invalidHereafter(votingOpenSlot);

        // Optionally attach CIP-179 surveyDetails as label 17 metadata
        if (cip179) {
            const surveyDetails = toBallotSurveyDetails(ballotWithMerkle);
            txBuilder.metadataValue(17, surveyDetails as unknown as object);
        }

        const unsignedTx = await txBuilder
            .changeAddress(admin_address)
            .selectUtxosFrom(await blockfrost.fetchAddressUTxOs(admin_address))
            .complete();

        // --- 6. Sign and submit ---
        const signedTx = await admin_wallet.signTx(unsignedTx);
        const txHash = await blockfrost.submitTx(signedTx);

        return success(res, {
            txHash,
            policyId: POLICY_ID,
            fingerprint,
            definitionAssetName,
            instanceAssetName,
            ballotIpfsCid,
            ballotContentHash,
            questionCount: ballot.questions.length,
            gasAmount: gas,
            timelockSlot: votingOpenSlot,
            resultsAddress: resultsAddress ?? admin_address,
            commitUtxos: [
                { txHash, outputIndex: 1, description: '(601) ballot instance token + gas' },
            ],
        });
    } catch (err: any) {
        console.error('Failed to prepare ballot:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to prepare ballot', 500);
    }
});

/**
 * Fetch the current Cardano tip slot from Blockfrost.
 * Used by the modification guardrail to enforce the timelock buffer.
 */
async function getCurrentSlot(blockfrostKey: string): Promise<number> {
    const networkPrefix = blockfrostKey.startsWith('mainnet')
        ? 'cardano-mainnet'
        : blockfrostKey.startsWith('preprod')
            ? 'cardano-preprod'
            : 'cardano-preview';

    const res = await fetch(
        `https://${networkPrefix}.blockfrost.io/api/v0/blocks/latest`,
        { headers: { project_id: blockfrostKey } },
    );
    if (!res.ok) {
        throw new Error(`Blockfrost /blocks/latest failed: ${res.status}`);
    }
    const block = await res.json() as { slot: number };
    return block.slot;
}

/**
 * POST /prepare/cancel
 *
 * Burn the (600)+(601) ballot token pair before the Hydra head opens.
 *
 * The minting policy's native script allows burning while still before the
 * timelock slot. The guardrail also rejects if a head is already active.
 *
 * Body:
 *   namespace: string              — same as /prepare
 *   votingWindowOpen: string       — ISO timestamp used to derive the timelocked policy
 *   definitionUtxo: { txHash, outputIndex }  — the (600) UTxO to burn
 *   instanceUtxo:   { txHash, outputIndex }  — the (601) UTxO to burn
 *   refundAddress?: string         — where refunded ADA goes (default: admin)
 */
router.post('/prepare/cancel', async (req, res) => {
    const { namespace, votingWindowOpen, definitionUtxo, instanceUtxo, refundAddress } = req.body as {
        namespace: string;
        votingWindowOpen: string;
        definitionUtxo: { txHash: string; outputIndex: number };
        instanceUtxo: { txHash: string; outputIndex: number };
        refundAddress?: string;
    };

    if (!namespace || !votingWindowOpen || !definitionUtxo || !instanceUtxo) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: namespace, votingWindowOpen, definitionUtxo, instanceUtxo', 400);
    }

    try {
        const blockfrostKey = process.env.BLOCKFROST_API_KEY as string;
        const blockfrost = new BlockfrostProvider(blockfrostKey);
        const admin_wallet: MeshWallet = await getAdmin(blockfrostKey);
        const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        const votingOpenSlot = await timestampToSlot(votingWindowOpen, blockfrostKey);
        const currentSlot = await getCurrentSlot(blockfrostKey);

        const check = checkBallotModifiable({ votingOpenSlot, currentSlot });
        if (!check.ok) {
            return error(res, check.code, check.message, check.statusCode);
        }

        // Re-derive policy + asset names (deterministic from namespace + admin + slot)
        const { scriptCbor: SCRIPT_CBOR, scriptHash: POLICY_ID } = createNativeScript(admin_address, {
            invalidHereafter: votingOpenSlot,
            networkId: HYDRA_NETWORK,
        });
        if (!SCRIPT_CBOR || !POLICY_ID) {
            return error(res, 'WALLET_INIT_FAILED', 'Failed to derive native script from admin wallet', 503);
        }

        const fingerprintBytes = blake2b(Buffer.from(namespace, 'utf8'), undefined, 28);
        const fingerprint = bytesToHex(fingerprintBytes);
        const definitionAssetName = buildAssetName(BALLOT_DEFINITION_PREFIX, fingerprint);
        const instanceAssetName = buildAssetName(BALLOT_INSTANCE_PREFIX, fingerprint);

        // Fetch the UTxOs to confirm they exist and carry the expected tokens
        const defUtxos = await blockfrost.fetchUTxOs(definitionUtxo.txHash, definitionUtxo.outputIndex);
        const instUtxos = await blockfrost.fetchUTxOs(instanceUtxo.txHash, instanceUtxo.outputIndex);
        const defUtxo = defUtxos.find(u => u.input.outputIndex === definitionUtxo.outputIndex);
        const instUtxo = instUtxos.find(u => u.input.outputIndex === instanceUtxo.outputIndex);
        if (!defUtxo || !instUtxo) {
            return error(res, 'INVALID_INPUT', 'Ballot UTxOs not found on-chain (already spent?)', 400);
        }

        const defHasToken = defUtxo.output.amount.some(a => a.unit === POLICY_ID + definitionAssetName);
        const instHasToken = instUtxo.output.amount.some(a => a.unit === POLICY_ID + instanceAssetName);
        if (!defHasToken || !instHasToken) {
            return error(res, 'INVALID_INPUT', 'Provided UTxOs do not carry the expected ballot tokens for this namespace', 400);
        }

        const txBuilder = new MeshTxBuilder({ fetcher: blockfrost, evaluator: blockfrost });

        txBuilder
            .txIn(defUtxo.input.txHash, defUtxo.input.outputIndex, defUtxo.output.amount, defUtxo.output.address)
            .txIn(instUtxo.input.txHash, instUtxo.input.outputIndex, instUtxo.output.amount, instUtxo.output.address)
            .mint('-1', POLICY_ID, definitionAssetName)
            .mintingScript(SCRIPT_CBOR)
            .mint('-1', POLICY_ID, instanceAssetName)
            .mintingScript(SCRIPT_CBOR)
            .invalidHereafter(votingOpenSlot);

        const unsignedTx = await txBuilder
            .changeAddress(refundAddress ?? admin_address)
            .selectUtxosFrom(await blockfrost.fetchAddressUTxOs(admin_address))
            .complete();

        const signedTx = await admin_wallet.signTx(unsignedTx);
        const txHash = await blockfrost.submitTx(signedTx);

        return success(res, {
            txHash,
            cancelled: true,
            policyId: POLICY_ID,
            fingerprint,
            refundAddress: refundAddress ?? admin_address,
        });
    } catch (err: any) {
        console.error('Failed to cancel ballot:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to cancel ballot', 500);
    }
});

/**
 * POST /prepare/update
 *
 * Update an already-minted ballot before the Hydra head opens.
 *
 * Spends the existing (600)+(601) UTxOs and re-emits them with refreshed
 * inline datums. The namespace (and therefore the asset names/fingerprint)
 * is immutable — to change namespace, cancel + re-prepare.
 *
 * Does NOT mint or burn, so the timelocked policy's minting constraint
 * does not apply directly — but the guardrail still rejects updates after
 * the voting window has opened (or within the safety buffer), to keep the
 * on-chain state stable once voting can start.
 *
 * Body: same shape as /prepare, PLUS:
 *   definitionUtxo: { txHash, outputIndex }
 *   instanceUtxo:   { txHash, outputIndex }
 *
 *   definitionAddress?, instanceAddress?, resultsAddress? — may be changed
 *   on update; default to the current UTxO's address so omission = leave put.
 */
router.post('/prepare/update', async (req, res) => {
    const { namespace, ballot, definitionUtxo, instanceUtxo, gasAmount, cip179, resultsAddress } = req.body as {
        namespace: string;
        ballot: BallotDefinition;
        definitionUtxo: { txHash: string; outputIndex: number };
        instanceUtxo: { txHash: string; outputIndex: number };
        gasAmount?: number;
        cip179?: boolean;
        resultsAddress?: string;
    };

    if (!namespace || !ballot || !definitionUtxo || !instanceUtxo) {
        return error(res, 'MISSING_FIELDS', 'Missing required fields: namespace, ballot, definitionUtxo, instanceUtxo', 400);
    }

    try {
        const blockfrostKey = process.env.BLOCKFROST_API_KEY as string;
        const blockfrost = new BlockfrostProvider(blockfrostKey);
        const admin_wallet: MeshWallet = await getAdmin(blockfrostKey);
        const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        const votingOpenSlot = await timestampToSlot(ballot.ekklesia.votingWindow.open, blockfrostKey);
        const currentSlot = await getCurrentSlot(blockfrostKey);

        const check = checkBallotModifiable({ votingOpenSlot, currentSlot });
        if (!check.ok) {
            return error(res, check.code, check.message, check.statusCode);
        }

        const { scriptHash: POLICY_ID } = createNativeScript(admin_address, {
            invalidHereafter: votingOpenSlot,
            networkId: HYDRA_NETWORK,
        });
        if (!POLICY_ID) {
            return error(res, 'WALLET_INIT_FAILED', 'Failed to derive native script from admin wallet', 503);
        }

        const fingerprintBytes = blake2b(Buffer.from(namespace, 'utf8'), undefined, 28);
        const fingerprint = bytesToHex(fingerprintBytes);
        const definitionAssetName = buildAssetName(BALLOT_DEFINITION_PREFIX, fingerprint);
        const instanceAssetName = buildAssetName(BALLOT_INSTANCE_PREFIX, fingerprint);

        // Fetch existing UTxOs
        const defUtxos = await blockfrost.fetchUTxOs(definitionUtxo.txHash, definitionUtxo.outputIndex);
        const instUtxos = await blockfrost.fetchUTxOs(instanceUtxo.txHash, instanceUtxo.outputIndex);
        const defUtxo = defUtxos.find(u => u.input.outputIndex === definitionUtxo.outputIndex);
        const instUtxo = instUtxos.find(u => u.input.outputIndex === instanceUtxo.outputIndex);
        if (!defUtxo || !instUtxo) {
            return error(res, 'INVALID_INPUT', 'Ballot UTxOs not found on-chain (already spent?)', 400);
        }

        const defHasToken = defUtxo.output.amount.some(a => a.unit === POLICY_ID + definitionAssetName);
        const instHasToken = instUtxo.output.amount.some(a => a.unit === POLICY_ID + instanceAssetName);
        if (!defHasToken || !instHasToken) {
            return error(res, 'INVALID_INPUT', 'Provided UTxOs do not carry the expected ballot tokens for this namespace', 400);
        }

        // Rebuild merkle tree + re-pin ballot JSON
        const questionLeaves: FileLeaf[] = ballot.questions.map((q) => ({
            name: q.questionId,
            contentHashHex: bytesToHex(blake2b256(JSON.stringify(q))),
        }));
        const ballotProofPackage = computePackage(questionLeaves, 'content+path');
        const ballotContentHash = ballotProofPackage.rootHex;

        const ballotWithMerkle: BallotDefinition = {
            ...ballot,
            ekklesia: {
                ...ballot.ekklesia,
                namespace,
                merkleRoot: ballotContentHash,
                ballotIpfsCid: '',
            },
        };

        const { cid: ballotIpfsCid } = await ipfs.pinJson(
            `ballot-${fingerprint}.json`,
            { ...ballotWithMerkle, ekklesia: { ...ballotWithMerkle.ekklesia, ballotIpfsCid: 'self' } },
        );
        ballotWithMerkle.ekklesia.ballotIpfsCid = ballotIpfsCid;
        await ipfs.pinJson(`ballot-proof-${fingerprint}.json`, ballotProofPackage);

        // Build updated inline datums — bump schema version to 2 so observers
        // can distinguish "updated pre-open" from the original mint datum.
        const toHex = (s: string) => s ? Buffer.from(s, 'utf-8').toString('hex') : '';
        const definitionDatumPlutus = {
            alternative: 0,
            fields: [
                [
                    toHex(ballot.title),
                    toHex(namespace),
                    toHex(admin_address),
                    ballotContentHash,
                    toHex(ballotIpfsCid),
                    ballot.questions.length,
                    toHex(ballot.ekklesia.votingWindow.open),
                    toHex(ballot.ekklesia.votingWindow.close),
                    ballot.endEpoch,
                ],
                2,  // bumped: datum schema version (1 = original, 2 = updated pre-open)
            ],
        };
        const instanceDatumPlutus = {
            alternative: 0,
            fields: [
                ['', '', '', ''],
                2,
            ],
        };

        const gas = gasAmount ?? 3;
        const gasLovelace = String(gas * 1_000_000);

        const txBuilder = new MeshTxBuilder({ fetcher: blockfrost, evaluator: blockfrost });

        // Update keeps (600) and (601) at admin. Post-open custody moves are
        // handled by /prepare/handoff.
        txBuilder
            .txIn(defUtxo.input.txHash, defUtxo.input.outputIndex, defUtxo.output.amount, defUtxo.output.address)
            .txIn(instUtxo.input.txHash, instUtxo.input.outputIndex, instUtxo.output.amount, instUtxo.output.address)
            // Re-emit (600) with updated datum
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: '5000000' },
                { unit: POLICY_ID + definitionAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(definitionDatumPlutus)
            // Re-emit (601) with updated datum + refreshed gas
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: gasLovelace },
                { unit: POLICY_ID + instanceAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(instanceDatumPlutus);

        // No mint/burn, but stay inside the timelock window anyway for consistency.
        txBuilder.invalidHereafter(votingOpenSlot);

        if (cip179) {
            const surveyDetails = toBallotSurveyDetails(ballotWithMerkle);
            txBuilder.metadataValue(17, surveyDetails as unknown as object);
        }

        const unsignedTx = await txBuilder
            .changeAddress(admin_address)
            .selectUtxosFrom(await blockfrost.fetchAddressUTxOs(admin_address))
            .complete();

        const signedTx = await admin_wallet.signTx(unsignedTx);
        const txHash = await blockfrost.submitTx(signedTx);

        return success(res, {
            txHash,
            updated: true,
            policyId: POLICY_ID,
            fingerprint,
            definitionAssetName,
            instanceAssetName,
            ballotIpfsCid,
            ballotContentHash,
            questionCount: ballot.questions.length,
            gasAmount: gas,
            timelockSlot: votingOpenSlot,
            resultsAddress: resultsAddress ?? admin_address,
            commitUtxos: [
                { txHash, outputIndex: 1, description: '(601) ballot instance token + gas (updated)' },
            ],
        });
    } catch (err: any) {
        console.error('Failed to update ballot:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to update ballot', 500);
    }
});

/**
 * POST /prepare/handoff
 *
 * Move the (600) ballot definition token to its final custody address on L1.
 * Intended to run AFTER `/start` succeeds, when the head is open and the
 * admin-held pre-open edit window (update / cancel) is no longer applicable.
 *
 * Spends the (600) UTxO at admin and re-outputs it at `destinationAddress`
 * with the original inline datum preserved. Does NOT mint or burn.
 *
 * Body:
 *   definitionUtxo: { txHash, outputIndex }
 *   destinationAddress?: string
 *     — where the (600) should land. Defaults to the cached `resultsAddress`
 *       (set during /start); falls back to the admin address if neither was set.
 *
 * Guardrail: requires hydraMonitor.headStatus === 'Open'.
 */
router.post('/prepare/handoff', async (req, res) => {
    const { definitionUtxo, destinationAddress } = req.body as {
        definitionUtxo: { txHash: string; outputIndex: number };
        destinationAddress?: string;
    };

    if (!definitionUtxo) {
        return error(res, 'MISSING_FIELDS', 'Missing required field: definitionUtxo', 400);
    }

    const status = hydraMonitor.headStatus;
    if (status !== 'OPEN') {
        return error(res, 'CONFLICT', `Handoff requires the Hydra head to be OPEN (status: ${status ?? 'UNKNOWN'}). Run /start first.`, 409);
    }

    try {
        const blockfrostKey = process.env.BLOCKFROST_API_KEY as string;
        const blockfrost = new BlockfrostProvider(blockfrostKey);
        const admin_wallet: MeshWallet = await getAdmin(blockfrostKey);
        const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        // Fetch the source UTxO
        const fetched = await blockfrost.fetchUTxOs(definitionUtxo.txHash, definitionUtxo.outputIndex);
        const sourceUtxo = fetched.find(u => u.input.outputIndex === definitionUtxo.outputIndex);
        if (!sourceUtxo) {
            return error(res, 'INVALID_INPUT', '(600) UTxO not found on-chain (already spent?)', 400);
        }

        // Confirm the UTxO carries a (600) ballot definition token
        const definitionAsset = sourceUtxo.output.amount.find(a =>
            a.unit !== 'lovelace' && a.unit.slice(56).startsWith(BALLOT_DEFINITION_PREFIX)
        );
        if (!definitionAsset) {
            return error(res, 'INVALID_INPUT', 'Provided UTxO does not carry a ballot definition (600) token', 400);
        }

        // Fetch the inline datum CBOR directly from Blockfrost so we can
        // preserve it verbatim on the new output. The fetched UTxO's
        // `output.plutusData` may be populated or not depending on the
        // provider build; the REST API gives us the authoritative bytes.
        const networkPrefix = blockfrostKey.startsWith('mainnet')
            ? 'cardano-mainnet'
            : blockfrostKey.startsWith('preprod')
                ? 'cardano-preprod'
                : 'cardano-preview';
        const utxoRes = await fetch(
            `https://${networkPrefix}.blockfrost.io/api/v0/txs/${definitionUtxo.txHash}/utxos`,
            { headers: { project_id: blockfrostKey } },
        );
        if (!utxoRes.ok) {
            throw new Error(`Blockfrost /txs/${definitionUtxo.txHash}/utxos failed: ${utxoRes.status}`);
        }
        const utxoData = await utxoRes.json() as {
            outputs: Array<{ output_index: number; inline_datum?: string | null }>;
        };
        const sourceOutput = utxoData.outputs.find(o => o.output_index === definitionUtxo.outputIndex);
        const inlineDatumCbor = sourceOutput?.inline_datum ?? null;
        if (!inlineDatumCbor) {
            return error(res, 'INVALID_INPUT', '(600) UTxO has no inline datum — cannot preserve on handoff', 400);
        }

        const destination = destinationAddress ?? getCachedResultsAddress() ?? admin_address;

        const txBuilder = new MeshTxBuilder({ fetcher: blockfrost, evaluator: blockfrost });
        txBuilder
            .txIn(sourceUtxo.input.txHash, sourceUtxo.input.outputIndex, sourceUtxo.output.amount, sourceUtxo.output.address)
            .txOut(destination, sourceUtxo.output.amount)
            .txOutInlineDatumValue(inlineDatumCbor, 'CBOR');

        const unsignedTx = await txBuilder
            .changeAddress(admin_address)
            .selectUtxosFrom(await blockfrost.fetchAddressUTxOs(admin_address))
            .complete();

        const signedTx = await admin_wallet.signTx(unsignedTx);
        const txHash = await blockfrost.submitTx(signedTx);

        return success(res, {
            txHash,
            definitionAsset: definitionAsset.unit,
            destinationAddress: destination,
        });
    } catch (err: any) {
        console.error('Failed to hand off ballot definition:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to hand off ballot definition', 500);
    }
});

/**
 * POST /sweep
 *
 * Consolidate the admin wallet: sweep all native tokens to a dump address
 * and combine all remaining ADA into a single UTxO.
 *
 * If there are no tokens to sweep, it still consolidates fragmented
 * ADA UTxOs (from previous test runs) into one output.
 *
 * Body:
 *   dumpAddress: string — bech32 address to receive any swept tokens
 */
router.post('/sweep', async (req, res) => {
    const { dumpAddress } = req.body as { dumpAddress?: string };

    try {
        const blockfrostKey = process.env.BLOCKFROST_API_KEY as string;
        const blockfrost = new BlockfrostProvider(blockfrostKey);
        const admin_wallet: MeshWallet = await getAdmin(blockfrostKey);
        const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        const utxos = await blockfrost.fetchAddressUTxOs(admin_address);

        if (utxos.length <= 1) {
            const hasTokens = utxos.some(u => u.output.amount.some(a => a.unit !== 'lovelace'));
            if (!hasTokens) {
                return success(res, { swept: 0, consolidated: false, message: 'Wallet is already clean' });
            }
        }

        // Collect all non-ADA assets
        const tokens: Array<{ unit: string; quantity: string }> = [];
        for (const u of utxos) {
            for (const a of u.output.amount) {
                if (a.unit !== 'lovelace') {
                    tokens.push({ unit: a.unit, quantity: a.quantity });
                }
            }
        }

        const txBuilder = new MeshTxBuilder({ fetcher: blockfrost, evaluator: blockfrost });

        // If there are tokens, send them to the dump address
        if (tokens.length > 0) {
            if (!dumpAddress) {
                return error(res, 'MISSING_FIELDS', 'Wallet has native tokens — dumpAddress is required to sweep them', 400);
            }
            txBuilder.txOut(dumpAddress, [
                { unit: 'lovelace', quantity: '5000000' },
                ...tokens,
            ]);
        }

        // Explicitly add ALL UTxOs as inputs to force consolidation
        for (const u of utxos) {
            txBuilder.txIn(u.input.txHash, u.input.outputIndex);
        }

        const unsignedTx = await txBuilder
            .changeAddress(admin_address)
            .complete();

        const signedTx = await admin_wallet.signTx(unsignedTx);
        const txHash = await blockfrost.submitTx(signedTx);

        return success(res, {
            swept: tokens.length,
            consolidated: utxos.length > 1,
            utxosBefore: utxos.length,
            txHash,
        });
    } catch (err: any) {
        console.error('Failed to sweep wallet:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to sweep wallet', 500);
    }
});

export default router;
