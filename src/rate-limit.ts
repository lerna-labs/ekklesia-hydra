import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { error } from './helpers.js';

function rateLimitExceeded(_req: Request, res: Response) {
    return error(res, 'RATE_LIMITED', 'Too many requests, please try again later.', 429);
}

export const adminActionLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceeded,
});

export const readActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceeded,
});

// Keyless routes mounted ahead of the x-api-key check. A bucket of its own, so
// anonymous traffic never draws on the one keyed evidence reads use.
export const publicProbeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitExceeded,
});
