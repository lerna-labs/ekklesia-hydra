/**
 * Regression coverage for audit findings F-010 / F-011: role resolution from a
 * bech32 HRP.
 *
 * F-010 — the old code coerced an unknown/missing HRP to a fallback role instead
 * of failing closed: `HRP_TO_ROLE[hrp] ?? 'drep'` in the evidence producer, and
 * `evidence.ekklesia?.credentialHrp ?? 'drep'` then `?? evidence.responderRole ??
 * 'Unknown'` in the tally. A missing HRP was silently counted as a real `drep`
 * voter, and an unknown HRP trusted the evidence-supplied role. `resolveRole`
 * returns null for anything unrecognized so every caller fails closed.
 *
 * F-011 — the report asked for `drep_test` / `calidus_test` entries by analogy
 * with `stake_test`. Those HRPs do not exist: CIP-129 governance credentials use
 * the `drep` HRP on every network; only CIP-19 stake reward addresses are
 * network-tagged (`stake` / `stake_test`, both already handled). So the asymmetry
 * is correct — and `resolveRole` fails closed on `drep_test` regardless.
 */

import { describe, it, expect } from 'vitest';
import { resolveRole, HRP_TO_ROLE } from '../src/types.js';

describe('F-010 / F-011 — fail-closed role resolution', () => {
    describe('recognized HRPs resolve to canonical roles', () => {
        it('drep → drep', () => expect(resolveRole('drep')).toBe('drep'));
        it('pool → pool', () => expect(resolveRole('pool')).toBe('pool'));
        it('stake → stake', () => expect(resolveRole('stake')).toBe('stake'));
        it('stake_test → stake (testnet reward address)', () => expect(resolveRole('stake_test')).toBe('stake'));
    });

    describe('unrecognized / missing HRPs fail closed (null, never a default role)', () => {
        it('unknown HRP → null (not coerced to drep)', () => {
            expect(resolveRole('addr')).toBeNull();
            expect(resolveRole('cc_hot')).toBeNull();
            expect(resolveRole('garbage')).toBeNull();
        });

        it('missing HRP → null (the old code silently counted this as drep)', () => {
            expect(resolveRole(undefined)).toBeNull();
            expect(resolveRole(null)).toBeNull();
            expect(resolveRole('')).toBeNull();
        });

        it('calidus → null (witness-only since F-001, never a voter role)', () => {
            expect(resolveRole('calidus')).toBeNull();
        });

        it('drep_test / calidus_test → null (no such CIP-129 HRP; F-011)', () => {
            expect(resolveRole('drep_test')).toBeNull();
            expect(resolveRole('calidus_test')).toBeNull();
        });
    });

    describe('role range is exactly the canonical three groups', () => {
        it('HRP_TO_ROLE only maps to drep / pool / stake', () => {
            for (const role of Object.values(HRP_TO_ROLE)) {
                expect(['drep', 'pool', 'stake']).toContain(role);
            }
        });
    });
});
