# Ekklesia Hydra E2E Testing Guide

Step-by-step guide for running a complete voting lifecycle on Cardano testnet
using the Ekklesia Hydra middleware.

---

## 1. Prerequisites

- **Docker** — for running the middleware container
- **Node.js 22+** — for local development / running tests
- **Hydra node** — running and connected to Cardano testnet
- **IPFS node** — Kubo HTTP API (default: `http://localhost:5001`)
- **Blockfrost API key** — for testnet (`preview` or `preprod`)
- **TRP server** — Tx3 runtime protocol endpoint

---

## 2. Testnet Wallet Setup

### 2.1 Generate an admin wallet

Use `cardano-cli` to generate a new key pair:

```bash
cardano-cli address key-gen \
  --verification-key-file admin.vkey \
  --signing-key-file admin.skey

cardano-cli address build \
  --payment-verification-key-file admin.vkey \
  --out-file admin.addr \
  --testnet-magic 2  # preview testnet
```

### 2.2 Export the CBOR signing key

The middleware expects `HYDRA_ADMIN_CARDANO_PK` as CBOR hex:

```bash
cat admin.skey | jq -r '.cborHex'
# Use this value for HYDRA_ADMIN_CARDANO_PK
```

### 2.3 Derive the enterprise address

The enterprise address (no staking component) is what the middleware uses
for all operations:

```bash
cat admin.addr
# e.g., addr_test1qz...
```

---

## 3. Get Testnet Funds

### 3.1 Request tADA from the faucet

Visit the Cardano testnet faucet:
- **Preview**: https://docs.cardano.org/cardano-testnets/tools/faucet/

Enter your enterprise address from step 2.3. You'll receive ~10,000 tADA.

### 3.2 Verify funds arrived

```bash
# Using Blockfrost API
curl -H "project_id: YOUR_BLOCKFROST_KEY" \
  https://cardano-preview.blockfrost.io/api/v0/addresses/$(cat admin.addr)
```

Wait for the transaction to be confirmed (~20 seconds on preview).

---

## 4. Environment Configuration

### 4.1 Create `.local.env`

```env
# Admin wallet
HYDRA_ADMIN_CARDANO_PK=5820<your-skey-cbor-hex>

# Network
HYDRA_NETWORK=0

# Infrastructure
HYDRA_API_URL=http://localhost:4001
HYDRA_WS_URL=ws://localhost:4001
TRP_URL=http://localhost:50051
BLOCKFROST_API_KEY=previewXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
IPFS_API_URL=http://localhost:5001
IPFS_STAGING_DIR=/ipfs-staging

# Auth
X_API_KEY=test-api-key-123
CLOSE_TOKEN=shutitdown
```

### 4.2 Start the middleware

**Docker:**
```bash
docker build -t ekklesia-hydra .
docker run -p 3000:3000 --env-file .local.env ekklesia-hydra
```

**Local development:**
```bash
npm run dev
```

### 4.3 Verify the middleware is running

```bash
curl http://localhost:3000/
# → "Hydra SDK API is running"
```

---

## 5. Mint Ballot Tokens (L1)

### 5.1 Prepare the ballot

```bash
curl -X POST http://localhost:3000/prepare \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{
    "namespace": "vote.ekklesia.test.e2e-2026-03",
    "ballot": {
      "specVersion": "0.3.0",
      "title": "E2E Test Ballot",
      "description": "End-to-end test ballot for Hydra voting",
      "questions": [
        {
          "questionId": "q1",
          "question": "Do you approve this proposal?",
          "method": "binary",
          "options": [
            { "label": "Yes", "value": 1 },
            { "label": "No", "value": 0 },
            { "label": "Abstain", "value": 2 }
          ]
        },
        {
          "questionId": "q2",
          "question": "Select your preferred options",
          "method": "multi-choice",
          "options": [
            { "label": "Option A", "value": 0 },
            { "label": "Option B", "value": 1 },
            { "label": "Option C", "value": 2 }
          ],
          "maxSelections": 2,
          "minSelections": 1
        }
      ],
      "roleWeighting": { "DRep": "CredentialBased" },
      "endEpoch": 999,
      "ekklesia": {
        "namespace": "",
        "votingAuthority": "",
        "context": "hydra-head",
        "acceptedCredentials": ["0x22"],
        "merkleRoot": "",
        "ballotIpfsCid": "",
        "votingWindow": {
          "open": "2026-04-01T00:00:00Z",
          "close": "2026-04-30T00:00:00Z"
        }
      }
    },
    "gasAmount": 50
  }'
```

### 5.2 Save the response

The response contains values you'll need throughout the test:

