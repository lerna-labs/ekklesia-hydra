/**
 * Unit test: validate COSE_Sign1 construction and verification using
 * in-process @emurgo libraries. This provides a fast feedback loop
 * without needing a network or the cardano-signer binary.
 *
 * Run: npx vitest run tests/signing.test.ts
 */

import { describe, it, expect } from 'vitest';
import CMS from '@emurgo/cardano-message-signing-nodejs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bech32 } from 'bech32';
import { verifySignature } from '@lerna-labs/hydra-sdk';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import type { SignedVotePayload } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GeneratedDRep {
    privateKey: InstanceType<typeof CSL.PrivateKey>;
    publicKey: InstanceType<typeof CSL.PublicKey>;
    drepId: string;
    addressBytes: Uint8Array;
}

/** Generate a DRep keypair and CIP-129 bech32 address in-process. */
function generateDRep(): GeneratedDRep {
    const privateKey = CSL.PrivateKey.generate_ed25519();
    const publicKey = privateKey.to_public();
    const keyHash = publicKey.hash().to_bytes(); // blake2b-224
    const addressBytes = new Uint8Array([0x22, ...keyHash]);
    const drepId = bech32.encode('drep', bech32.toWords(Buffer.from(addressBytes)));
    return { privateKey, publicKey, drepId, addressBytes };
}

interface CoseSignatureResult {
    coseSign1Hex: string;
    coseKeyHex: string;
    key: string;
    signature: string;
}

/** Build a CIP-8 COSE_Sign1 + COSE_Key for a given merkleRoot. */
function buildCoseSignature(
    merkleRoot: string,
    privateKey: InstanceType<typeof CSL.PrivateKey>,
    publicKey: InstanceType<typeof CSL.PublicKey>,
    addressBytes: Uint8Array,
): CoseSignatureResult {
    // Protected headers: algorithm + address
    const headerMap = CMS.HeaderMap.new();
    headerMap.set_algorithm_id(CMS.Label.from_algorithm_id(CMS.AlgorithmId.EdDSA));
    headerMap.set_header(
        CMS.Label.new_text('address'),
        CMS.CBORValue.new_bytes(addressBytes),
    );
    const protectedHeaders = CMS.ProtectedHeaderMap.new(headerMap);

    // Unprotected headers: hashed flag
    const unprotectedHeaders = CMS.HeaderMap.new();
    unprotectedHeaders.set_header(
        CMS.Label.new_text('hashed'),
        CMS.CBORValue.new_special(CMS.CBORSpecial.new_bool(false)),
    );

    const headers = CMS.Headers.new(protectedHeaders, unprotectedHeaders);

    // Build and sign COSE_Sign1
    const payload = Buffer.from(merkleRoot, 'utf-8');
    const builder = CMS.COSESign1Builder.new(headers, payload, false);
    const sigBytes = privateKey.sign(builder.make_data_to_sign().to_bytes());
    const coseSign1 = builder.build(sigBytes.to_bytes());

    // Build COSE_Key (OKP / Ed25519)
    const coseKey = CMS.COSEKey.new(CMS.Label.from_key_type(CMS.KeyType.OKP));
    coseKey.set_algorithm_id(CMS.Label.from_algorithm_id(CMS.AlgorithmId.EdDSA));
    coseKey.set_header(
        CMS.Label.new_int(CMS.Int.new_negative(CMS.BigNum.from_str('1'))),
        CMS.CBORValue.new_int(CMS.Int.new_i32(6)), // Ed25519 curve
    );
    coseKey.set_header(
        CMS.Label.new_int(CMS.Int.new_negative(CMS.BigNum.from_str('2'))),
        CMS.CBORValue.new_bytes(publicKey.as_bytes()), // public key
    );

    return {
        coseSign1Hex: Buffer.from(coseSign1.to_bytes()).toString('hex'),
        coseKeyHex: Buffer.from(coseKey.to_bytes()).toString('hex'),
        key: Buffer.from(publicKey.as_bytes()).toString('hex'),
        signature: Buffer.from(sigBytes.to_bytes()).toString('hex'),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('COSE Signature Construction & Verification', () => {

    it('should produce a valid COSE_Sign1 that the SDK accepts', () => {
        const drep = generateDRep();
        const merkleRoot = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

        const witness = buildCoseSignature(merkleRoot, drep.privateKey, drep.publicKey, drep.addressBytes);

        const result = verifySignature(witness.coseSign1Hex, merkleRoot, drep.drepId, witness.coseKeyHex);

        expect(result.isValid).toBe(true);
        expect(result.pubKeyHex).toBe(witness.key);
    });

    it('should reject a signature against a different merkleRoot', () => {
        const drep = generateDRep();
        const realRoot = 'aaaa000000000000000000000000000000000000000000000000000000000000';
        const fakeRoot = 'bbbb000000000000000000000000000000000000000000000000000000000000';

        const witness = buildCoseSignature(realRoot, drep.privateKey, drep.publicKey, drep.addressBytes);

        // Verify against the wrong merkleRoot
        const result = verifySignature(witness.coseSign1Hex, fakeRoot, drep.drepId, witness.coseKeyHex);
        expect(result.isValid).toBe(false);
    });

    it('should reject a signature from a different key', () => {
        const drep1 = generateDRep();
        const drep2 = generateDRep();
        const merkleRoot = 'cccc000000000000000000000000000000000000000000000000000000000000';

        // Sign with drep2's key but verify against drep1's address
        const witness = buildCoseSignature(merkleRoot, drep2.privateKey, drep2.publicKey, drep2.addressBytes);

        const result = verifySignature(witness.coseSign1Hex, merkleRoot, drep1.drepId, witness.coseKeyHex);
        expect(result.isValid).toBe(false);
    });

    it('should work with a real SignedVotePayload merkleRoot', () => {
        const drep = generateDRep();

        const signedPayload: SignedVotePayload = {
            ballotId: 'abc123def456',
            nonce: 1,
            votes: [
                { questionId: 'q1', selection: [1] },
                { questionId: 'q2', selection: [0, 2] },
            ],
        };

        const merkleRoot = bytesToHex(blake2b256(JSON.stringify(signedPayload)));
        const witness = buildCoseSignature(merkleRoot, drep.privateKey, drep.publicKey, drep.addressBytes);

        const result = verifySignature(witness.coseSign1Hex, merkleRoot, drep.drepId, witness.coseKeyHex);

        expect(result.isValid).toBe(true);
        expect(result.pubKeyHex).toBe(witness.key);
    });

    it('should produce consistent merkleRoot for identical payloads', () => {
        const payload: SignedVotePayload = {
            ballotId: 'test-ballot',
            nonce: 3,
            votes: [{ questionId: 'q1', selection: [0] }],
        };

        const root1 = bytesToHex(blake2b256(JSON.stringify(payload)));
        const root2 = bytesToHex(blake2b256(JSON.stringify(payload)));

        expect(root1).toBe(root2);
        expect(root1).toHaveLength(64); // 32 bytes = 64 hex chars
    });
});
