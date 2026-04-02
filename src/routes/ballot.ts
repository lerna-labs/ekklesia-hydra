import {Router} from 'express';
import {BlockfrostProvider, MeshTxBuilder, MeshWallet} from '@meshsdk/core';
import {createNativeScript, getAdmin} from '@lerna-labs/hydra-sdk';
import type {FileLeaf} from '@lerna-labs/hydra-proof';
import {blake2b256, bytesToHex, computePackage} from '@lerna-labs/hydra-proof';
import {error, HYDRA_NETWORK, ipfs, success} from '../helpers.js';
import {toBallotSurveyDetails} from '../cip179.js';
import type {BallotDefinition, BallotDefinitionDatum, BallotInstanceDatum} from '../types.js';
import {BALLOT_DEFINITION_PREFIX, BALLOT_INSTANCE_PREFIX, BallotStatus, buildAssetName,} from '../types.js';

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
    const { namespace, ballot, gasAmount, cip179 } = req.body as {
        namespace: string;
        ballot: BallotDefinition;
        gasAmount?: number;
        cip179?: boolean;
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
        const fingerprintBytes = blake2b256(namespace).slice(0, 28);
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

        // --- 5. Build slim inline datums ---

        // (600) Ballot Definition datum — slim: merkle root + IPFS CID (NOT full content)
        const definitionDatum: BallotDefinitionDatum = {
            title: ballot.title,
            namespace,
            votingAuthority: admin_address,
            contentHash: ballotContentHash,
            ballotCid: ballotIpfsCid,
            questionCount: ballot.questions.length,
            votingWindow: ballot.ekklesia.votingWindow,
            endEpoch: ballot.endEpoch,
        };

        // (601) Ballot Instance datum — initial state (all proof fields zeroed)
        const instanceDatum: BallotInstanceDatum = {
            ballotId: '',
            status: BallotStatus.Created,
            resultsHash: '',
            evidenceCid: '',
            totalVoters: 0,
            merkleRoot: '',
        };

        // --- 5. Build the L1 minting transaction ---
        const txBuilder = new MeshTxBuilder({
            fetcher: blockfrost,
            evaluator: blockfrost,
        });

        const gas = gasAmount ?? 100;
        const gasLovelace = String(gas * 1_000_000);

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
                { unit: 'lovelace', quantity: '2000000' },
                { unit: POLICY_ID + definitionAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(JSON.stringify(definitionDatum))
            // Output: (601) token with inline datum → will be committed to Hydra
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: '2000000' },
                { unit: POLICY_ID + instanceAssetName, quantity: '1' },
            ])
            .txOutInlineDatumValue(JSON.stringify(instanceDatum))
            // Output: Gas UTxO for in-head operations
            .txOut(admin_address, [
                { unit: 'lovelace', quantity: gasLovelace },
            ]);

        // Set transaction validity to match the timelocked script
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
            commitUtxos: [
                { txHash, outputIndex: 1, description: '(601) ballot instance token' },
                { txHash, outputIndex: 2, description: 'Gas UTxO' },
            ],
        });
    } catch (err: any) {
        console.error('Failed to prepare ballot:', err);
        return error(res, 'INTERNAL_ERROR', err.message || 'Failed to prepare ballot', 500);
    }
});

export default router;