```json
{
  "status": "SUCCESS",
  "data": {
    "txHash": "<save this — used as ballotId>",
    "policyId": "<save this>",
    "fingerprint": "<save this>",
    "instanceAssetName": "<save this — used as ballotName>",
    "ballotIpfsCid": "<save this — used in /start>",
    "commitUtxos": [
      { "txHash": "...", "outputIndex": 1 },
      { "txHash": "...", "outputIndex": 2 }
    ]
  }
}
```

### 5.3 Wait for L1 confirmation

The minting transaction needs to be confirmed on-chain before committing
to the Hydra head. Wait ~20 seconds, then verify:

```bash
curl -H "project_id: YOUR_BLOCKFROST_KEY" \
  "https://cardano-preview.blockfrost.io/api/v0/txs/<txHash>"
```

---

## 6. Open the Hydra Head

```bash
curl -X POST http://localhost:3000/start \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{
    "utxos": [
      { "txHash": "<txHash from /prepare>", "outputIndex": 1 },
      { "txHash": "<txHash from /prepare>", "outputIndex": 2 }
    ],
    "ballotIpfsCid": "<ballotIpfsCid from /prepare>"
  }'
```

This waits up to 180 seconds for the head to open. On success:

```json
{ "status": "SUCCESS", "data": { "ballotCached": true } }
```

### 6.1 Verify head is open

```bash
curl http://localhost:3000/health \
  -H "x-api-key: test-api-key-123"
# → { "status": "SUCCESS", "data": { "headStatus": { ... } } }
```

---

## 7. Register Voters and Cast Votes

### 7.1 Single vote (register + vote)

```bash
curl -X POST http://localhost:3000/vote-and-register \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{
    "voterId": "drep1<your-drep-bech32>",
    "ballotId": "<txHash from /prepare>",
    "votes": [
      { "questionId": "q1", "selection": [1] },
      { "questionId": "q2", "selection": [0, 2] }
    ],
    "signature": {
      "coseSign1Hex": "<COSE_Sign1 hex from wallet>",
      "coseKeyHex": "<COSE_Key hex from wallet>",
      "key": "<raw key hex>",
      "signature": "<raw signature hex>"
    }
  }'
```

### 7.2 Constructing COSE signatures

The voter must sign a specific payload. The signed message is:

```
merkleRoot = blake2b_256(JSON.stringify({
  ballotId: "<ballotId>",
  nonce: 1,
  votes: [{ questionId: "q1", selection: [1] }, ...],
  timestamp: "<ISO timestamp>"
}))
```

Use a CIP-30 compatible wallet (e.g., Eternl, Nami, Lace) to produce the
COSE_Sign1 and COSE_Key from the voter's DRep credential.

### 7.3 Stress testing (multiple voters)

For stress testing, loop the `/vote-and-register` endpoint with different
voter IDs. Each voter needs a unique bech32 credential:

```bash
# Example: register 100 voters
for i in $(seq 1 100); do
  curl -X POST http://localhost:3000/vote-and-register \
    -H "Content-Type: application/json" \
    -H "x-api-key: test-api-key-123" \
    -d "{
      \"voterId\": \"drep1voter${i}...\",
      \"ballotId\": \"<txHash>\",
      \"votes\": [{ \"questionId\": \"q1\", \"selection\": [1] }],
      \"signature\": { ... }
    }"
done
```

**Recommended test sizes:**
- Smoke test: 1-5 voters
- Integration test: 10-25 voters
- Stress test: 100-500 voters
- Load test: 500+ voters (monitor Hydra node memory/throughput)

---

## 8. Query During Voting

```bash
# All votes (slim list)
curl http://localhost:3000/votes -H "x-api-key: test-api-key-123"

# Specific voter
curl http://localhost:3000/voter/drep1... -H "x-api-key: test-api-key-123"

# Ballot definition
curl http://localhost:3000/ballot -H "x-api-key: test-api-key-123"

# Full audit bundle
curl http://localhost:3000/audit -H "x-api-key: test-api-key-123"

# Single voter audit (with IPFS evidence)
curl http://localhost:3000/audit/vote/drep1... -H "x-api-key: test-api-key-123"
```

---

## 9. Settle the Vote

### Option A: Full settlement (recommended)

Runs finalize → burn all voter tokens → close head in one call:

```bash
curl -X POST http://localhost:3000/settle \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{
    "ballotId": "<txHash from /prepare>",
    "ballotName": "<instanceAssetName from /prepare>",
    "closeToken": "shutitdown"
  }'
```

### Option B: Manual step-by-step

