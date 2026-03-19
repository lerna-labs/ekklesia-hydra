import './load.js';

import express from 'express';
import {authHeaderMiddleware} from './middleware.js';
import {
    Wrangler,
    getAdmin,
    getUtxoSet,
    createNativeScript, submitTx,
} from '@lerna-labs/hydra-sdk';
import {MeshWallet, BlockfrostProvider} from "@meshsdk/core";
import {HydraProvider} from "@meshsdk/hydra";
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
const HYDRA_API_URL = process.env.HYDRA_API_URL as string;
const HYDRA_NETWORK = parseInt(process.env.HYDRA_NETWORK || '0', 10);
const CLOSE_TOKEN = process.env.CLOSE_TOKEN || "shutitdown";
const DEFAULT_GAS_AMOUNT = 100_000_000;

function getBlockfrost(): BlockfrostProvider {
    const key = process.env.BLOCKFROST_API_KEY;
    if (!key) throw new Error("BLOCKFROST_API_KEY not set");
    return new BlockfrostProvider(key);
}

/**
 * Convert a Blockfrost-fetched UTxO into the Hydra node's expected JSON format
 * for use with buildCommit / deposit.
 */
function toHydraUTxO(utxo: any): Record<string, any> {
    const value: Record<string, any> = {lovelace: Number(utxo.output.amount.find((a: any) => a.unit === "lovelace")?.quantity ?? 0)};

    for (const asset of utxo.output.amount) {
        if (asset.unit === "lovelace") continue;
        const policyId = asset.unit.slice(0, 56);
        const assetName = asset.unit.slice(56);
        if (!value[policyId]) value[policyId] = {};
        value[policyId][assetName] = Number(asset.quantity);
    }

    return {
        address: utxo.output.address,
        datum: null,
        inlineDatum: utxo.output.plutusData ?? null,
        inlineDatumRaw: null,
        inlineDatumhash: utxo.output.dataHash ?? null,
        referenceScript: utxo.output.scriptRef ?? null,
        value,
    };
}

/**
 * Open a Hydra head with an empty commit (no initial UTxOs).
 * Uses buildCommit({}) which tells the Hydra node we have nothing to commit.
 */
async function openHeadEmpty(timeoutMs = 180000): Promise<void> {
    const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
    const blockfrost = getBlockfrost();
    const admin = await getAdmin();

    return new Promise(async (resolve, reject) => {
        let settled = false;

        const handle = async (message: any) => {
            try {
                if (message.tag === "HeadIsOpen") {
                    if (settled) return;
                    settled = true;
                    resolve();
                } else if (message.tag === "HeadIsInitializing") {
                    // Empty commit — no UTxOs to commit
                    const commitTx = await wrangler.provider.buildCommit({});
                    if (commitTx?.cborHex) {
                        const signed = await admin.signTx(commitTx.cborHex);
                        await blockfrost.submitTx(signed);
                    }
                } else if (message.tag === "Greetings") {
                    switch (message.headStatus) {
                        case "Idle":
                            await wrangler.provider.init();
                            break;
                        case "Initializing": {
                            const commitTx = await wrangler.provider.buildCommit({});
                            if (commitTx?.cborHex) {
                                const signed = await admin.signTx(commitTx.cborHex);
                                await blockfrost.submitTx(signed);
                            }
                            break;
                        }
                        case "Open":
                            if (!settled) { settled = true; resolve(); }
                            break;
                    }
                }
            } catch (err) {
                if (!settled) { settled = true; reject(err); }
            }
        };

        wrangler.provider.onMessage(handle);

        try {
            await wrangler.provider.connect();
        } catch (err) {
            if (!settled) {
                settled = true;
                return reject(new Error("Failed to connect to Hydra provider: " + String(err)));
            }
        }

        const timer = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error("Timeout waiting for head to open (empty commit)")); }
        }, timeoutMs);

        const origResolve = resolve;
        const origReject = reject;
        resolve = (v: void | PromiseLike<void>) => { clearTimeout(timer); origResolve(v); };
        reject = (e: any) => { clearTimeout(timer); origReject(e); };
    });
}

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

type VoteDatum = {
    version: number;
    voterId: string;
    merkleRoot: string;
    signature: string;
    key: string;
    coseSign1Hex: string;
    coseKeyHex: string;
    votes: string;
}

