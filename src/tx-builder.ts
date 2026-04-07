/**
 * Direct transaction builders for in-head Hydra operations.
 *
 * Replaces TRP transaction resolution with local MeshTxBuilder construction.
 * Each function takes a UTxO ref + value (from the local cache) and returns
 * unsigned CBOR hex. The caller signs and submits via WebSocket.
 *
 * All in-head transactions have zero fees.
 */

import { MeshTxBuilder } from '@meshsdk/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UtxoRef {
    txHash: string;
    outputIndex: number;
}

export interface Amount {
    unit: string;      // 'lovelace' or policyId + assetNameHex
    quantity: string;
}

// ---------------------------------------------------------------------------
// Datum builders
// ---------------------------------------------------------------------------

/** Build a Vote datum for MeshTxBuilder's txOutInlineDatumValue(). */
function voteDatum(
    userId: string,
    version: number,
    merkleRoot: string,
    voteHash: string,
    ipfsCid: string,
) {
    return {
        alternative: 0,
        fields: [
            userId,          // VoterId: Bytes
            version,         // Version: Int
            merkleRoot,      // MerkleRoot: Bytes
            voteHash,        // VoteHash: Bytes
            ipfsCid,         // IpfsCid: Bytes
        ],
    };
}

/** Build a BallotResult datum (passthrough — preserves existing datum). */
function ballotResultDatum(existing: any) {
    // The existing datum from the snapshot uses { constructor: 0, fields: [...] }
    // MeshTxBuilder expects { alternative: 0, fields: [...] }
    return {
        alternative: 0,
        fields: existing.fields ?? existing,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Hydra snapshot value format to MeshTxBuilder Amount[]. */
export function hydraValueToAmounts(value: Record<string, any>): Amount[] {
    const amounts: Amount[] = [];
    for (const [key, val] of Object.entries(value)) {
        if (key === 'lovelace') {
            amounts.push({ unit: 'lovelace', quantity: String(val) });
        } else if (typeof val === 'object') {
            for (const [name, qty] of Object.entries(val as Record<string, number>)) {
                amounts.push({ unit: key + name, quantity: String(qty) });
            }
        }
    }
    return amounts;
}

// ---------------------------------------------------------------------------
// cast_vote — update datum on voter's own UTxO (no minting)
// ---------------------------------------------------------------------------

export function buildCastVoteTx(params: {
    adminAddress: string;
    tokenPolicy: string;
    userId: string;
    version: number;
    merkleRoot: string;
    voteHash: string;
    ipfsCid: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
}): string {
    const {
        adminAddress, tokenPolicy, userId, version,
        merkleRoot, voteHash, ipfsCid, inputRef, inputValue,
    } = params;

    const ipfsCidHex = Buffer.from(ipfsCid).toString('hex');

    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .txOut(adminAddress, inputValue)
        .txOutInlineDatumValue(voteDatum(userId, version, merkleRoot, voteHash, ipfsCidHex))
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}

// ---------------------------------------------------------------------------
// register_voter — mint voter token, consume ballot UTxO for gas
// ---------------------------------------------------------------------------

export function buildRegisterVoterTx(params: {
    adminAddress: string;
    tokenPolicy: string;
    tokenScript: string;
    userId: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
    inputDatum: any;
}): string {
    const {
        adminAddress, tokenPolicy, tokenScript, userId,
        inputRef, inputValue, inputDatum,
    } = params;

    // Voter token output: 0 lovelace + 1 voter token (Hydra has 0 minUTxO)
    const voterTokenAmount: Amount[] = [
        { unit: 'lovelace', quantity: '0' },
        { unit: tokenPolicy + userId, quantity: '1' },
    ];

    // Gas return: same value as input (no ADA leaves the ballot token)
    const gasReturnAmount = inputValue;

    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .mint('1', tokenPolicy, userId)
        .mintingScript(tokenScript)
        // Output 0: voter token with empty Vote datum
        .txOut(adminAddress, voterTokenAmount)
        .txOutInlineDatumValue(voteDatum(userId, 0, '00', '00', '00'))
        // Output 1: gas return with original ballot datum
        .txOut(adminAddress, gasReturnAmount)
        .txOutInlineDatumValue(ballotResultDatum(inputDatum))
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}

// ---------------------------------------------------------------------------
// vote_and_register — mint voter token + set initial vote datum
// ---------------------------------------------------------------------------

export function buildVoteAndRegisterTx(params: {
    adminAddress: string;
    tokenPolicy: string;
    tokenScript: string;
    userId: string;
    merkleRoot: string;
    voteHash: string;
    ipfsCid: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
    inputDatum: any;
}): string {
    const {
        adminAddress, tokenPolicy, tokenScript, userId,
        merkleRoot, voteHash, ipfsCid,
        inputRef, inputValue, inputDatum,
    } = params;

    const ipfsCidHex = Buffer.from(ipfsCid).toString('hex');

    const voterTokenAmount: Amount[] = [
        { unit: 'lovelace', quantity: '0' },
        { unit: tokenPolicy + userId, quantity: '1' },
    ];

    const gasReturnAmount = inputValue;

    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .mint('1', tokenPolicy, userId)
        .mintingScript(tokenScript)
        // Output 0: voter token with populated Vote datum (version 1)
        .txOut(adminAddress, voterTokenAmount)
        .txOutInlineDatumValue(voteDatum(userId, 1, merkleRoot, voteHash, ipfsCidHex))
        // Output 1: gas return with original ballot datum
        .txOut(adminAddress, gasReturnAmount)
        .txOutInlineDatumValue(ballotResultDatum(inputDatum))
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}

// ---------------------------------------------------------------------------
// count_vote — burn voter token
// ---------------------------------------------------------------------------

export function buildCountVoteTx(params: {
    adminAddress: string;
    tokenPolicy: string;
    tokenScript: string;
    userId: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
}): string {
    const {
        adminAddress, tokenPolicy, tokenScript, userId,
        inputRef, inputValue,
    } = params;

    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .mint('-1', tokenPolicy, userId)
        .mintingScript(tokenScript)
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}

// ---------------------------------------------------------------------------
// finalize_ballot — update ballot datum with results
// ---------------------------------------------------------------------------

export function buildFinalizeBallotTx(params: {
    adminAddress: string;
    ballotId: string;
    resultsHash: string;
    evidenceCid: string;
    merkleRoot: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
}): string {
    const {
        adminAddress, ballotId, resultsHash, evidenceCid, merkleRoot,
        inputRef, inputValue,
    } = params;

    const evidenceCidHex = Buffer.from(evidenceCid).toString('hex');

    const updatedDatum = {
        alternative: 0,
        fields: [
            [
                ballotId,           // already hex
                resultsHash,        // already hex
                evidenceCidHex,     // IPFS CID → hex
                merkleRoot,         // already hex
            ],
            1,  // datum schema version
        ],
    };

    const txBuilder = new MeshTxBuilder();
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .txOut(adminAddress, inputValue)
        .txOutInlineDatumValue(updatedDatum)
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}
