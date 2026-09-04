/**
 * Regression coverage for js/path-injection alerts #14, #15, #16.
 *
 * `appendVoteHistory`/`getVoteHistory` (src/helpers.ts) built a filename
 * directly from `voterId` — sourced from `req.body.voterId` (POST /vote) and
 * `req.params.voterId` (GET /audit/vote/:voterId) — with no check on its
 * shape. `bech32.decode`, used elsewhere in this file to derive a voter
 * token name, is not by itself a sufficient guard: its charset check on the
 * HRP accepts any printable ASCII character in the 33-126 range (including
 * "." and "/"), and its checksum covers whatever prefix is supplied rather
 * than restricting which prefixes are legal, so a string with a hostile HRP
 * and a correctly computed checksum still decodes cleanly. The first test
 * below demonstrates that gap directly against the `bech32` package.
 *
 * `isValidVoterId` closes it by anchoring the HRP to the fixed role set this
 * system issues and the data part to bech32's own alphabet, and
 * `appendVoteHistory`/`getVoteHistory` reject before ever building a path
 * from a value that fails the check.
 */

import { promises as fsp } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { bech32 } from 'bech32';

describe('bech32.decode alone does not restrict the HRP', () => {
    it('accepts a hostile prefix carrying a correctly computed checksum', () => {
        const words = bech32.toWords(Buffer.from('deadbeef', 'hex'));
        const encoded = bech32.encode('../../../etc/passwd', words, 200);
        const decoded = bech32.decode(encoded, 200);
        expect(decoded.prefix).toBe('../../../etc/passwd');
    });
});

describe('js/path-injection #14, #15, #16 — voter history file naming', () => {
    let stagingDir: string;
    let isValidVoterId: (voterId: unknown) => voterId is string;
    let appendVoteHistory: (voterId: string, entry: any) => Promise<void>;
    let getVoteHistory: (voterId: string) => Promise<any[]>;

    // IPFS_STAGING_DIR is read once at module load, so point it at a scratch
    // directory before importing helpers.ts.
    beforeAll(async () => {
        stagingDir = await mkdtemp(join(tmpdir(), 'hydra-voter-history-'));
        process.env.IPFS_STAGING_DIR = stagingDir;
        const helpers = await import('../src/helpers.js');
        isValidVoterId = helpers.isValidVoterId;
        appendVoteHistory = helpers.appendVoteHistory;
        getVoteHistory = helpers.getVoteHistory;
    });

    afterAll(async () => {
        await rm(stagingDir, { recursive: true, force: true });
    });

    // A genuine 29-byte drep credential (1-byte kind + 28-byte hash), bech32
    // encoded — the shape a real registered voterId has.
    const wellFormedDrep = (() => {
        const bytes = Buffer.alloc(29, 0xab);
        bytes[0] = 0x22;
        return bech32.encode('drep', bech32.toWords(bytes), 200);
    })();

    const maliciousVoterIds = {
        'directory traversal (no bech32 shape at all)': '../../../etc/passwd',
        'directory traversal with a bech32-shaped prefix': `drep1${'../../../etc/passwd'}`,
        'absolute path': '/etc/passwd',
        'null byte': 'drep1' + String.fromCharCode(0) + 'malicious',
        'hostile HRP with a valid bech32 checksum': (() => {
            const words = bech32.toWords(Buffer.from('deadbeef', 'hex'));
            return bech32.encode('../../../etc/passwd', words, 200);
        })(),
        'unrecognized HRP': (() => {
            const words = bech32.toWords(Buffer.from('deadbeef', 'hex'));
            return bech32.encode('addr', words, 200);
        })(),
    };

    describe('isValidVoterId', () => {
        it('accepts a well-formed, known-role bech32 voter ID', () => {
            expect(isValidVoterId(wellFormedDrep)).toBe(true);
        });

        for (const [label, value] of Object.entries(maliciousVoterIds)) {
            it(`rejects ${label}`, () => {
                expect(isValidVoterId(value)).toBe(false);
            });
        }

        it('rejects non-string input', () => {
            expect(isValidVoterId(undefined)).toBe(false);
            expect(isValidVoterId(null)).toBe(false);
            expect(isValidVoterId(42)).toBe(false);
        });
    });

    describe('appendVoteHistory', () => {
        it('writes a history file for a well-formed voter ID, scoped to the history directory', async () => {
            await appendVoteHistory(wellFormedDrep, {
                version: 1,
                voteHash: 'a'.repeat(64),
                ipfsCid: 'Qm...',
                txHash: 'deadbeef',
                timestamp: Date.now(),
            });

            const written = await fsp.readFile(join(stagingDir, 'history', `${wellFormedDrep}.json`), 'utf-8');
            expect(JSON.parse(written)).toHaveLength(1);
        });

        for (const [label, value] of Object.entries(maliciousVoterIds)) {
            it(`rejects ${label} instead of writing anywhere`, async () => {
                await expect(
                    appendVoteHistory(value, {
                        version: 1,
                        voteHash: 'a'.repeat(64),
                        ipfsCid: 'Qm...',
                        txHash: 'deadbeef',
                        timestamp: Date.now(),
                    }),
                ).rejects.toThrow(/Invalid voter ID/);
            });
        }

        it('only ever wrote the one well-formed history file, nothing from a rejected voter ID', async () => {
            const entries = await fsp.readdir(join(stagingDir, 'history'));
            expect(entries).toEqual([`${wellFormedDrep}.json`]);
        });
    });

    describe('getVoteHistory', () => {
        it('reads back the history written for a well-formed voter ID', async () => {
            const history = await getVoteHistory(wellFormedDrep);
            expect(history).toHaveLength(1);
        });

        for (const [label, value] of Object.entries(maliciousVoterIds)) {
            it(`returns an empty history for ${label} instead of reading anywhere`, async () => {
                await expect(getVoteHistory(value)).resolves.toEqual([]);
            });
        }

        it('returns an empty history for an unregistered but well-formed voter ID', async () => {
            const bytes = Buffer.alloc(29, 0xcd);
            bytes[0] = 0x22;
            const unregistered = bech32.encode('drep', bech32.toWords(bytes), 200);
            await expect(getVoteHistory(unregistered)).resolves.toEqual([]);
        });
    });
});
