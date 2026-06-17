/**
 * Regression coverage for audit finding F-002: the native-script credential-hash
 * extraction stripped the CIP-129 prefix byte ONLY for `drep` + `0x23`. Every
 * other script-capable credential fell through and kept its full 29-byte payload,
 * which can never equal a 28-byte native-script hash — so the voter was silently
 * rejected.
 *
 * The concrete victim is a script-based STAKE credential: a CIP-19 reward address
 * with a script header (`0xf?`) + 28-byte hash. It used to fall through; now its
 * header byte is stripped and the 28-byte hash is recovered.
 *
 * Note on the audit's suggested fix: it listed `pool 0x06` / `stake 0xe0` as
 * prefixes to strip. That is wrong for pool — a pool ID is a raw 28-byte hash
 * with NO header byte, so stripping would corrupt it; and pool is never
 * script-based, so it must not produce a credential hash here at all. `calidus`
 * was removed as a voter identity in F-001. The extractor below is therefore
 * scoped to the only genuinely script-capable types: script DRep and script stake.
 */

import { describe, it, expect } from 'vitest';
import { extractScriptCredentialHash } from '../src/helpers.js';

// A fixed 28-byte blake2b-224 hash and helpers to frame it with a header byte.
const hash28 = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabb', 'hex');
const HEX = hash28.toString('hex');
const framed = (header: number) => new Uint8Array([header, ...hash28]);

describe('F-002 — script credential hash extraction', () => {
    describe('recognized script credentials → 28-byte hash', () => {
        it('script DRep (drep, 0x23) strips the kind byte', () => {
            expect(extractScriptCredentialHash('drep', framed(0x23))).toBe(HEX);
        });

        it('script stake testnet (stake_test, 0xf0) strips the header', () => {
            expect(extractScriptCredentialHash('stake_test', framed(0xf0))).toBe(HEX);
        });

        it('script stake mainnet (stake, 0xf1) strips the header', () => {
            expect(extractScriptCredentialHash('stake', framed(0xf1))).toBe(HEX);
        });

        it('extracted hash is exactly 28 bytes (56 hex chars)', () => {
            expect(extractScriptCredentialHash('drep', framed(0x23))).toHaveLength(56);
        });

        it('accepts number[] (the shape bech32.fromWords returns)', () => {
            expect(extractScriptCredentialHash('drep', [0x23, ...hash28])).toBe(HEX);
        });
    });

    describe('non-script credentials → null (caller rejects)', () => {
        it('key DRep (drep, 0x22) is not a script credential', () => {
            expect(extractScriptCredentialHash('drep', framed(0x22))).toBeNull();
        });

        it('key stake testnet (stake_test, 0xe0) is not a script credential', () => {
            expect(extractScriptCredentialHash('stake_test', framed(0xe0))).toBeNull();
        });

        it('key stake mainnet (stake, 0xe1) is not a script credential', () => {
            expect(extractScriptCredentialHash('stake', framed(0xe1))).toBeNull();
        });

        it('pool (raw 28-byte hash, no header) yields no script credential', () => {
            // Pool IDs are 28 bytes with no prefix and are never script-based.
            expect(extractScriptCredentialHash('pool', hash28)).toBeNull();
        });

        it('unrecognized HRP yields null even with a script-looking header', () => {
            expect(extractScriptCredentialHash('cc', framed(0x23))).toBeNull();
        });

        it('wrong payload length (28 bytes, no header) yields null', () => {
            expect(extractScriptCredentialHash('drep', hash28)).toBeNull();
        });
    });
});
