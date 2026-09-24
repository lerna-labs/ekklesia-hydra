/**
 * Coverage for the rate limiters guarding the expensive admin/settlement
 * route handlers (js/missing-rate-limiting, code-scanning alerts 6, 7, 9,
 * 10, 11, 12, 13, 17): each flagged route must reach a rate-limiting
 * middleware before its handler runs, and that middleware must actually
 * reject once the configured limit is exceeded.
 *
 * `src/rate-limit.ts` reads its window/max from env at import time, so the
 * "exceeds the limit" and "env overrides the default" cases reset the
 * module registry and re-import after setting env, to get an isolated,
 * tightly-bounded limiter instead of the production defaults.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const here = dirname(fileURLToPath(import.meta.url));

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>) {
    const server = app.listen(0);
    await new Promise<void>((res) => server.once('listening', () => res()));
    const port = (server.address() as AddressInfo).port;
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>((res) => server.close(() => res()));
    }
}

describe('rate-limit module defaults', () => {
    it('exposes positive, sensible-magnitude defaults with no env overrides set', async () => {
        vi.resetModules();
        for (const k of ['ADMIN_RATE_LIMIT_WINDOW_MS', 'ADMIN_RATE_LIMIT_MAX', 'READ_RATE_LIMIT_WINDOW_MS', 'READ_RATE_LIMIT_MAX']) {
            delete process.env[k];
        }
        const mod = await import('../src/rate-limit.js');
        expect(mod.ADMIN_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
        expect(mod.ADMIN_RATE_LIMIT_MAX).toBeGreaterThan(0);
        expect(mod.READ_RATE_LIMIT_WINDOW_MS).toBeGreaterThan(0);
        expect(mod.READ_RATE_LIMIT_MAX).toBeGreaterThan(0);
        // The read tier is for polling read-only endpoints and should never
        // be stricter than the tier guarding one-shot admin writes.
        expect(mod.READ_RATE_LIMIT_MAX).toBeGreaterThanOrEqual(mod.ADMIN_RATE_LIMIT_MAX);
    });
});

describe('rate limiters reject once the configured limit is exceeded', () => {
    it('adminActionLimiter and readActionLimiter both 429 past their env-configured max, and pass requests under it', async () => {
        vi.resetModules();
        process.env.ADMIN_RATE_LIMIT_WINDOW_MS = '60000';
        process.env.ADMIN_RATE_LIMIT_MAX = '2';
        process.env.READ_RATE_LIMIT_WINDOW_MS = '60000';
        process.env.READ_RATE_LIMIT_MAX = '3';

        const { adminActionLimiter, readActionLimiter } = await import('../src/rate-limit.js');

        const app = express();
        app.get('/admin-probe', adminActionLimiter, (_req, res) => res.status(200).json({ ok: true }));
        app.get('/read-probe', readActionLimiter, (_req, res) => res.status(200).json({ ok: true }));

        await withServer(app, async (baseUrl) => {
            // admin tier: max 2 — first 2 succeed, 3rd is rate-limited
            const admin1 = await fetch(`${baseUrl}/admin-probe`);
            const admin2 = await fetch(`${baseUrl}/admin-probe`);
            const admin3 = await fetch(`${baseUrl}/admin-probe`);
            expect(admin1.status).toBe(200);
            expect(admin2.status).toBe(200);
            expect(admin3.status).toBe(429);
            const admin3Body = await admin3.json();
            expect(admin3Body).toEqual({
                status: 'ERROR',
                code: 'RATE_LIMITED',
                message: expect.any(String),
            });

            // read tier: independently configured max 3 — first 3 succeed, 4th is rate-limited
            const read1 = await fetch(`${baseUrl}/read-probe`);
            const read2 = await fetch(`${baseUrl}/read-probe`);
            const read3 = await fetch(`${baseUrl}/read-probe`);
            const read4 = await fetch(`${baseUrl}/read-probe`);
            expect(read1.status).toBe(200);
            expect(read2.status).toBe(200);
            expect(read3.status).toBe(200);
            expect(read4.status).toBe(429);
        });

        delete process.env.ADMIN_RATE_LIMIT_WINDOW_MS;
        delete process.env.ADMIN_RATE_LIMIT_MAX;
        delete process.env.READ_RATE_LIMIT_WINDOW_MS;
        delete process.env.READ_RATE_LIMIT_MAX;
    });
});

describe('every js/missing-rate-limiting route is wired to a limiter', () => {
    /**
     * Structural guard, in the style of the responderRole regression test:
     * confirms the limiter middleware is passed as the argument immediately
     * after the path on each flagged route registration, so a future edit
     * that drops it (e.g. while refactoring a handler) fails this test
     * instead of silently reopening the alert.
     */
    function routerSource(relativePath: string): string {
        return readFileSync(resolve(here, relativePath), 'utf-8');
    }

    it('lifecycle.ts POST /start uses adminActionLimiter (alert 17)', () => {
        expect(routerSource('../src/routes/lifecycle.ts')).toMatch(
            /router\.post\(\s*'\/start',\s*adminActionLimiter,/,
        );
    });

    it('query.ts POST /flush-cache uses adminActionLimiter (alert 7)', () => {
        expect(routerSource('../src/routes/query.ts')).toMatch(
            /router\.post\(\s*'\/flush-cache',\s*adminActionLimiter,/,
        );
    });

    it('audit.ts GET /audit/full uses readActionLimiter (alert 6)', () => {
        expect(routerSource('../src/routes/audit.ts')).toMatch(
            /router\.get\(\s*'\/audit\/full',\s*readActionLimiter,/,
        );
    });

    it('settlement.ts write endpoints use adminActionLimiter (alerts 9, 10, 11, 13)', () => {
        const src = routerSource('../src/routes/settlement.ts');
        expect(src).toMatch(/router\.post\(\s*'\/finalize',\s*adminActionLimiter,/);
        expect(src).toMatch(/router\.post\(\s*'\/settle\/burn',\s*adminActionLimiter,/);
        expect(src).toMatch(/router\.post\(\s*'\/settle\/finalize',\s*adminActionLimiter,/);
        expect(src).toMatch(/router\.post\(\s*'\/settle',\s*adminActionLimiter,/);
    });

    it('settlement.ts GET /results uses readActionLimiter (alert 12)', () => {
        expect(routerSource('../src/routes/settlement.ts')).toMatch(
            /router\.get\(\s*'\/results',\s*readActionLimiter,/,
        );
    });
});