```bash
# Step 1: Finalize (tally + IPFS pin + update (601) datum)
curl -X POST http://localhost:3000/finalize \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{
    "ballotId": "<txHash>",
    "ballotName": "<instanceAssetName>"
  }'

# Step 2: Burn all voter tokens
curl -X POST http://localhost:3000/count \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{}'

# Step 3: Close head
curl -X POST http://localhost:3000/close \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-api-key-123" \
  -d '{ "closeToken": "shutitdown" }'
```

### 9.1 Save settlement results

From the `/settle` or `/finalize` response, save:
- `resultsHash` — blake2b_256 of results JSON
- `evidenceDirectoryCid` — IPFS directory CID containing all evidence
- `evidenceMerkleRoot` — merkle root of all vote hashes
- `totalVoters` — voter count

---

## 10. Verify Results on Testnet

After settlement, the (601) token returns to L1 via Hydra fanout with an
updated datum. Follow the [Auditor Verification Guide](AUDITOR_GUIDE.md)
to independently verify.

### 10.1 Find the (601) token on L1

```bash
# Query admin address UTxOs via Blockfrost
curl -H "project_id: YOUR_BLOCKFROST_KEY" \
  "https://cardano-preview.blockfrost.io/api/v0/addresses/<admin-addr>/utxos"

# Look for the UTxO containing asset with prefix 00259a20 (601 label)
```

### 10.2 Read the (601) datum

The inline datum should show:

```json
{
  "BallotId": "<ballotId>",
  "Status": 3,
  "ResultsHash": "<matches resultsHash from /settle>",
  "EvidenceCid": "<matches evidenceDirectoryCid>",
  "TotalVoters": 42,
  "MerkleRoot": "<matches evidenceMerkleRoot>"
}
```

### 10.3 Fetch evidence from IPFS

```bash
# Fetch the results file
curl "https://ipfs.io/ipfs/<evidenceDirectoryCid>/results.json"

# Fetch a specific voter's evidence
curl "https://ipfs.io/ipfs/<evidenceDirectoryCid>/votes/<tokenName>.json"

# Fetch a voter's merkle inclusion proof
curl "https://ipfs.io/ipfs/<evidenceDirectoryCid>/proofs/<voterId>.json"
```

### 10.4 Verify cryptographic integrity

1. `blake2b_256(results.json)` should match the on-chain `ResultsHash`
2. Each voter's `blake2b_256(evidence JSON)` should match their `voteHash`
3. Each voter's merkle inclusion proof should resolve to the on-chain `MerkleRoot`
4. Each voter's COSE signature should verify against their credential

See the full verification checklist in [AUDITOR_GUIDE.md](AUDITOR_GUIDE.md).

---

## 11. Stress Test Parameters

| Metric | Where to measure |
|--------|-----------------|
| Vote submission throughput | Time between `/vote-and-register` calls |
| IPFS pin latency | Time for IPFS pin during each vote |
| Finalization time | Duration of `/finalize` (scales with voter count) |
| Burn throughput | Sequential burns in `/count` |
| Head close + fanout | Duration of `/close` |
| Evidence directory size | IPFS directory size after `/finalize` |

**Known scaling characteristics:**
- Voter token burns are sequential (each depends on UTxO state from previous)
- Merkle tree construction at finalization scales O(n log n)
- IPFS pinning at finalization pins all evidence files in one directory
- Hydra head transaction throughput depends on node configuration

---

## 12. Cleanup

### 12.1 Return tADA to the faucet

After testing, return unused tADA to the faucet return address (listed on
the faucet page) to keep testnet funds circulating.

### 12.2 Tear down containers

```bash
docker stop <container-id>
# Also stop Hydra node, IPFS node, TRP server as needed
```

### 12.3 Clean up staging directory

```bash
rm -rf /ipfs-staging/*
```

---

## 13. Running the Automated E2E Tests

The repository includes a vitest-based integration test that covers the
full lifecycle:

```bash
# Requires all services running (Hydra, IPFS, TRP, Blockfrost)
npm run test:e2e
```

The test file is at `tests/e2e.test.ts`. It covers:
1. Ballot minting (`POST /prepare`)
2. Head open (`POST /start`)
3. Vote + register (`POST /vote-and-register`)
4. Query endpoints (`GET /ballot`, `/votes`, `/voter/:id`, `/audit`)
5. Settlement (`POST /finalize`)

**Note:** The automated test uses placeholder COSE signatures by default.
Set the `E2E_COSE_SIGN1`, `E2E_COSE_KEY`, `E2E_SIG_KEY`, and `E2E_SIG`
environment variables with real signatures to test signature verification.
