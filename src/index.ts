import './load.js';

// Raise Node's global HTTP connection limits for concurrent TRP/IPFS requests.
// Default Undici Agent allows ~10 connections per origin, which causes socket
// errors when 100+ votes hit TRP simultaneously. This must run before any
// fetch() calls.
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({
    connections: 1024,      // max connections per origin (must exceed TRP max_connections)
    pipelining: 1,          // HTTP/1.1 pipelining (1 = disabled, safe default)
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
}));

import express from 'express';
import { authHeaderMiddleware } from './middleware.js';
import { HYDRA_NETWORK, VERBOSE, voteCache, hydraMonitor } from './helpers.js';

import auditRoutes from './routes/audit.js';
import ballotRoutes from './routes/ballot.js';
import lifecycleRoutes from './routes/lifecycle.js';
import votingRoutes from './routes/voting.js';
import settlementRoutes from './routes/settlement.js';
import queryRoutes from './routes/query.js';

const app = express();
app.use(express.json());
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

// Safety net: log uncaught exceptions/rejections without crashing
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION (process kept alive):', reason);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await hydraMonitor.stop();
    process.exit(0);
});
process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    await hydraMonitor.stop();
    process.exit(0);
});

const port = 3000;

async function start() {
    // Rehydrate vote cache from disk before accepting requests
    const cacheCount = await voteCache.rehydrate();
    console.log(`Vote cache rehydrated: ${cacheCount} entries loaded from disk`);

    // Log every raw Hydra WebSocket message for diagnostics.
    // Attached before monitor.start() so we capture Greetings and everything after.
    if (VERBOSE) {
        hydraMonitor.ws.on('message', (msg: any) => {
            const tag = msg.tag ?? 'unknown';
            const summary: Record<string, any> = { tag };
            if (msg.headStatus) summary.headStatus = msg.headStatus;
            if (msg.hydraHeadId) summary.hydraHeadId = msg.hydraHeadId;
            if (msg.transactionId) summary.transactionId = msg.transactionId;
            if (msg.transaction?.txId) summary.txId = msg.transaction.txId;
            if (msg.validationError) summary.validationError = msg.validationError.reason?.slice(0, 200);
            if (msg.party) summary.party = msg.party;
            if (msg.headId) summary.headId = msg.headId;
            console.log(`[hydra-ws] ${JSON.stringify(summary)}`);
        });
    }

    // Wait for Hydra node to be ready before starting Express.
    // The node takes 30-60s after container start to accept WebSocket connections.
    const maxWaitMs = 120_000;
    const retryMs = 5_000;
    const waitStart = Date.now();
    let connected = false;
    console.log('Waiting for Hydra node to accept connections…');
    while (Date.now() - waitStart < maxWaitMs) {
        try {
            await hydraMonitor.start();
            connected = true;
            const info = hydraMonitor.headInfo;
            console.log(`HydraMonitor connected — status: ${info?.headStatus ?? 'unknown'}, headId: ${info?.headId ?? 'n/a'}, node: ${info?.nodeVersion ?? 'n/a'}`);
            break;
        } catch {
            const elapsed = Math.round((Date.now() - waitStart) / 1000);
            console.log(`  Hydra not ready (${elapsed}s elapsed), retrying in ${retryMs / 1000}s…`);
            await new Promise(r => setTimeout(r, retryMs));
        }
    }
    if (!connected) {
        console.warn(`HydraMonitor failed to connect after ${maxWaitMs / 1000}s — starting anyway (will auto-reconnect)`);
    }

    app.listen(port, () => {
        console.log(`Hydra middleware running on http://localhost:${port} (network ${HYDRA_NETWORK})`);
    });
}

start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
