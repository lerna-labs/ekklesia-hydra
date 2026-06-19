/**
 * Regression coverage for the Critical finding
 * `script-witness-signatures-never-verified`: script (multisig) and calidus votes
 * were accepted without verifying that the witness signatures were valid or signed
 * this vote's merkleRoot. `verifyScriptWitness` only checked that a public key could
 * be extracted (the SDK returns `pubKeyHex` whenever the COSE merely parses), so an
 * `all`/`atLeast` DRep collapsed to ~1 signer and forged co-signer witnesses were
 * counted toward the threshold.
 *
 * Fix: `verifyCoseSignature` (src/cose-verify.ts) returns `validates` +
 * `messageMatches` separately (no address check), and the script + calidus paths
 * require both.
 */

import { describe, it, expect } from 'vitest';
import CMS from '@emurgo/cardano-message-signing-nodejs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bech32 } from 'bech32';
import { resolveNativeScriptHash } from '@meshsdk/core';
import { verifyCoseSignature } from '../src/cose-verify.js';
import { verifyVoteSignatures } from '../src/routes/voting.js';
import type { CoseWitness, NativeScriptDef } from '../src/types.js';

interface Key {
    priv: InstanceType<typeof CSL.PrivateKey>;
    pub: InstanceType<typeof CSL.PublicKey>;
    keyHashHex: string;
    addressBytes: Uint8Array; // CIP-129 key-DRep (0x22 || keyHash)
}

function genKey(): Key {
    const priv = CSL.PrivateKey.generate_ed25519();
    const pub = priv.to_public();
    const keyHashHex = pub.hash().to_hex();
    return { priv, pub, keyHashHex, addressBytes: new Uint8Array([0x22, ...pub.hash().to_bytes()]) };
}

/** Build a CIP-8 COSE_Sign1 + COSE_Key witness over `message`. */
function buildWitness(message: string, key: Key): CoseWitness {
    const headerMap = CMS.HeaderMap.new();
    headerMap.set_algorithm_id(CMS.Label.from_algorithm_id(CMS.AlgorithmId.EdDSA));
    headerMap.set_header(CMS.Label.new_text('address'), CMS.CBORValue.new_bytes(key.addressBytes));
    const protectedHeaders = CMS.ProtectedHeaderMap.new(headerMap);
    const unprotectedHeaders = CMS.HeaderMap.new();
    const headers = CMS.Headers.new(protectedHeaders, unprotectedHeaders);

    const builder = CMS.COSESign1Builder.new(headers, Buffer.from(message, 'utf-8'), false);
    const sigBytes = key.priv.sign(builder.make_data_to_sign().to_bytes());
    const coseSign1 = builder.build(sigBytes.to_bytes());

    const coseKey = CMS.COSEKey.new(CMS.Label.from_key_type(CMS.KeyType.OKP));
    coseKey.set_algorithm_id(CMS.Label.from_algorithm_id(CMS.AlgorithmId.EdDSA));
    coseKey.set_header(CMS.Label.new_int(CMS.Int.new_negative(CMS.BigNum.from_str('1'))), CMS.CBORValue.new_int(CMS.Int.new_i32(6)));
    coseKey.set_header(CMS.Label.new_int(CMS.Int.new_negative(CMS.BigNum.from_str('2'))), CMS.CBORValue.new_bytes(key.pub.as_bytes()));

    return {
        coseSign1Hex: Buffer.from(coseSign1.to_bytes()).toString('hex'),
        coseKeyHex: Buffer.from(coseKey.to_bytes()).toString('hex'),
        key: Buffer.from(key.pub.as_bytes()).toString('hex'),
        signature: Buffer.from(sigBytes.to_bytes()).toString('hex'),
    };
}

const MR = 'a'.repeat(64);
const OTHER_MR = 'b'.repeat(64);

describe('verifyCoseSignature (no address check)', () => {
    it('a valid witness validates and matches the message', () => {
        const w = buildWitness(MR, genKey());
        const r = verifyCoseSignature(w.coseSign1Hex, MR, w.coseKeyHex);
        expect(r.validates).toBe(true);
        expect(r.messageMatches).toBe(true);
        expect(r.pubKeyHex).toBe(w.key);
    });

    it('a witness that signed a different message: validates but messageMatches=false', () => {
        const w = buildWitness(OTHER_MR, genKey()); // signed OTHER_MR
        const r = verifyCoseSignature(w.coseSign1Hex, MR, w.coseKeyHex); // expect MR
        expect(r.validates).toBe(true);
        expect(r.messageMatches).toBe(false);
    });
});

describe('verifyVoteSignatures — script (all-of-2) witnesses are actually verified', () => {
    function allOf2(k1: Key, k2: Key): { nativeScript: NativeScriptDef; voterId: string } {
        const nativeScript: NativeScriptDef = {
            type: 'all',
            scripts: [
                { type: 'sig', keyHash: k1.keyHashHex },
                { type: 'sig', keyHash: k2.keyHashHex },
            ],
        };
        const scriptHashHex = resolveNativeScriptHash(nativeScript as any);
        const addr = new Uint8Array([0x23, ...Buffer.from(scriptHashHex, 'hex')]); // CIP-129 script-DRep
        const voterId = bech32.encode('drep', bech32.toWords(Buffer.from(addr)));
        return { nativeScript, voterId };
    }

    it('accepts when BOTH co-signers signed the merkleRoot', () => {
        const k1 = genKey(), k2 = genKey();
        const { nativeScript, voterId } = allOf2(k1, k2);
        const witnesses = [buildWitness(MR, k1), buildWitness(MR, k2)];
        const { error } = verifyVoteSignatures(MR, voterId, { nativeScript, witnesses });
        expect(error).toBeNull();
    });

    it('REJECTS when a required co-signer signed a different message (the bug)', () => {
        const k1 = genKey(), k2 = genKey();
        const { nativeScript, voterId } = allOf2(k1, k2);
        // k2 signs OTHER_MR — previously accepted; must now be rejected.
        const witnesses = [buildWitness(MR, k1), buildWitness(OTHER_MR, k2)];
        const { error } = verifyVoteSignatures(MR, voterId, { nativeScript, witnesses });
        expect(error).not.toBeNull();
    });

    it('REJECTS a forged witness carrying a member key but an invalid signature', () => {
        const k1 = genKey(), k2 = genKey();
        const { nativeScript, voterId } = allOf2(k1, k2);
        // Tamper k2's COSE signature bytes (still parses, but Ed25519 fails).
        const good = buildWitness(MR, k2);
        const tampered: CoseWitness = { ...good, coseSign1Hex: flipLastByte(good.coseSign1Hex) };
        const { error } = verifyVoteSignatures(MR, voterId, { nativeScript, witnesses: [buildWitness(MR, k1), tampered] });
        expect(error).not.toBeNull();
    });
});

function flipLastByte(hex: string): string {
    const b = Buffer.from(hex, 'hex');
    b[b.length - 1] ^= 0xff;
    return b.toString('hex');
}
