/**
 * Regression coverage for issue #1: responderRole accepted from client
 * without validation.
 *
 * The fix is structural: responderRole is no longer accepted on the wire.
 * The route derives it from the bech32 HRP of voterId via HRP_TO_ROLE
 * before the evidence object is built and blake2b_256-hashed.
 *
 * This test guards both halves of that contract:
 *   1. HRP_TO_ROLE returns the canonical lowercase role for every accepted
 *      HRP, including the collapse cases (calidus -> pool, stake_test ->
 *      stake).
 *   2. The /vote handler in src/routes/voting.ts neither destructures
 *      responderRole from req.body nor declares it on the body type. A
 *      future refactor that re-introduces either form will fail this test
 *      and force the author to read the issue before re-opening the hole.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { HRP_TO_ROLE } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const VOTING_TS = resolve(here, '../src/routes/voting.ts');

describe('issue #1 — responderRole is derived, not client-supplied', () => {
    describe('HRP_TO_ROLE canonical mapping', () => {
        it('maps drep -> drep', () => {
            expect(HRP_TO_ROLE.drep).toBe('drep');
        });

        it('maps pool -> pool', () => {
            expect(HRP_TO_ROLE.pool).toBe('pool');
        });

        it('has no calidus entry — calidus is a signing witness, not a voter identity (F-001)', () => {
            // An SPO voting with a calidus hot key submits voterId as the pool
            // (pool1...), so credentialHrp is already `pool`; calidus is never a
            // voter HRP and must not be tokenized independently.
            expect(HRP_TO_ROLE.calidus).toBeUndefined();
        });

        it('maps stake -> stake', () => {
            expect(HRP_TO_ROLE.stake).toBe('stake');
        });

        it('maps stake_test -> stake (testnet collapse)', () => {
            expect(HRP_TO_ROLE.stake_test).toBe('stake');
        });

        it('does not expose payment-address HRPs', () => {
            expect(HRP_TO_ROLE.addr).toBeUndefined();
            expect(HRP_TO_ROLE.addr_test).toBeUndefined();
        });

        it('uses only canonical lowercase role names', () => {
            const roles = new Set(Object.values(HRP_TO_ROLE));
            for (const r of roles) {
                expect(['drep', 'pool', 'stake']).toContain(r);
            }
        });
    });

    describe('structural guard — voting.ts must not accept responderRole on the wire', () => {
        const rawSource = readFileSync(VOTING_TS, 'utf-8');
        // Strip /* ... */ and // ... comments so doc-block mentions of the
        // field don't trip the guard. We only care about real code.
        const source = rawSource
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');

        it('does not destructure responderRole from req.body', () => {
            expect(source).not.toMatch(/{[^}]*\bresponderRole\b[^}]*}\s*=\s*req\.body/);
        });

        it('does not declare responderRole on any body-shape type', () => {
            expect(source).not.toMatch(/\bresponderRole\??\s*:\s*string/);
        });

        it('derives responderRole from credentialHrp via resolveRole', () => {
            // The actual fix. Pinned so a future edit that hard-codes "drep"
            // or accepts a client value will fail this test. resolveRole is the
            // fail-closed resolver introduced for F-010 (returns null on an
            // unrecognized HRP rather than coercing to a default role).
            expect(source).toMatch(/responderRole\s*=\s*resolveRole\(credentialHrp\)/);
        });
    });
});
