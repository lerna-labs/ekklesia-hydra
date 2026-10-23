import { Router } from 'express';
import { getBuildInfo } from '../build-info.js';
import { publicProbeLimiter } from '../rate-limit.js';

/**
 * Routes served without `x-api-key`, mounted ahead of the key check.
 * Case-sensitive and strict, so a request reaches a handler here only on the
 * exact path listed; every other path falls through to the key check.
 */
const router = Router({ caseSensitive: true, strict: true });

router.get('/version', publicProbeLimiter, (_req, res) => {
    const { version, gitSha, buildTime } = getBuildInfo();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ name: 'ekklesia-hydra', version, gitSha, buildTime });
});

export default router;