async function findVoterUtxo(tokenPolicy: string, userId: string): Promise<any | null> {
    const res = await fetch(`${HYDRA_API_URL}/snapshot/utxo`);
    const utxoSet = await res.json();

    const assetKey = `${tokenPolicy}.${userId}`;

    for (const [utxoRef, utxo] of Object.entries<any>(utxoSet)) {
        const value = utxo.value;
        if (!value) continue;

        // Check if any key in value matches our policy.asset pattern
        for (const key of Object.keys(value)) {
            if (key === assetKey) {
                return { ref: utxoRef, ...utxo };
            }
        }
    }

    return null;
}

function parseVoteDatum(datum: any): VoteDatum {
    const fields = datum.fields;
    return {
        version: fields[0].int,
        voterId: fields[1].bytes,
        merkleRoot: fields[2].bytes,
        signature: fields[3].bytes,
        key: fields[4].bytes,
        coseSign1Hex: fields[5].bytes,
        coseKeyHex: fields[6].bytes,
        votes: fields[7].bytes,
    };
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
    // Support both legacy single UTxO, array format, and empty body (empty commit)
    let utxos: {txHash: string, txIndex: number}[] = [];

    if (Array.isArray(req.body.utxos) && req.body.utxos.length > 0) {
        utxos = req.body.utxos.map((u: any) => ({
            txHash: u.txHash,
            txIndex: u.txIdx ?? u.txIndex,
        }));
    } else if (req.body.txHash) {
        utxos = [{txHash: req.body.txHash, txIndex: req.body.txIdx}];
    }
    // If no utxos provided, we'll open with an empty commit

    for (const u of utxos) {
        if (!u.txHash || u.txIndex === undefined || u.txIndex === null || u.txIndex < 0) {
            console.error(`Bad commit identifiers:`, u);
            return res.status(400).json({
                status: 'ERROR',
                message: 'Bad Commit UTxO Identifiers',
            });
        }
    }

    try {
        if (utxos.length === 0) {
            // Empty commit — open head without committing any UTxOs
            await openHeadEmpty(180000);
            return res.json({
                status: 'SUCCESS',
                message: 'Head is open (empty commit)',
                committed: [],
            });
        }

        // TODO: Once hydra-sdk Wrangler supports commitBlueprintUTxOs,
        // pass the full array in a single commit. For now, commit the
        // first UTxO (the SDK only supports one per commit call).
        const wrangler = new Wrangler(process.env.HYDRA_API_URL, process.env.HYDRA_WS_URL);
        await wrangler.waitForHeadOpen(utxos[0], 180000);
        return res.json({
            status: 'SUCCESS',
            message: 'Head is open',
            committed: utxos,
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

app.post("/prepare", async (req, res) => {
    const ballot_id = req.body.ballotId;
    const gasAmount = req.body.gasAmount ?? DEFAULT_GAS_AMOUNT;

    if (!ballot_id) {
        return res.status(400).json({
            message: "Missing ballotId",
        });
    }

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
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const trp_response = await client.prepareHeadTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, "hex"),
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, "hex"),
            ballotId: Buffer.from(ballot_id, "hex"),
            gasAmount,
        });

        const signedTx = await admin_wallet.signTx(trp_response.tx);
        const submit_response = await submitTx(TRP_URL, signedTx, `3:${ballot_id}`);
        const response_json = await submit_response.json();

        res.status(200).json(response_json);
    } catch (err: any) {
        res.status(400).json({
            message: err.message || "Failed to prepare head",
        });
    }
})

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

        const existingUtxo = await findVoterUtxo(TOKEN_POLICY as string, head_id);
        if (existingUtxo) {
            res.status(409).json({
                message: "Voter is already registered",
            });
            return;
        }

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

        const voterUtxo = await findVoterUtxo(TOKEN_POLICY as string, head_id);
        if (!voterUtxo) {
            res.status(404).json({
                message: "Voter is not registered",
            });
            return;
        }

        let nextVersion = 1;
        if (voterUtxo.datum) {
            const parsed = parseVoteDatum(voterUtxo.datum);
            nextVersion = parsed.version + 1;
        }

        const trp_response = await client.castVoteTx({
            votingAuthority: admin_payment_address,
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, "hex"),
            userId: Buffer.from(head_id, "hex"),
            version: nextVersion,
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

app.post("/vote-and-register", async (req, res) => {
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
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const existingUtxo = await findVoterUtxo(TOKEN_POLICY as string, head_id);
        if (existingUtxo) {
            res.status(409).json({
                message: "Voter is already registered",
            });
            return;
        }

        const trp_response = await client.voteAndRegisterTx({
            votingAuthority: admin_payment_address,
            mintingScript: Buffer.from(TOKEN_SCRIPT as string, "hex"),
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
            message: err.message || "Failed to vote and register",
        });
    }
})

