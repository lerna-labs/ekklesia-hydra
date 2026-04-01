import './load.js';

import express from 'express';
import { authHeaderMiddleware } from './middleware.js';
import { HYDRA_NETWORK, voteCache } from './helpers.js';

import auditRoutes from './routes/audit.js';
import ballotRoutes from './routes/ballot.js';
import lifecycleRoutes from './routes/lifecycle.js';
import votingRoutes from './routes/voting.js';
import settlementRoutes from './routes/settlement.js';
import queryRoutes from './routes/query.js';

const app = express();
app.use(express.json());
app.use(authHeaderMiddleware);

app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ status: 'ERROR', message: 'Internal server error' });
});

// Mount route modules
app.use(auditRoutes);
app.use(ballotRoutes);
app.use(queryRoutes);
app.use(lifecycleRoutes);
app.use(votingRoutes);
app.use(settlementRoutes);

process.on('SIGTERM', () => {
    console.log('🔻 SIGTERM received, shutting down gracefully');
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('🔻 SIGINT received, shutting down gracefully');
    process.exit(0);
});

const port = 3000;

async function start() {
    // Rehydrate vote cache from disk before accepting requests
    const cacheCount = await voteCache.rehydrate();
    console.log(`✅ Vote cache rehydrated: ${cacheCount} entries loaded from disk`);

    app.listen(port, () => {
        console.log(`✅ Hydra SDK API server is running on http://localhost:${port}`);
        console.log(`✅ Hydra Network: ${HYDRA_NETWORK}`);
    });
}

start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
