# Ekklesia Hydra Testing Guide

Testing guide for the Ekklesia Hydra voting middleware against a live
Hydra SDK stack.

---

## 1. Prerequisites

- **Remote VM** with the full Hydra SDK stack running (Hydra node, IPFS,
  TRP, Blockfrost, admin wallet with funds)
- **Node.js 22+** on the machine running tests
- **cardano-signer** CLI installed ([github.com/gitmachtl/cardano-signer](https://github.com/gitmachtl/cardano-signer))
  — used by the E2E test for key generation and CIP-8 signing

---

## 2. Configuration

The E2E tests are configured via environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `E2E_API_URL` | Yes | Middleware base URL (e.g., `http://10.0.0.5:3000`) |
| `E2E_API_KEY` | Yes | Value for the `x-api-key` header |
| `E2E_BLOCKFROST_KEY` | Yes | Blockfrost project ID (for L1 tx confirmation polling) |
| `E2E_CLOSE_TOKEN` | No | Token to close the head (default: `shutitdown`) |
| `E2E_DUMP_ADDRESS` | No | Bech32 address to sweep stale tokens to before testing |

### Middleware container environment

Set `VERBOSE=1` on the middleware container to enable debug logging of
TRP requests, unsigned/signed transaction CBOR, and submit responses.
Omit it in production for quiet logs (errors always log regardless).

---

## 3. Running the Automated E2E Tests

The E2E test covers the full ballot lifecycle: mint → open head → register
+ vote (with real COSE signatures) → query → audit → finalize → burn →
close head.

```bash
E2E_API_URL=http://<vm-ip>:3000 \
E2E_API_KEY=<your-api-key> \
npm run test:e2e
```

The test generates a fresh DRep key pair on each run using `cardano-signer`,
computes the correct `blake2b256` merkle root, signs it with CIP-8
COSE_Sign1, and submits a real vote. All assertions are strict (expect
200 responses, not fallback 401s).

### Running the signing unit test

A faster offline test validates COSE signature construction against the
SDK's `verifySignature()` without needing any network infrastructure:

```bash
npx vitest run tests/signing.test.ts
```

---

## 4. Manual Testing with curl

### 4.1 Generate DRep keys

```bash
cardano-signer keygen --path drep --json-extended
```

Save the output — you'll need `drepIdBech` (voter ID) and `secretKey`
(for signing).

### 4.2 Check middleware health

```bash
curl http://<vm-ip>:3000/health \
  -H "x-api-key: <your-api-key>"
```

### 4.3 Mint ballot tokens (L1)

```bash
curl -X POST http://<vm-ip>:3000/prepare \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{
    "namespace": "vote.ekklesia.test.manual",
    "ballot": {
      "specVersion": "1.0.0",
      "title": "Manual Test Ballot",
      "description": "Manual test",
      "questions": [{
        "questionId": "q1",
        "question": "Approve?",
        "method": "binary",
        "options": [
          { "label": "Yes", "value": 1 },
          { "label": "No", "value": 0 },
          { "label": "Abstain", "value": 2 }
        ]
      }],
      "roleWeighting": { "DRep": "CredentialBased" },
      "endEpoch": 999,
      "ekklesia": {
        "namespace": "", "votingAuthority": "", "context": "hydra-head",
        "acceptedCredentials": ["0x22"], "merkleRoot": "", "ballotIpfsCid": "",
        "votingWindow": {
          "open": "2026-04-01T00:00:00Z",
          "close": "2026-04-30T00:00:00Z"
        }
      }
    },
    "gasAmount": 50
  }'
```

Save `txHash` (used as `ballotId`), `instanceAssetName` (used as
`ballotName`), and `ballotIpfsCid`.

### 4.4 Open head

```bash
curl -X POST http://<vm-ip>:3000/start \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{
    "utxos": [
      { "txHash": "<txHash>", "outputIndex": 1 },
      { "txHash": "<txHash>", "outputIndex": 2 }
    ],
    "ballotIpfsCid": "<ballotIpfsCid>"
  }'
```

### 4.5 Compute merkle root and sign

The voter signs `blake2b256(JSON.stringify({ballotId, nonce, votes}))`.
Compute the merkle root:

```bash
# Compute the merkle root (example using Node.js one-liner)
node --input-type=module -e "
import { blake2b256, bytesToHex } from '@lerna-labs/hydra-proof';
const payload = {
  ballotId: '<txHash>',
  nonce: 1,
  votes: [{ questionId: 'q1', selection: [1] }]
};
console.log(bytesToHex(blake2b256(JSON.stringify(payload))));
"
```

Then sign:

```bash
cardano-signer sign --cip8 \
  --data "<merkleRoot hex from above>" \
  --secret-key "<secretKey hex from keygen>" \
  --address "<drepIdBech from keygen>" \
  --json-extended
```

### 4.6 Submit vote

```bash
curl -X POST http://<vm-ip>:3000/vote-and-register \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{
    "voterId": "<drepIdBech>",
    "ballotId": "<txHash>",
    "votes": [{ "questionId": "q1", "selection": [1] }],
    "signature": {
      "coseSign1Hex": "<COSE_Sign1_hex from sign output>",
      "coseKeyHex": "<COSE_Key_hex from sign output>",
      "key": "<publicKey from sign output>",
      "signature": "<signature from sign output>"
    }
  }'
```

### 4.7 Query and audit

```bash
# All votes
curl http://<vm-ip>:3000/votes -H "x-api-key: <your-api-key>"

# Specific voter
curl http://<vm-ip>:3000/voter/<drepIdBech> -H "x-api-key: <your-api-key>"

# Full audit bundle
curl http://<vm-ip>:3000/audit -H "x-api-key: <your-api-key>"

# Single voter audit
curl http://<vm-ip>:3000/audit/vote/<drepIdBech> -H "x-api-key: <your-api-key>"
```

### 4.8 Settle

```bash
curl -X POST http://<vm-ip>:3000/settle \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-api-key>" \
  -d '{
    "ballotId": "<txHash>",
    "ballotName": "<instanceAssetName>",
    "closeToken": "shutitdown"
  }'
```

---

## 5. Signature Reference

### What gets signed

The voter signs a blake2b-256 hash of the `SignedVotePayload`:

```typescript
SignedVotePayload = {
    ballotId: string,   // tx hash from /prepare
    nonce: number,      // 1 for first vote, increments on updates
    votes: VoteSelection[]
}
merkleRoot = blake2b256(JSON.stringify(signedPayload))  // 64-char hex
```

The merkle root hex string is signed as CIP-8 COSE_Sign1 text payload
(not hashed, not hex-decoded — the ASCII hex string itself is the payload).

### COSE_Sign1 structure

The middleware's SDK verifies three things:
1. **Ed25519 signature** is valid over the COSE Sig_structure
2. **Payload matches** — extracted COSE payload (as ASCII) equals the
   merkle root hex string
3. **Address matches** — blake2b-224 of the COSE_Key public key matches
   the DRep credential hash (first byte of bech32 data skipped)

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `SIGNATURE_INVALID` / 401 | Merkle root mismatch between client and server | Ensure `JSON.stringify` field order matches: `{ballotId, nonce, votes}` |
| `CONFLICT` / 409 on vote-and-register | Voter already registered | Use `POST /vote` with incremented nonce instead |
| 503 on vote endpoints | IPFS node unreachable | Check IPFS_API_URL connectivity from the VM |
| Head not opening (timeout) | UTxO not confirmed on L1 | Wait for L1 confirmation (~20s) before calling /start |
| `cardano-signer` not found | CLI not in PATH | Install from [github.com/gitmachtl/cardano-signer](https://github.com/gitmachtl/cardano-signer) |
