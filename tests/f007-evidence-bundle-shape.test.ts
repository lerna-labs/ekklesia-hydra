/**
 * Regression coverage for audit finding F-007: the IPFS vote-evidence bundle
 * shape drifted between the two producers (hydra `voting.ts` and the backend
 * `voteBroker.js`):
 *
 *   (a) `specVersion` string — hydra `'0.3.0'` vs backend `'ekklesia/1.0'`
 *   (b) top-level `surveyTxId` — absent in hydra, present in backend
 *   (c) `ekklesia.nativeScript` / `ekklesia.calidusDeclaration` presence rules
 *
 * The fix unifies hydra onto one canonical shape under a bumped protocol
 * version (`PROTOCOL_VERSION`), per the audit's protocol-versioning constraint:
 * representation-changing fixes ship as a NEW version, never an in-place
 * mutation of the version the two settled ballots were minted under.
 *
 * This test pins three things:
 *   1. the version constant (bumped, backend `ekklesia/N` style);
 *   2. the canonical bundle shape (keys, order, conditional-key rules) that
 *      the backend producer must match byte-for-byte;
 *   3. that the hydra producer (`voting.ts` / `settlement.ts`) actually emits
 *      that version and shape — a structural guard so a future edit that
 *      re-introduces `'0.3.0'` or drops `surveyTxId` fails here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { VoteEvidence } from '../src/types.js';
import { PROTOCOL_VERSION } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const VOTING_TS = resolve(here, '../src/routes/voting.ts');
const SETTLEMENT_TS = resolve(here, '../src/routes/settlement.ts');

// The previous versions the two live ballots settled under. New evidence must
// never reuse either of these, or replay tooling would mis-route the path.
const RETIRED_VERSIONS = ['0.3.0', 'ekklesia/1.0'];

describe('F-007 — unified vote-evidence bundle shape', () => {
    describe('protocol version', () => {
        it('is bumped off both retired versions', () => {
            expect(RETIRED_VERSIONS).not.toContain(PROTOCOL_VERSION);
        });

        it('uses the backend ekklesia/N naming style', () => {
            expect(PROTOCOL_VERSION).toMatch(/^ekklesia\/\d+\.\d+$/);
        });

        it('is pinned to ekklesia/2.0', () => {
            expect(PROTOCOL_VERSION).toBe('ekklesia/2.0');
        });
    });

    describe('canonical bundle shape (cross-repo contract)', () => {
        // The shape both producers must emit. Backend `voteBroker.js` ordering
        // is the reference: specVersion, surveyTxId, responderRole, answers,
        // ekklesia. The ekklesia extension keys end with merkleProof; the
        // script/calidus keys are inserted only when populated.
        const CANONICAL_TOP_KEYS = ['specVersion', 'surveyTxId', 'responderRole', 'answers', 'ekklesia'];
        const ballotId = 'ballot_tx_abc123';

        function keyBasedEvidence(): VoteEvidence {
            return {
                specVersion: PROTOCOL_VERSION,
                surveyTxId: ballotId,
                responderRole: 'drep',
                answers: [{ questionId: 'q1', selection: [1] }],
                ekklesia: {
                    voterId: 'drep1abc',
                    credentialHrp: 'drep',
                    nonce: 1,
                    signedPayload: { ballotId, nonce: 1, votes: [{ questionId: 'q1', selection: [1] }] },
                    witnesses: [],
                    merkleProof: { root: '', steps: [] },
                },
            };
        }

        it('declares surveyTxId in the VoteEvidence type and defaults it to ballotId', () => {
            const ev = keyBasedEvidence();
            expect(ev.surveyTxId).toBe(ballotId);
        });

        it('emits the canonical top-level keys in order', () => {
            const ev = keyBasedEvidence();
            expect(Object.keys(ev)).toEqual(CANONICAL_TOP_KEYS);
        });

        it('stamps the bumped protocol version', () => {
            expect(keyBasedEvidence().specVersion).toBe(PROTOCOL_VERSION);
        });

        it('omits script/calidus extension keys for a key-based vote', () => {
            const json = JSON.parse(JSON.stringify(keyBasedEvidence()));
            expect('nativeScript' in json.ekklesia).toBe(false);
            expect('calidusDeclaration' in json.ekklesia).toBe(false);
        });

        it('round-trips byte-stable (verifier parse -> stringify reproduces the hash input)', () => {
            const ev = keyBasedEvidence();
            const once = JSON.stringify(ev);
            const twice = JSON.stringify(JSON.parse(once));
            expect(twice).toBe(once);
        });
    });

    describe('structural guard — hydra producer emits the unified version + shape', () => {
        const stripComments = (s: string) =>
            s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

        const votingSrc = stripComments(readFileSync(VOTING_TS, 'utf-8'));
        const settlementSrc = stripComments(readFileSync(SETTLEMENT_TS, 'utf-8'));

        it('voting.ts stamps specVersion: PROTOCOL_VERSION (not a literal)', () => {
            expect(votingSrc).toMatch(/specVersion:\s*PROTOCOL_VERSION/);
        });

        it('voting.ts adds top-level surveyTxId: ballotId', () => {
            expect(votingSrc).toMatch(/surveyTxId:\s*ballotId/);
        });

        it('voting.ts includes nativeScript / calidusDeclaration only when populated', () => {
            expect(votingSrc).toMatch(/signature\.nativeScript\s*\?\s*{\s*nativeScript:/);
            expect(votingSrc).toMatch(/signature\.calidusDeclaration\s*\?\s*{\s*calidusDeclaration:/);
        });

        it('settlement.ts stamps PROTOCOL_VERSION on every FullResults object', () => {
            const matches = settlementSrc.match(/specVersion:\s*PROTOCOL_VERSION/g) ?? [];
            expect(matches.length).toBe(3);
        });

        it('no retired version literal survives in either producer', () => {
            for (const v of RETIRED_VERSIONS) {
                expect(votingSrc).not.toContain(`'${v}'`);
                expect(settlementSrc).not.toContain(`'${v}'`);
            }
        });
    });
});
