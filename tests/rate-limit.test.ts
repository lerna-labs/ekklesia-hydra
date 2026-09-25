/**
 * Coverage for the rate limiters guarding the expensive admin/settlement
 * route handlers (js/missing-rate-limiting, code-scanning alerts 6, 7, 9,
 * 10, 11, 12, 13, 17): the limiter middleware must actually reject once the
 * configured limit is exceeded.
 */

import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { adminActionLimiter } from '../src/rate-limit.js';

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

describe('adminActionLimiter', () => {
    it('returns 429 once the request count exceeds the configured max', async () => {
        const app = express();
        app.get('/admin-probe', adminActionLimiter, (_req, res) => res.status(200).json({ ok: true }));

        await withServer(app, async (baseUrl) => {
            let last: Response | undefined;
            for (let i = 0; i < 21; i++) {
                last = await fetch(`${baseUrl}/admin-probe`);
            }
            expect(last!.status).toBe(429);
            expect(await last!.json()).toEqual({
                status: 'ERROR',
                code: 'RATE_LIMITED',
                message: expect.any(String),
            });
        });
    });
});
