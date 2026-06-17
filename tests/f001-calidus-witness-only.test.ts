/**
 * Regression coverage for audit finding F-001 — resolved by walk-back.
 *
 * The audit proposed changing the calidus credential header byte from `0x06`
 * to CIP-151's `0xa1`. Investigation showed that "fix" addressed the wrong
 * layer and left a more serious hole open: a calidus key is an SPO hot key
 * authorized for a pool, NOT an independent voter identity. The canonical SPO
 * identity is the pool ID (`pool1...`); the calidus key is supplied only as a
 * signing witness (`calidusDeclaration`).
 *
 * If `calidus1...` is also accepted as a standalone `voterId`, the same operator
 * mints two distinct voter tokens — `06 + blake2b_224(poolID)` and
 * `?? + blake2b_224(calidusKey)` — both tallying under the `pool` role, i.e. a
 * double vote. The prefix byte is irrelevant to this: the two token names differ
 * via the hash of different key material regardless of prefix.
 *
 * Resolution: `calidus` is removed as a voter identity entirely (dropped from
 * `CREDENTIAL_PREFIX` and `HRP_TO_ROLE`); `voterIdToTokenName` rejects it. SPOs
 * vote as the pool with a calidusDeclaration, so one operator can only ever hold
 * one voter token. This intentionally diverges from the audit's `0xa1`
 * recommendation (P71) — see the remediation log.
 */

import { describe, it, expect } from 'vitest';
import { bech32 } from 'bech32';
import { blake2b } from 'blakejs';
import { CREDENTIAL_PREFIX, HRP_TO_ROLE } from '../src/types.js';
import { voterIdToTokenName } from '../src/helpers.js';

// 28-byte hashes → syntactically valid bech32 ids.
const poolKeyHash = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabb', 'hex');
const calidusKeyHash = Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa998877665544', 'hex');
const poolId = bech32.encode('pool', bech32.toWords(poolKeyHash));
const calidusId = bech32.encode('calidus', bech32.toWords(calidusKeyHash));

describe('F-001 — calidus is a signing witness, not a voter identity', () => {
    describe('credential maps exclude calidus', () => {
        it('CREDENTIAL_PREFIX has no calidus entry', () => {
            expect(CREDENTIAL_PREFIX.calidus).toBeUndefined();
        });

        it('HRP_TO_ROLE has no calidus entry', () => {
            expect(HRP_TO_ROLE.calidus).toBeUndefined();
        });

        it('pool stays the canonical SPO identity (0x06)', () => {
            expect(CREDENTIAL_PREFIX.pool).toBe(0x06);
            expect(HRP_TO_ROLE.pool).toBe('pool');
        });
    });

    describe('voterIdToTokenName', () => {
        it('rejects a standalone calidus voterId with a design-aligned error', () => {
            expect(() => voterIdToTokenName(calidusId)).toThrow(/signing witnesses, not voter identities/);
        });

        it('mints the pool token from the pool ID (the one canonical SPO identity)', () => {
            const expected = '06' + Buffer.from(blake2b(poolKeyHash, undefined, 28)).toString('hex');
            expect(voterIdToTokenName(poolId)).toBe(expected);
        });
    });

    describe('double-vote vector is closed', () => {
        it('an SPO cannot obtain a second token via their calidus key', () => {
            // The pool vote yields exactly one token...
            const poolToken = voterIdToTokenName(poolId);
            expect(poolToken.startsWith('06')).toBe(true);
            // ...and the calidus key cannot be turned into a competing token.
            expect(() => voterIdToTokenName(calidusId)).toThrow();
        });
    });
});
