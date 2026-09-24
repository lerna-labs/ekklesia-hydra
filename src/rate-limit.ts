/**
 * Rate limiters for expensive route handlers (chain writes, file system and
 * IPFS I/O). Every route here already sits behind `authHeaderMiddleware`
 * (x-api-key), so the limiters are a second layer: they cap how fast even an
 * authenticated caller can trigger the heaviest operations, so a stuck retry
 * loop or a leaked key can't turn into a denial-of-service against the
 * middleware, the Hydra node, or IPFS.
 *
 * Two tiers, both configurable via env with safe defaults:
 *   - `adminActionLimiter` — one-shot admin/settlement writes (`/start`,
 *     `/finalize`, `/settle*`, `/flush-cache`). These are called a handful of
 *     times per ballot lifecycle, including operator retries, so the default
 *     leaves headroom for that while still blocking a flood.
 *   - `readActionLimiter` — read-only endpoints that still walk the file
 *     system (`/results`, `/audit/full`). Looser, since these are safe to
 *     poll more often.
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { error } from './helpers.js';

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const ADMIN_RATE_LIMIT_WINDOW_MS = envInt('ADMIN_RATE_LIMIT_WINDOW_MS', 5 * 60 * 1000);
export const ADMIN_RATE_LIMIT_MAX = envInt('ADMIN_RATE_LIMIT_MAX', 20);

export const READ_RATE_LIMIT_WINDOW_MS = envInt('READ_RATE_LIMIT_WINDOW_MS', 60 * 1000);
export const READ_RATE_LIMIT_MAX = envInt('READ_RATE_LIMIT_MAX', 60);

function rateLimitExceeded(_req: Request, res: Response) {
    return error(res, 'RATE_LIMITED', 'Too many requests, please try again later.', 429);
}

/** Guards expensive one-shot admin/settlement write endpoints. */
export const adminActionLimiter = rateLimit({
    windowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
    limit: ADMIN_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceeded,
});

/** Guards read-only endpoints backed by file system access. */
export const readActionLimiter = rateLimit({
    windowMs: READ_RATE_LIMIT_WINDOW_MS,
    limit: READ_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceeded,
});
