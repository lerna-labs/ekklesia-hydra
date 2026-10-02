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