app.post("/count", async (req, res) => {
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
            scriptCbor: TOKEN_SCRIPT,
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const voterUtxo = await findVoterUtxo(TOKEN_POLICY as string, head_id);
        if (!voterUtxo) {
            res.status(404).json({
                message: "Voter is not registered",
            });
            return;
        }

        const trp_response = await client.countVoteTx({
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
            message: err.message || "Failed to count vote",
        });
    }
})

app.post("/finalize", async (req, res) => {
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
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const trp_response = await client.finalizeVoteTx({
            votingAuthority: admin_payment_address,
            tokenPolicy: Buffer.from(TOKEN_POLICY as string, "hex"),
            ballotId: Buffer.from(req.body.ballotId, "hex"),
            merkleRoot: Buffer.from(req.body.merkleRoot, "hex"),
            totalVotes: req.body.totalVotes,
            validVotes: req.body.validVotes,
        });

        const signedTx = await admin_wallet.signTx(trp_response.tx);
        const submit_response = await submitTx(TRP_URL, signedTx, `0:${req.body.ballotId}`);
        const response_json = await submit_response.json();

        res.status(200).json(response_json);
    } catch (err: any) {
        res.status(400).json({
            message: err.message || "Failed to finalize vote",
        });
    }
})

app.get("/voter/:voterId", async (req, res) => {
    const voter_id = req.params.voterId;
    const head_id = voterIdToHex(voter_id);

    try {
        const {admin_wallet} = await initialize();
        if (!admin_wallet) {
            res.status(410).json({
                message: "Could not initialize admin wallet",
            });
            return;
        }

        const admin_payment_address = admin_wallet.addresses.enterpriseAddressBech32 as string;

        const {
            scriptHash: TOKEN_POLICY
        } = createNativeScript(admin_payment_address);

        const voterUtxo = await findVoterUtxo(TOKEN_POLICY as string, head_id);
        if (!voterUtxo) {
            res.status(404).json({
                message: "Voter is not registered",
            });
            return;
        }

        if (!voterUtxo.datum) {
            res.status(200).json({
                message: "Voter is registered but has no vote datum",
            });
            return;
        }

        const datum = parseVoteDatum(voterUtxo.datum);
        res.status(200).json(datum);
    } catch (err: any) {
        res.status(400).json({
            message: err.message || "Failed to lookup voter",
        });
    }
})

// ── Incremental Deposit ──────────────────────────────────────────────
app.post("/deposit", async (req, res) => {
    const utxoRefs: {txHash: string, txIdx: number}[] = req.body.utxos;

    if (!Array.isArray(utxoRefs) || utxoRefs.length === 0) {
        return res.status(400).json({status: "ERROR", message: "Provide a non-empty \"utxos\" array of {txHash, txIdx}"});
    }

    try {
        const admin = await getAdmin();
        const blockfrost = getBlockfrost();
        const provider = new HydraProvider({httpUrl: HYDRA_API_URL, history: false});
        const deposited: string[] = [];

        for (const ref of utxoRefs) {
            // Fetch the UTxO from L1
            const l1Utxos = await blockfrost.fetchUTxOs(ref.txHash);
            const target = l1Utxos.find((u: any) => u.input.outputIndex === ref.txIdx);
            if (!target) {
                return res.status(404).json({
                    status: "ERROR",
                    message: `UTxO not found on L1: ${ref.txHash}#${ref.txIdx}`,
                });
            }

            // Convert to Hydra format and build the commit/deposit tx
            const hydraUtxo = toHydraUTxO(target);
            const key = `${ref.txHash}#${ref.txIdx}`;
            const commitResult = await provider.buildCommit({[key]: hydraUtxo});

            if (commitResult?.cborHex) {
                const signed = await admin.signTx(commitResult.cborHex);
                await blockfrost.submitTx(signed);
                deposited.push(key);
            }
        }

        return res.json({status: "SUCCESS", deposited});
    } catch (err: any) {
        console.error("Deposit failed:", err);
        return res.status(400).json({status: "ERROR", message: err.message || "Deposit failed"});
    }
});

