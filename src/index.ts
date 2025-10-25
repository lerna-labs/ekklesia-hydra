import './load.js';

import express from 'express';
import {authHeaderMiddleware} from './middleware.js';
import {
    Wrangler,
    getAdmin,
    getUtxoSet,
    createNativeScript, submitTx,
} from '@lerna-labs/hydra-sdk';
import {MeshWallet} from "@meshsdk/core";
import {Client} from "./protocol.js";
import {bech32} from 'bech32';
import {createHash} from 'crypto';

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

export function voterIdToHex(voterId: string): string {
    if (!voterId) {
        throw new Error('Invalid voter ID');
    }

    try {
        // Decode the Bech32 payload
        const decoded = bech32.decode(voterId);
        const bytes = bech32.fromWords(decoded.words);

        // Hash to 32 bytes (blake2b-256 ensures fixed 32-byte output)
        const hash = createHash('blake2b512').update(Buffer.from(bytes)).digest('hex').slice(0, 64);

        return hash.toLowerCase();
    } catch (error) {
        console.error(`Failed to convert voter ID to hex:`, error);
        throw new Error('Unable to decode Bech32 identifier');
    }
}

type initializePayload = {
    admin_wallet?: MeshWallet;
    address?: string;
    scriptCbor?: string;
    client?: Client;
}

async function initialize(): Promise<initializePayload> {
    let admin_wallet: MeshWallet;
    try {
        admin_wallet = await getAdmin();
    } catch (error: any) {
        console.error(`Failed to initialize...`, error);
        return {};
    }

    const client = new Client({
        endpoint: TRP_URL as string,
    });

    return {admin_wallet, client};
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

app.post("/register", async (req, res) => {
    const voter_id = req.body.voterId;
    const head_id = voterIdToHex(voter_id);

    try {
        const {admin_wallet, client} = await initialize();
        if (!admin_wallet) {
            res.status(410).json({
                message: "Could not initialize admin wallet",
            });
            return;
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        if (!client) {
            res.status(410).json({
                message: "Could not initialize client",
            });
            return;
        }

        const {
            address: ScriptAddress,
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const trp_response = await client.registerVoterTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, "hex"),
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, "hex"),
            userId: Buffer.from(head_id, "hex"),
        });

        const signedTx = await admin_wallet.signTx(trp_response.tx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${head_id}`);
        const response_json = await submit_response.json();

        res.status(200).json(response_json);
    } catch (err: any) {
        res.status(400).json({
            message: err.message || "Failed to register voter",
        });
    }
})

app.post("/vote", async (req, res) => {
    const voter_id = req.body.voterId;
    const head_id = voterIdToHex(voter_id);

    try {
        const {admin_wallet, client} = await initialize();
        if (!admin_wallet) {
            res.status(410).json({
                message: "Could not initialize admin wallet",
            });
            return;
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        if (!client) {
            res.status(410).json({
                message: "Could not initialize client",
            });
            return;
        }

        const {
            address,
            scriptCbor,
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const trp_response = await client.castVoteTx({
            votingAuthority: admin_payment_address,
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, "hex"),
            userId: Buffer.from(head_id, "hex"),
            coseKey: Buffer.from(req.body.signature.COSE_Key_hex),
            coseSign1: Buffer.from(req.body.signature.COSE_Sign1_hex),
            key: Buffer.from(req.body.signature.key),
            signature: Buffer.from(req.body.signature.signature),
            merkleRoot: Buffer.from(req.body.merkleRoot),
            voteHex: Buffer.from(Buffer.from(JSON.stringify(req.body.votes), "utf8").toString("hex")),
        });

        const signedTx = await admin_wallet.signTx(trp_response.tx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${head_id}`);
        const response_json = await submit_response.json();

        res.status(200).json(response_json);
    } catch (err: any) {
        res.status(400).json({
            message: err.message || "Failed to register voter",
        });
    }
})

app.listen(port, () => {
    console.log(`✅ Hydra SDK API server is running on http://localhost:${port}`);
    console.log(`✅ Hydra Network: ${HYDRA_NETWORK}`);
});
