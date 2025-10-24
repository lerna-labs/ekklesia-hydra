import './load.js';

import express from 'express';
import {authHeaderMiddleware} from './middleware.js';
import {
    Wrangler,
    queryUtxoByAddress,
    createMultisigAddress,
    getAdmin,
    getUtxoSet
} from '@lerna-labs/hydra-sdk';
import {MeshWallet} from "@meshsdk/core";
import {Client} from "./protocol.js";

const app = express();
app.use(express.json());
app.use(authHeaderMiddleware);

process.on('SIGTERM', () => {
    console.log('🔻 SIGTERM received, shutting down gracefully');
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('🔻 SIGINT received, shutting down gracefully');
    process.exit(0);
});

app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('Unhandled error:', err);
    res.status(500).json({status: 'ERROR', message: 'Internal server error'});
});

const port = 3000;
const TRP_URL = process.env.TRP_URL as string;
const HYDRA_NETWORK = parseInt(process.env.HYDRA_NETWORK || '0', 10);
const CLOSE_TOKEN = process.env.CLOSE_TOKEN || "shutitdown";

console.log(`Ekklesia Hydra has launched! ${port} ${HYDRA_NETWORK} ${CLOSE_TOKEN}`);

// Recursive function to sanitize BigInts... need to swap them to strings when passing JSON
function sanitizeBigInts(obj: any): any {
    if (typeof obj === 'bigint') {
        return obj.toString();
    } else if (Array.isArray(obj)) {
        return obj.map(sanitizeBigInts);
    } else if (obj && typeof obj === 'object') {
        const newObj: any = {};
        for (const key of Object.keys(obj)) {
            newObj[key] = sanitizeBigInts(obj[key]);
        }
        return newObj;
    } else {
        return obj;
    }
}

type initializePayload = {
    admin_wallet?: MeshWallet;
    address?: string;
    scriptCbor?: string;
    client?: Client;
}

async function initialize(user_address?: string): Promise<initializePayload> {
    let admin_wallet: MeshWallet;
    try {
        admin_wallet = await getAdmin();
    } catch (error: any) {
        console.error(`Failed to initialize...`, error);
        return {};
    }

    const admin_address = admin_wallet.addresses.enterpriseAddressBech32 as string;
    const client = new Client({
        endpoint: TRP_URL as string,
    });

    if (user_address === undefined) {
        return {admin_wallet, client};
    } else {
        const {
            address,
            scriptCbor,
        } = createMultisigAddress(admin_address, user_address, HYDRA_NETWORK);
        return {admin_wallet, address, scriptCbor, client};
    }
}

app.get('/', (_, res) => {
    res.send('Hydra SDK API is running');
});

app.get('/health', async (_, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    try {
        const status = await wrangler.getHeadStatus(5000); // 5s
        return res.json({status});
    } catch (e: any) {
        console.error('Health check failed:', e);
        return res.json({
            status: 'ERROR',
            message: 'Could not connect to Hydra node!',
        });
    }
});

app.post('/start', async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const txHash = req.body.txHash;
    const txIndex = req.body.txIdx;

    if (!txHash || txIndex === undefined || txIndex === null || txIndex < 0) {
        console.error(`Bad commit identifiers:`, txHash, txIndex);
        return res.status(400).json({
            status: 'ERROR',
            message: 'Bad Commit UTxO Identifiers',
        });
    }

    try {
        await wrangler.waitForHeadOpen({txHash, txIndex}, 180000);
        return res.json({
            status: 'SUCCESS',
            message: 'Head is open',
        });
    } catch (err: any) {
        console.error('Failed to start head:', err);
        return res.json({
            status: 'ERROR',
            message: err.message || 'Failed to start head',
        });
    }
});

app.post("/close", async (req, res) => {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const close_token = req.body.closeToken;

    if (!close_token || close_token !== CLOSE_TOKEN) {
        console.error("Request to close w/o correct token!", close_token);
        return res.status(400).json({
            status: "ERROR",
            message: "Incorrect close token",
        });
    }

    try {
        await wrangler.waitForHeadClose(180000);
        return res.json({
            status: "SUCCESS",
            message: "Head is closed"
        });
    } catch (err: any) {
        console.error("Failed to close head?", err);
        return res.json({
            status: "ERROR",
            message: err.message || "Failed to close head",
        });
    }
});

app.post("/ledger", async (req, res) => {
    const {admin_wallet} = await initialize();

    if (!admin_wallet) {
        res.json({
            status: "ERROR",
            message: "Could not initialize admin wallet",
        });
        return;
    }

    const utxo_set = await getUtxoSet();
    res.json({
        status: "SUCCESS",
        data: {
            utxos: utxo_set,
            admin_wallet: admin_wallet.addresses.enterpriseAddressBech32
        }
    });

});

app.get("/user/:address", async (req, res) => {
    const user_address = req.params.address;
    const {admin_wallet, address} = await initialize(user_address);

    if (!address) {
        res.json({
            status: "ERROR",
            message: "Could not initialize user address",
        });
        return;
    }

    res.json({
        status: "SUCCESS",
        data: {
            address,
        }
    });
});

app.get('/utxos/:address', async (req, res) => {
    const user_address = req.params.address;

    if (!user_address) {
        res.json({
            status: 'ERROR',
            message: 'Could not initialize user address',
        });
        return;
    }

    try {
        const utxos = await queryUtxoByAddress(user_address);
        res.json({
            status: 'SUCCESS',
            data: {
                address: user_address,
                utxos,
            },
        });
    } catch (error: any) {
        res.json({
            status: 'ERROR',
            message: 'Failed to query UTxO',
        });
    }
});

app.get('/balance/:address', async (req, res) => {
    const user_address = req.params.address;

    if (!user_address) {
        res.json({
            status: 'ERROR',
            message: 'Could not initialize user address',
        });
        return;
    }

    try {
        const utxos = await queryUtxoByAddress(user_address);
        const balance: Record<string, bigint> = {};
        utxos.forEach((utxo: any) => {
            utxo.amount.forEach((value: any) => {
                const policy_id = value.unit;
                for (const [asset_id, quantity] of Object.entries(value.quantity)) {
                    const unit = `${policy_id}.${asset_id}`;
                    if (balance[unit] === undefined) {
                        balance[unit] = 0n;
                    }

                    balance[unit] += BigInt(quantity as string);
                }
            });
        });
        res.json({
            status: 'SUCCESS',
            data: {
                balance: sanitizeBigInts(balance),
            },
        });
    } catch (error: any) {
        console.error(`Balance check error`, error);
        res.json({
            status: 'ERROR',
            message: 'Could not query utxo by address',
        });
    }
});

app.listen(port, () => {
    console.log(`✅ Hydra SDK API server is running on http://localhost:${port}`);
    console.log(`✅ Hydra Network: ${HYDRA_NETWORK}`);
});
