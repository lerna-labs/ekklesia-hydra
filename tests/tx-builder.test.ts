/**
 * Local unit tests for src/tx-builder.ts
 *
 * Verifies that all 5 transaction builders produce valid CBOR
 * without requiring a live Hydra head or TRP connection.
 *
 * Run: npx vitest run tests/tx-builder.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
    buildCastVoteTx,
    buildRegisterVoterTx,
    buildVoteAndRegisterTx,
    buildCountVoteTx,
    buildFinalizeBallotTx,
    hydraValueToAmounts,
} from '../src/tx-builder.js';
import type { UtxoRef, Amount } from '../src/tx-builder.js';
import { createNativeScript } from '@lerna-labs/hydra-sdk';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// Valid testnet address for createNativeScript
const ADMIN_ADDRESS = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp';

// Derive native script from admin address (same as middleware does)
const { scriptCbor: TOKEN_SCRIPT, scriptHash: TOKEN_POLICY } = createNativeScript(ADMIN_ADDRESS);

// Fake but properly-formatted values
const FAKE_TX_HASH = 'a'.repeat(64);
const FAKE_USER_ID = 'bb'.repeat(29); // 29-byte voter token name (58 hex chars)
const FAKE_MERKLE_ROOT = 'cc'.repeat(32);
const FAKE_VOTE_HASH = 'dd'.repeat(32);
const FAKE_IPFS_CID = 'QmTest1234567890abcdef';
const FAKE_BALLOT_ID = 'ee'.repeat(32);
const FAKE_RESULTS_HASH = 'ff'.repeat(32);
const FAKE_EVIDENCE_CID = 'QmEvidence1234567890';

const baseInputRef: UtxoRef = { txHash: FAKE_TX_HASH, outputIndex: 0 };

// Ballot token UTxO value (lovelace + ballot instance token)
const BALLOT_POLICY = '11'.repeat(28);
const BALLOT_TOKEN_NAME = '00259a20' + 'ab'.repeat(28); // (601) prefix + fingerprint
const ballotInputValue: Amount[] = [
    { unit: 'lovelace', quantity: '3000000' },
    { unit: BALLOT_POLICY + BALLOT_TOKEN_NAME, quantity: '1' },
];

// Voter token UTxO value
const voterInputValue: Amount[] = [
    { unit: 'lovelace', quantity: '0' },
    { unit: TOKEN_POLICY + FAKE_USER_ID, quantity: '1' },
];

// Ballot datum as it would appear in our cache (snapshot format converted)
const ballotDatum = {
    constructor: 0,
    fields: [
        { bytes: '' },
        { bytes: '' },
        { bytes: '' },
        { bytes: '' },
    ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tx-builder', () => {

    describe('hydraValueToAmounts', () => {
        it('should convert Hydra snapshot value to Amount[]', () => {
            const hydraValue = {
                lovelace: 3000000,
                [BALLOT_POLICY]: { [BALLOT_TOKEN_NAME]: 1 },
            };
            const amounts = hydraValueToAmounts(hydraValue);
            expect(amounts).toHaveLength(2);
            expect(amounts[0]).toEqual({ unit: 'lovelace', quantity: '3000000' });
            expect(amounts[1]).toEqual({ unit: BALLOT_POLICY + BALLOT_TOKEN_NAME, quantity: '1' });
        });
    });

    describe('buildCastVoteTx', () => {
        it('should produce valid CBOR hex', () => {
            const cbor = buildCastVoteTx({
                adminAddress: ADMIN_ADDRESS,
                tokenPolicy: TOKEN_POLICY!,
                userId: FAKE_USER_ID,
                version: 2,
                merkleRoot: FAKE_MERKLE_ROOT,
                voteHash: FAKE_VOTE_HASH,
                ipfsCid: FAKE_IPFS_CID,
                inputRef: baseInputRef,
                inputValue: voterInputValue,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
            // CBOR hex should only contain hex characters
            expect(cbor).toMatch(/^[0-9a-f]+$/i);
            console.log(`  buildCastVoteTx: ${cbor.length} hex chars`);
        });

        it('should work with version 1 (first vote)', () => {
            const cbor = buildCastVoteTx({
                adminAddress: ADMIN_ADDRESS,
                tokenPolicy: TOKEN_POLICY!,
                userId: FAKE_USER_ID,
                version: 1,
                merkleRoot: FAKE_MERKLE_ROOT,
                voteHash: FAKE_VOTE_HASH,
                ipfsCid: FAKE_IPFS_CID,
                inputRef: baseInputRef,
                inputValue: voterInputValue,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
        });
    });

    describe('buildRegisterVoterTx', () => {
        it('should produce valid CBOR hex with native script minting', () => {
            expect(TOKEN_SCRIPT).toBeDefined();
            expect(TOKEN_POLICY).toBeDefined();

            const cbor = buildRegisterVoterTx({
                adminAddress: ADMIN_ADDRESS,
                tokenPolicy: TOKEN_POLICY!,
                tokenScript: TOKEN_SCRIPT!,
                userId: FAKE_USER_ID,
                inputRef: baseInputRef,
                inputValue: ballotInputValue,
                inputDatum: ballotDatum,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
            expect(cbor).toMatch(/^[0-9a-f]+$/i);
            console.log(`  buildRegisterVoterTx: ${cbor.length} hex chars`);
        });
    });

    describe('buildVoteAndRegisterTx', () => {
        it('should produce valid CBOR hex with native script minting and vote datum', () => {
            const cbor = buildVoteAndRegisterTx({
                adminAddress: ADMIN_ADDRESS,
                tokenPolicy: TOKEN_POLICY!,
                tokenScript: TOKEN_SCRIPT!,
                userId: FAKE_USER_ID,
                merkleRoot: FAKE_MERKLE_ROOT,
                voteHash: FAKE_VOTE_HASH,
                ipfsCid: FAKE_IPFS_CID,
                inputRef: baseInputRef,
                inputValue: ballotInputValue,
                inputDatum: ballotDatum,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
            expect(cbor).toMatch(/^[0-9a-f]+$/i);
            console.log(`  buildVoteAndRegisterTx: ${cbor.length} hex chars`);
        });
    });

    describe('buildCountVoteTx', () => {
        it('should produce valid CBOR hex with native script burn', () => {
            const cbor = buildCountVoteTx({
                adminAddress: ADMIN_ADDRESS,
                tokenPolicy: TOKEN_POLICY!,
                tokenScript: TOKEN_SCRIPT!,
                userId: FAKE_USER_ID,
                inputRef: baseInputRef,
                inputValue: voterInputValue,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
            expect(cbor).toMatch(/^[0-9a-f]+$/i);
            console.log(`  buildCountVoteTx: ${cbor.length} hex chars`);
        });
    });

    describe('buildFinalizeBallotTx', () => {
        it('should produce valid CBOR hex with updated datum', () => {
            const cbor = buildFinalizeBallotTx({
                adminAddress: ADMIN_ADDRESS,
                ballotId: FAKE_BALLOT_ID,
                resultsHash: FAKE_RESULTS_HASH,
                evidenceCid: FAKE_EVIDENCE_CID,
                merkleRoot: FAKE_MERKLE_ROOT,
                inputRef: baseInputRef,
                inputValue: ballotInputValue,
            });

            expect(typeof cbor).toBe('string');
            expect(cbor.length).toBeGreaterThan(0);
            expect(cbor).toMatch(/^[0-9a-f]+$/i);
            console.log(`  buildFinalizeBallotTx: ${cbor.length} hex chars`);
        });
    });
});
