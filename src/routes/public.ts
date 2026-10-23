import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getBuildInfo } from '../build-info.js';
import { createPublicProbeLimiter } from '../rate-limit.js';

// Express answers OPTIONS itself when a router matches a path that has no
// OPTIONS handler, which would happen here, ahead of the key check. Every
// method a public path does not serve leaves this router for the key check.
const toKeyCheck: RequestHandler = (_req, _res, next) => next('router');

/**
 * Routes served without `x-api-key`, mounted ahead of the key check.
 * Case-sensitive and strict, so a request reaches a handler here only on the
 * exact path and method listed; everything else falls through to the key check.
 */
export function createPublicRouter(): Router {
    const router = Router({ caseSensitive: true, strict: true });
    const limiter = createPublicProbeLimiter();

    router.route('/version')
        .get(limiter, (_req, res) => {
            const { version, gitSha, buildTime } = getBuildInfo();
            res.set('Cache-Control', 'public, max-age=60');
            res.json({ name: 'ekklesia-hydra', version, gitSha, buildTime });
        })
        .all(toKeyCheck);

    return router;
}
