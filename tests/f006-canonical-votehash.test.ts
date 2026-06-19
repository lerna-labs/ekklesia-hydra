/**
 * Regression coverage for audit finding F-006: voteHash JSON encoding.
 *
 * hydra used to hash the on-chain voteHash over `JSON.stringify(evidence)`
 * (JS-engine key insertion order), while the backend hashed over
 * `canonicalBytes(evidence)` (sorted-key, RFC-8785). For any evidence object
 * whose key order is not alphabetical the two produced different voteHash
 * values, breaking byte-exact replay and hydra↔backend agreement.
 *
 * Fix: hydra computes voteHash over `canonicalBytes(evidence)` — the same shared
 * helper the backend uses (ekklesia-helpers/json), so the same logical bundle
 * always yields the same hash regardless of key order.
 *
 * (The merkleRoot was later ALSO moved to canonical bytes for cross-interface
 * reproducibility — see canonical-signing-payload.test.ts. The guard below now
 * pins that voteHash uses canonical bytes; the merkleRoot contract is covered in
 * that dedicated test.)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import { canonicalBytes } from '@lerna-labs/ekklesia-helpers/json';

const here = dirname(fileURLToPath(import.meta.url));
const voteHash = (ev: unknown) => bytesToHex(blake2b256(canonicalBytes(ev)));

describe('F-006 — canonical voteHash', () => {
    describe('canonical hashing is key-order independent', () => {
        // Two evidence bundles, logically identical, built with different key
        // insertion order (top-level and nested).
        const evA = {
            specVersion: 'ekklesia/2.0',
            surveyTxId: 'ballot_tx',
            responderRole: 'drep',
            answers: [{ questionId: 'q1', selection: [1] }],
            ekklesia: { voterId: 'drep1abc', credentialHrp: 'drep', nonce: 1 },
        };
        const evB = {
            ekklesia: { nonce: 1, credentialHrp: 'drep', voterId: 'drep1abc' },
            answers: [{ selection: [1], questionId: 'q1' }],
            responderRole: 'drep',
            surveyTxId: 'ballot_tx',
            specVersion: 'ekklesia/2.0',
        };

        it('the two orderings differ under JSON.stringify (the old bug surface)', () => {
            expect(JSON.stringify(evA)).not.toBe(JSON.stringify(evB));
        });

        it('but hash to the SAME voteHash under canonical JSON', () => {
            expect(voteHash(evA)).toBe(voteHash(evB));
        });

        it('produces a 64-char (32-byte) hex digest', () => {
            expect(voteHash(evA)).toMatch(/^[0-9a-f]{64}$/);
        });
    });

    describe('structural guard — voteHash producer + verifier use canonical bytes', () => {
        const voting = readFileSync(resolve(here, '../src/routes/voting.ts'), 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        const settlement = readFileSync(resolve(here, '../src/routes/settlement.ts'), 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

        it('voting.ts computes voteHash over canonicalBytes(evidence)', () => {
            expect(voting).toMatch(/voteHash = bytesToHex\(blake2b256\(canonicalBytes\(evidence\)\)\)/);
        });

        it('settlement.ts verifier re-hashes evidence with canonicalBytes (matches producer)', () => {
            expect(settlement).toMatch(/blake2b256\(canonicalBytes\(evidence\)\)/);
            expect(settlement).not.toMatch(/blake2b256\(JSON\.stringify\(evidence\)\)/);
        });
    });
});
