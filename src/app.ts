import express from 'express';
import type { Express } from 'express';
import { authHeaderMiddleware } from './middleware.js';

import publicRoutes from './routes/public.js';
import auditRoutes from './routes/audit.js';
import ballotRoutes from './routes/ballot.js';
import lifecycleRoutes from './routes/lifecycle.js';
import votingRoutes from './routes/voting.js';
import settlementRoutes from './routes/settlement.js';
import queryRoutes from './routes/query.js';

/**
 * Build the Express app. No side effects: start-up work (cache rehydration,
 * monitor connection, queue worker, signal handlers, listen) stays in index.ts.
 */
export function createApp(): Express {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // Keyless routes must be mounted before the key check.
    app.use(publicRoutes);
    app.use(authHeaderMiddleware);

    // Mount route modules
    app.use(auditRoutes);
    app.use(ballotRoutes);
    app.use(queryRoutes);
    app.use(lifecycleRoutes);
    app.use(votingRoutes);
    app.use(settlementRoutes);

    // Error handler MUST be after routes to catch their errors
    app.use((err: any, _req: any, res: any, _next: any) => {
        console.error('Unhandled express error:', err);
        if (!res.headersSent) {
            res.status(500).json({ status: 'ERROR', code: 'INTERNAL_ERROR', message: 'Internal server error' });
        }
    });

    return app;
}
