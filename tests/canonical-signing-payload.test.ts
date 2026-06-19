/**
 * Coverage for the canonical signing payload (reproducible merkleRoot).
 *
 * `merkleRoot` — the value voters sign — is now hashed over the canonical
 * (RFC-8785) JSON of `{ ballotId, nonce, votes }` (shared
 * `@lerna-labs/ekklesia-helpers/json`), matching the backend broker. So any
 * interface that builds the same logical vote produces the same merkleRoot
 * regardless of key insertion order, and hydra re-derives the value a
 * third-party client signed no matter what order it submits the votes in.
 *
 * See TRD HYDRA_CANONICAL_SIGNING_PAYLOAD. This deliberately supersedes F-006's
 * "do not canonicalize merkleRoot" guidance (which held only while every producer
 * computed it identically) — flagged for auditor sync.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
import { canonicalBytes } from '@lerna-labs/ekklesia-helpers/json';

const here = dirname(fileURLToPath(import.meta.url));
const merkleRoot = (p: unknown) => bytesToHex(blake2b256(canonicalBytes(p)));
const legacyRoot = (p: unknown) => bytesToHex(blake2b256(Buffer.from(JSON.stringify(p), 'utf8')));

describe('canonical signing payload — reproducible merkleRoot', () => {
    it('is independent of key insertion order (abstain vote — the divergence case)', () => {
        // Same logical abstain vote, built two ways.
        const a = { ballotId: 'b1', nonce: 2, votes: [{ questionId: 'q1', abstain: true }] };
        const b = { votes: [{ abstain: true, questionId: 'q1' }], nonce: 2, ballotId: 'b1' };
        expect(JSON.stringify(a)).not.toBe(JSON.stringify(b)); // old contract diverged
        expect(merkleRoot(a)).toBe(merkleRoot(b));             // canonical agrees
    });

    it('is backwards-safe for alphabetical votes (canonical == old JSON.stringify)', () => {
        // {questionId, selection} and {ballotId, nonce, votes} are already sorted,
        // so existing signatures (signed against JSON.stringify) still verify.
        const p = { ballotId: 'b1', nonce: 1, votes: [{ questionId: 'q1', selection: [1] }] };
        expect(merkleRoot(p)).toBe(legacyRoot(p));
    });

    it('preserves selection array order (not sorted)', () => {
        const a = { ballotId: 'b', nonce: 1, votes: [{ questionId: 'q', selection: [3, 1, 2] }] };
        const b = { ballotId: 'b', nonce: 1, votes: [{ questionId: 'q', selection: [1, 2, 3] }] };
        expect(merkleRoot(a)).not.toBe(merkleRoot(b));
    });

    it('differs when the logical vote differs (sanity)', () => {
        const a = { ballotId: 'b', nonce: 1, votes: [{ questionId: 'q', selection: [1] }] };
        const b = { ballotId: 'b', nonce: 2, votes: [{ questionId: 'q', selection: [1] }] };
        expect(merkleRoot(a)).not.toBe(merkleRoot(b));
    });

    it('structural guard — voting.ts hashes merkleRoot over canonicalBytes(signedPayload)', () => {
        const voting = readFileSync(resolve(here, '../src/routes/voting.ts'), 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(voting).toMatch(/merkleRoot = bytesToHex\(blake2b256\(canonicalBytes\(signedPayload\)\)\)/);
        expect(voting).not.toMatch(/blake2b256\(JSON\.stringify\(signedPayload\)\)/);
    });
});
