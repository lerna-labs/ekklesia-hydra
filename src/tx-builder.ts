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

/**
 * Convert a Hydra snapshot datum field to MeshTxBuilder format.
 * Snapshot uses { bytes: "hex" } and { int: N } wrappers.
 * MeshTxBuilder expects raw strings and numbers.
 */
function unwrapDatumField(field: any): any {
    if (field === null || field === undefined) return '';
    if (typeof field === 'string' || typeof field === 'number') return field;
    if ('bytes' in field) return field.bytes;
    if ('int' in field) return field.int;
    if (Array.isArray(field)) return field.map(unwrapDatumField);
    if ('list' in field) return field.list.map(unwrapDatumField);
    if ('fields' in field) return { alternative: field.constructor ?? 0, fields: field.fields.map(unwrapDatumField) };
    return field;
}

/**
 * Build a BallotResult datum (passthrough — preserves existing datum).
 * Converts from Hydra snapshot format to MeshTxBuilder format.
 */
function ballotResultDatum(existing: any) {
    if (!existing) {
        // Fallback: empty BallotResult
        return { alternative: 0, fields: [['', '', '', ''], 0] };
    }
    const fields = (existing.fields ?? []).map(unwrapDatumField);
    return { alternative: 0, fields };
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
// prime_snapshot — self-spend the (601) ballot UTxO back to its own address
// ---------------------------------------------------------------------------
//
// Under Hydra v2 (ADR-33) a head opens empty and the (601) is added as a
// deposit/increment. That increment lands in the head ledger but does NOT by
// itself advance a *confirmed* signed snapshot — and the TRP resolves in-head
// transaction inputs against the confirmed snapshot, so until one is produced
// the ballot token is invisible to it (`input not resolved: gas`). Spending the
// (601) back to its own address in a single zero-fee tx produces the next
// confirmed snapshot carrying the token, after which the TRP resolves
// register/vote txs normally. The existing inline datum is preserved verbatim
// (raw CBOR passthrough) so the (601) BallotResult datum is untouched ahead of
// settlement, and the value (token + gas ADA) is recreated unchanged.

export function buildPrimeSnapshotTx(params: {
    address: string;
    inputRef: UtxoRef;
    inputValue: Amount[];
    inlineDatumCborHex: string | null;
}): string {
    const { address, inputRef, inputValue, inlineDatumCborHex } = params;

    const txBuilder = new MeshTxBuilder({ isHydra: true });
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, address)
        .txOut(address, inputValue);
    if (inlineDatumCborHex) {
        // Preserve the (601) datum exactly — raw CBOR passthrough, no re-encode.
        txBuilder.txOutInlineDatumValue(inlineDatumCborHex, 'CBOR');
    }
    txBuilder
        .setFee('0')
        .changeAddress(address);

    return txBuilder.completeSync();
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

    const txBuilder = new MeshTxBuilder({ isHydra: true });
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

    const txBuilder = new MeshTxBuilder({ isHydra: true });
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

    const txBuilder = new MeshTxBuilder({ isHydra: true });
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

    const txBuilder = new MeshTxBuilder({ isHydra: true });
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

    const txBuilder = new MeshTxBuilder({ isHydra: true });
    txBuilder
        .txIn(inputRef.txHash, inputRef.outputIndex, inputValue, adminAddress)
        .txOut(adminAddress, inputValue)
        .txOutInlineDatumValue(updatedDatum)
        .setFee('0')
        .changeAddress(adminAddress);

    return txBuilder.completeSync();
}
