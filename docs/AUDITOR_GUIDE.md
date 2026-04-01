# Ekklesia Hydra Vote Auditor Verification Guide

This document describes how a third party can independently verify the integrity
of an Ekklesia vote conducted inside a Hydra state channel on Cardano.

Verification can be performed **live** (during the voting window via API) or
**retroactively** (after settlement, using only L1 on-chain data and IPFS).

---

## Prerequisites

- Access to a Cardano node or indexer (Blockfrost, Koios, etc.)
- Access to an IPFS gateway (public or the node used by the voting authority)
- A blake2b-256 hash implementation
- A COSE signature verification library (for Ed25519 / CIP-30 signatures)
- The voting authority's policy ID (identifies all ballot and voter tokens)

---

## 1. Locate the Ballot Tokens on L1

All Ekklesia ballot tokens are minted under a **native script policy** derived
from the voting authority's payment key. The tokens use CIP-67 asset name prefixes:

| Token | CIP-67 Label | Prefix Bytes | Purpose |
|-------|-------------|--------------|---------|
| Ballot Definition | (600) | `0x00258a50` | Immutable ballot spec — stays on L1 |
| Ballot Instance | (601) | `0x00259a20` | Carries results after settlement |

Both tokens share the same 28-byte fingerprint suffix: `blake2b_224(namespace)`.

**To find them:** Query the policy ID for tokens whose asset name starts with
`00258a50` (definition) or `00259a20` (instance).

---

## 2. Verify the Ballot Definition

### 2.1 Read the (600) datum

The `(600)` token's inline datum contains:

```json
{
  "title": "...",
  "namespace": "vote.ekklesia.intersect.budget2026",
  "votingAuthority": "addr1...",
  "contentHash": "<blake2b_256 merkle root of questions>",
  "ballotCid": "<IPFS CID>",
  "questionCount": 58,
  "votingWindow": { "open": "...", "close": "..." },
  "endEpoch": 530
}
```

### 2.2 Fetch the full ballot from IPFS

Using `ballotCid`, fetch the full `BallotDefinition` JSON from IPFS.

### 2.3 Verify ballot content integrity

1. For each question in the full ballot, compute:
   `leafHash = blake2b_256(JSON.stringify(question))`
2. Build a merkle tree from all leaf hashes using the `content+path` mode
   (leaf hash = `blake2b_256(0x00 || contentHash || questionId_bytes)`)
3. Verify the computed root matches `contentHash` from the on-chain datum

If the roots match, the IPFS ballot content is authentic and untampered.

---

## 3. Verify the Vote Results

### 3.1 Read the (601) datum

After settlement, the `(601)` token's inline datum contains:

```json
{
  "BallotId": "<(600) mint tx hash>",
  "Status": 3,
  "ResultsHash": "<blake2b_256 of full results JSON>",
  "EvidenceCid": "<IPFS directory CID>",
  "TotalVoters": 847,
  "MerkleRoot": "<merkle root of all vote evidence>"
}
```

Status 3 = finalized.

### 3.2 Fetch the evidence directory from IPFS

Using `EvidenceCid`, fetch the IPFS directory. It contains:

```
/results.json              — raw unweighted tallies
/proof-package.json        — full merkle proof package
/proofs/<voterId>.json     — per-voter inclusion proofs
/votes/<tokenName>.json    — individual vote evidence bundles
```

### 3.3 Verify results hash

1. Fetch `results.json` from the evidence directory
2. Compute `blake2b_256(JSON.stringify(results))`
3. Compare to `ResultsHash` from the on-chain datum

If they match, the published results are authentic.

---

## 4. Verify Individual Votes

For each voter you want to audit:

### 4.1 Fetch the voter's evidence

Fetch `votes/<tokenName>.json` from the IPFS evidence directory. The evidence
contains:

```json
{
  "specVersion": "0.3.0",
  "surveyTxId": "<(600) mint tx hash>",
  "responderRole": "DRep",
  "answers": [{ "questionId": "q1", "selection": [0, 2] }],
  "ekklesia": {
    "voterId": "drep1...",
    "credentialHrp": "drep",
    "nonce": 3,
    "signedPayload": {
      "ballotId": "...",
      "nonce": 3,
      "votes": ["..."],
      "timestamp": "..."
    },
    "coseSign1Hex": "...",
    "coseKeyHex": "...",
    "signature": "...",
    "key": "..."
  }
}
```

