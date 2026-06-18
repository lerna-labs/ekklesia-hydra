/**
 * Coverage for: POST /start never re-seeds an already-OPEN head.
 *
 * /start used to have an "already open → seed the cache" path. That silent
 * re-seed let a second /start (omitting ballotId) overwrite the cached custom
 * ballotId with the fingerprint default — and persist the wrong value to disk —
 * so settlement wrote a (601) datum whose ballotId did not match what every
 * voter signed (the ballotid-clobbered-on-reseed bug; it corrupted the Budget
 * 2026 settlement). /start now opens a NEW voting period only and rejects an
 * already-OPEN head with 409; restart recovery is handled by disk rehydration,
 * and reading state is GET /head-info / GET /ballot.
 *
 * Structural guards over lifecycle.ts (the existing pattern), since exercising
 * the live route needs the full Hydra/Express stack (covered by e2e).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../src/routes/lifecycle.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const startHandler = src.slice(src.indexOf("router.post('/start'"));

describe('POST /start rejects re-seeding an already-OPEN head', () => {
    it('returns 409 CONFLICT when the head is already OPEN', () => {
        expect(startHandler).toMatch(/hydraMonitor\.headStatus === 'OPEN'/);
        // A CONFLICT/409 return guarded by that check.
        expect(startHandler).toMatch(/return error\([\s\S]*?'CONFLICT'[\s\S]*?409/);
    });

    it('rejects the open head BEFORE opening or fetching anything', () => {
        const rejectIdx = startHandler.indexOf("headStatus === 'OPEN'");
        const openIdx = startHandler.indexOf('waitForHeadOpen');
        const fetchIdx = startHandler.indexOf('fetchJson');
        expect(rejectIdx).toBeGreaterThan(-1);
        expect(rejectIdx).toBeLessThan(openIdx);
        expect(rejectIdx).toBeLessThan(fetchIdx);
    });

    it('no longer has a re-seed / already-open caching branch', () => {
        // The old path logged this and ran identity caching in an else branch.
        expect(startHandler).not.toMatch(/seeding identity\/ballot cache/);
        // cachedBallotId must not be reassigned outside the fresh-open path.
        const idAssignments = startHandler.match(/cachedBallotId = ballotId \?\?/g) ?? [];
        expect(idAssignments.length).toBe(1);
    });
});