// ── Incremental Decommit ─────────────────────────────────────────────
app.post("/decommit", async (req, res) => {
    const provider = new HydraProvider({httpUrl: HYDRA_API_URL, history: false});

    try {
        if (req.body.cborHex) {
            // Raw CBOR path — caller already built the L2 tx
            const tx = {
                type: "Tx ConwayEra" as const,
                description: "",
                cborHex: req.body.cborHex as string,
            };
            const result = await provider.decommit(tx);
            return res.json({status: "SUCCESS", txHash: result});
        }

        // Server-side build path
        const utxoRefs: {txHash: string, txIdx: number}[] | undefined = req.body.utxos;
        const toAddress: string | undefined = req.body.to;

        if (!utxoRefs || !toAddress) {
            return res.status(400).json({
                status: "ERROR",
                message: 'Provide either "cborHex" or both "utxos" and "to"',
            });
        }

        // Fetch the snapshot to find UTxOs in the head
        const snapshotRes = await fetch(`${HYDRA_API_URL}/snapshot/utxo`);
        const snapshot = await snapshotRes.json();

        // Build a simple L2 transaction sending the specified UTxOs to `to`
        // For L2, fees are 0. We use MeshTxBuilder with HydraProvider as fetcher.
        const {MeshTxBuilder} = await import("@meshsdk/core");
        const admin = await getAdmin();
        const txBuilder = new MeshTxBuilder({fetcher: provider as any});

        let totalLovelace = 0;
        for (const ref of utxoRefs) {
            const key = `${ref.txHash}#${ref.txIdx}`;
            const utxo = snapshot[key];
            if (!utxo) {
                return res.status(404).json({
                    status: "ERROR",
                    message: `UTxO not found in head: ${key}`,
                });
            }
            txBuilder.txIn(ref.txHash, ref.txIdx);
            totalLovelace += Number(utxo.value?.lovelace ?? 0);
        }

        txBuilder.txOut(toAddress, [{unit: "lovelace", quantity: String(totalLovelace)}]);
        txBuilder.changeAddress(toAddress);

        const unsignedTx = await txBuilder.complete();
        const signedTx = await admin.signTx(unsignedTx);

        const tx = {
            type: "Tx ConwayEra" as const,
            description: "",
            cborHex: signedTx,
        };
        const result = await provider.decommit(tx);
        return res.json({status: "SUCCESS", txHash: result});
    } catch (err: any) {
        console.error("Decommit failed:", err);
        return res.status(400).json({status: "ERROR", message: err.message || "Decommit failed"});
    }
});

// ── Pending Deposits ─────────────────────────────────────────────────
app.get("/pending-deposits", async (_req, res) => {
    try {
        const provider = new HydraProvider({httpUrl: HYDRA_API_URL, history: false});
        const pending = await provider.getPendingCommits();
        return res.json({status: "SUCCESS", pending});
    } catch (err: any) {
        console.error("Failed to get pending deposits:", err);
        return res.status(400).json({status: "ERROR", message: err.message || "Failed to get pending deposits"});
    }
});

// ── Recover Deposit ──────────────────────────────────────────────────
app.post("/recover", async (req, res) => {
    const txHash = req.body.txHash;
    if (!txHash) {
        return res.status(400).json({status: "ERROR", message: "Provide \"txHash\""});
    }

    try {
        const provider = new HydraProvider({httpUrl: HYDRA_API_URL, history: false});
        const result = await provider.recover(txHash);
        return res.json({status: "SUCCESS", txHash: result});
    } catch (err: any) {
        console.error("Recover failed:", err);
        return res.status(400).json({status: "ERROR", message: err.message || "Recover failed"});
    }
});

app.listen(port, () => {
    console.log(`✅ Hydra SDK API server is running on http://localhost:${port}`);
    console.log(`✅ Hydra Network: ${HYDRA_NETWORK}`);
});