### 4.2 Verify the vote hash

1. Compute `blake2b_256(JSON.stringify(evidence))`
2. This should match the `voteHash` stored on-chain in the voter's token datum
   (available in the Hydra ledger replay or the proof package's `contentHashHex`)

### 4.3 Verify the COSE signature

1. Extract `coseSign1Hex` and `coseKeyHex` from the evidence
2. Compute the expected signed message:
   `merkleRoot = blake2b_256(JSON.stringify(signedPayload))`
3. Verify the COSE_Sign1 signature:
   - The Ed25519 signature in COSE_Sign1 is valid
   - The signed payload matches the computed `merkleRoot`
   - The public key hash from COSE_Key matches the voter's bech32 credential

This proves the voter actually signed these specific selections with their
on-chain credential.

### 4.3a Verify script-based DRep signatures (if applicable)

If the evidence contains `ekklesia.nativeScript`, this is a script-based DRep.
Additional verification steps:

1. Compute `resolveNativeScriptHash(nativeScript)` from the script definition
2. Decode the voter's bech32 DRep ID — the first byte should be `0x23` (script)
   and the remaining bytes should match the computed script hash
3. For each witness in `ekklesia.witnesses[]`:
   - Verify the COSE_Sign1 Ed25519 signature is valid
   - Verify the signed payload matches the computed `merkleRoot`
   - Extract the public key hash from the witness
4. Collect all witness key hashes and verify they satisfy the script rules:
   - `{ type: "all" }` — all listed keys must have a witness
   - `{ type: "any" }` — at least one listed key must have a witness
   - `{ type: "atLeast", required: N }` — at least N listed keys must have witnesses
   - `{ type: "sig", keyHash }` — that specific key must have a witness
   - `{ type: "after"/"before", slot }` — time constraints (check against chain state)

### 4.4 Verify the nonce (replay protection)

The `nonce` in the signed payload must be strictly greater than any previous
version for this voter. The vote history chain (if available) shows the full
sequence. Each entry's nonce must be strictly increasing.

### 4.5 Verify ballot inclusion

Check that every `questionId` in the voter's selections exists in the ballot
definition (fetched in step 2.2) and that selection values are within the
valid ranges for each question's method type.

### 4.6 Verify merkle inclusion in evidence tree

1. Fetch the voter's proof from `proofs/<voterId>.json`:
   ```json
   {
     "voterId": "drep1...",
     "contentHashHex": "<voteHash>",
     "leafHashHex": "<computed leaf hash>",
     "merkleRoot": "<evidence tree root>",
     "proof": [{ "siblingHex": "..." }, "..."]
   }
   ```
2. Verify the inclusion proof:
   - Compute the leaf hash: `blake2b_256(0x00 || voteHash_bytes || voterId_bytes)`
   - Walk the proof steps, hashing with siblings at each level
     (use `0x01` prefix for internal nodes, sort siblings lexicographically)
   - The final hash should equal `merkleRoot`
3. Verify `merkleRoot` matches `MerkleRoot` from the on-chain `(601)` datum

This proves the voter's evidence was included in the finalized tally — it
was not omitted or added after the fact.

---

## 5. Full Re-Tally

To independently verify the published results:

1. Fetch all vote evidence files from the IPFS evidence directory
2. For each voter:
   a. Verify their COSE signature (step 4.3)
   b. Verify their merkle inclusion (step 4.6)
   c. Extract their selections
3. Aggregate raw counts per question per option
4. Compare your tallied results to `results.json`

The published results are **raw unweighted counts**. Ekklesia does not apply
stake-based weighting — this is intentionally external. To produce weighted
results, apply stake snapshots from the L1 chain state at the agreed-upon
epoch boundary.

---

## 6. Live Audit (During Voting Window)

If the voting middleware is running, the following API endpoints are available:

| Endpoint | Returns |
|----------|---------|
| `GET /ballot` | Current ballot definition |
| `GET /votes` | All votes cast so far (slim: hashes + CIDs) |
| `GET /voter/:voterId` | Single voter's latest state |
| `GET /audit` | Full bundle: ballot + all voter hashes/CIDs |
| `GET /audit/vote/:voterId` | Full evidence from IPFS + vote history chain + verification instructions |

Live audit relies on the middleware's cache and IPFS node. The API returns
the same data that will be pinned to IPFS at finalization.

---

## 7. Trust Model

Ekklesia votes occur inside a **Hydra state channel** operated by a designated
voting authority. Key trust properties:

**What the cryptography guarantees:**
- Each vote is signed by the voter's on-chain credential (COSE_Sign1)
- Vote evidence is hash-linked to on-chain datums (blake2b_256)
- The merkle tree proves no votes were added or omitted at finalization
- The nonce sequence proves vote ordering and prevents replays
- The ballot content hash proves questions/options weren't tampered with

**What requires trusting the voting authority:**
- The authority operates the Hydra head and submits transactions
- The authority must faithfully include all submitted votes
- The authority controls when the head opens and closes

**Script-based DRep credentials (native scripts):**
- Both key-based (`0x22`) and script-based (`0x23`) DRep credentials are supported.
- Key-based DReps provide a single COSE signature.
- Script-based DReps provide: (a) the native script definition, and (b) multiple
  COSE witness signatures — one per signing key needed to satisfy the script.
- The middleware verifies that the script hash matches the DRep credential, that
  each witness signature is valid, and that the witnesses satisfy the script rules
  (all-of, any-of, N-of-M).
- The evidence bundle stores all witness signatures and the script definition for
  independent auditor verification.

**Mitigation:**
- Every voter receives a cryptographic receipt (tx hash + vote hash + IPFS CID)
  at submission time. If a vote was acknowledged but is missing from the final
  evidence tree, the receipt is proof of omission.
- The full Hydra ledger can be replayed transaction-by-transaction to prove
  every state transition followed Cardano consensus rules.
- Multi-party head operation (multiple authorities validating each transaction)
  is a future goal that would eliminate single-operator trust.

---

## 8. Hash Algorithm Reference

All hashes in the Ekklesia system use **blake2b-256** (32 bytes output).

| What | Input | Used For |
|------|-------|----------|
| Ballot fingerprint | `blake2b_224(namespace)` | Token asset name suffix (28 bytes) |
| Ballot content hash | Merkle root of question hashes | Proves ballot integrity |
| Vote hash | `blake2b_256(JSON.stringify(evidence))` | Links on-chain datum to IPFS evidence |
| Merkle root (signed payload) | `blake2b_256(JSON.stringify(signedPayload))` | What the voter actually signs |
| Evidence merkle root | Merkle root of all vote hashes | Proves vote inclusion in tally |
| Results hash | `blake2b_256(JSON.stringify(fullResults))` | Proves results integrity |

**Merkle tree construction:**
- Leaf prefix: `0x00`
- Internal node prefix: `0x01`
- Sibling sort: lexicographic (by hex)
- Leaf mode: `content+path` (hash includes both content hash and name/ID)
- Schema: `lerna-labs/merkle-proof@v1`

---

## 9. Verification Checklist

For a complete audit, verify all of the following:

- [ ] `(600)` token exists on L1 under the voting authority's policy
- [ ] `(601)` token exists on L1 with status = 3 (finalized)
- [ ] Ballot IPFS content matches on-chain `contentHash` (merkle root)
- [ ] Results IPFS content matches on-chain `ResultsHash`
- [ ] Evidence merkle root matches on-chain `MerkleRoot`
- [ ] `TotalVoters` matches the number of vote evidence files
- [ ] For each voter:
  - [ ] COSE signature is valid against their credential
  - [ ] Vote hash matches `blake2b_256(evidence JSON)`
  - [ ] Merkle inclusion proof is valid against the evidence tree root
  - [ ] Nonce is strictly increasing (if history available)
  - [ ] Selections are valid for the ballot questions
- [ ] Independent re-tally matches published `results.json`
