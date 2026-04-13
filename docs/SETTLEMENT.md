# Closing a Hydra head — canonical settlement order

This document describes the **only correct sequence** for closing out a
Hydra head managed by the Ekklesia middleware after voting has concluded.

Every settlement endpoint reads ballot identity (ballotId / ballotPolicy /
ballotToken / resultsAddress) from the cache populated by `POST /start`.
Request bodies carry no identity fields — one head, one ballot.

---

## The three-step flow

```
   ┌─────────────────────────────────────────────────────┐
   │  1. POST /settle/burn                               │
   │     ↻ loop until `data.remaining === 0`             │
   │     (skip only if no votes were cast)               │
   └─────────────────────────────┬───────────────────────┘
                                 │
   ┌─────────────────────────────▼───────────────────────┐
   │  2. POST /settle/finalize                           │
   │     tally → IPFS → in-head finalize tx              │
   │     writes BallotResult datum into (601)            │
   └─────────────────────────────┬───────────────────────┘
                                 │
   ┌─────────────────────────────▼───────────────────────┐
   │  3. POST /settle/close                              │
   │     body: { "closeToken": "…" }                     │
   │     drives Close → FanoutPossible → Fanout → Final  │
   │     (601) lands on L1 at resultsAddress             │
   └─────────────────────────────────────────────────────┘
```

### Step 1 — `POST /settle/burn`

Burns every voter token still living in the head ledger. The authoritative
voter list comes from the head UTxO set, not the in-memory cache — stale
cache entries from a previous run cannot poison this step.

On the first call, a pre-burn ledger snapshot is written to disk
(`$IPFS_STAGING_DIR/pre-burn-ledger.json`). This snapshot is the source of
truth for step 2 and is **preserved across retries** — subsequent burn
calls will not overwrite it.

```
Body:    {}
Returns: { burned, failed, remaining, total }
```

**Call this endpoint repeatedly until `remaining === 0`.** The middleware
throttles concurrent in-head submissions (`MAX_IN_FLIGHT=100`), so a
snapshot with more voter tokens than the throttle window needs multiple
invocations.

A minimal loop:

```sh
while true; do
  response=$(curl -s -X POST -H "x-api-key: $X_API_KEY" \
                  http://$HOST/settle/burn)
  remaining=$(echo "$response" | jq -r '.data.remaining')
  echo "remaining: $remaining"
  [ "$remaining" = "0" ] && break
done
```

### Step 2 — `POST /settle/finalize`

Precondition (server-enforced): zero voter tokens remain in the head. If
step 1 hasn't reached `remaining === 0`, this endpoint returns:

```json
{ "status": "ERROR", "code": "INVALID_INPUT", "message": "Cannot finalize: N voter token(s) still in head…" }
```

When the precondition is satisfied, step 2:

1. Loads the pre-burn ledger snapshot.
2. Verifies each voter's local evidence file against the on-chain voteHash
   recorded at burn time. Voters whose evidence can't be matched are
   excluded from the results with a reason; included voters are tallied.
3. Pins the complete evidence directory (results JSON + per-voter proofs +
   vote history chains) to IPFS.
4. Submits the in-head `finalize_ballot` transaction that spends the (601)
   UTxO and re-emits it at the cached `resultsAddress` with a `BallotResult`
   inline datum containing `ballotId` + `resultsHash` + `evidenceCid` +
   `merkleRoot`.

```
Body:    {}
Returns: { txHash, resultsHash, evidenceDirectoryCid,
           evidenceMerkleRoot, totalVoters, excludedVoters? }
```

### Step 3 — `POST /settle/close`

Drives the head through the full close lifecycle:

```
Open → Closed → (contestation period) → FanoutPossible → Final
```

The handler listens on the shared HydraMonitor WebSocket and sends `Fanout`
automatically when the head reaches `FANOUT_POSSIBLE`. On fanout, the
(601) UTxO is materialized on L1 at the address it held in the final head
ledger — i.e. the `resultsAddress` set by step 2.

```
Body:    { "closeToken": "…" }
Returns: { status: "FINAL", message? }
```

Timeout: up to 10 minutes for `FINAL` (contestation periods on preview /
preprod networks can run to several minutes).

---

## Failure modes of skipping or reordering steps

| Wrong order / skipped step | What actually happens |
|---|---|
| Close first, burn later | Voter tokens fan out to L1 under the voter-token minting policy — they become stranded L1 dust. The policy was never designed to hold value off-head. |
| Finalize before burn | `/settle/finalize` refuses with `INVALID_INPUT` citing the remaining voter count. |
| Close before finalize | The (601) fans out carrying its **placeholder** datum (`['', '', '', '']`) instead of the finalized results. The ballot is effectively unrecoverable — results exist on IPFS but no on-chain datum points to them. |
| Burn run short (not zero) | Subsequent steps fail. Resume the burn loop; the pre-burn ledger is preserved. |
| Re-running burn after finalize | Nothing to burn (voter tokens are already gone). Returns `remaining: 0` and is a no-op. |

**Aborting an empty head** (no register, no vote happened in the head):
skip directly to step 3. The (601) fans out with its original placeholder
datum, which is the correct state for "ballot prepared but never ran."

---

## Deprecated shortcuts

| Endpoint | Status | Use instead |
|---|---|---|
| `POST /settle` | Deprecated | The three-step flow above. |
| `POST /close` | Deprecated | `POST /settle/close`. |
| `POST /finalize` | Live but standalone | `POST /settle/finalize` (the stepped version reconciles against the head ledger). |
| `POST /count` | Live but standalone | `POST /settle/burn` (the stepped version is idempotent + writes the pre-burn snapshot). |

`POST /settle` still runs the whole orchestration in a single request but
is prone to HTTP timeouts on larger voter sets and gives no per-phase
visibility when a partial failure occurs. New integrations should always
use the stepped flow.

---

## Post-settlement state

After step 3 returns `FINAL`:

- The Hydra head is fully closed and fanned out.
- The **(601) ballot instance token** sits on L1 at `resultsAddress` with
  the `BallotResult` inline datum. `resultsHash` points (via IPFS) at the
  tally JSON; `evidenceCid` points at the directory containing every
  voter's evidence file and merkle proof.
- The **(600) ballot definition token** is wherever `/prepare/handoff`
  placed it (or still at the admin address if handoff wasn't called).
- Every **voter token** was burned during step 1.

Anyone with an IPFS gateway can now audit the result:

1. Read the on-chain (601) datum — `resultsHash` + `evidenceCid`.
2. Fetch `evidenceCid` → IPFS directory.
3. `blake2b_256` the `results.json` inside and check it matches
   `resultsHash`.
4. For any specific voter, fetch their evidence file, verify the COSE
   signature, and check that `blake2b_256(evidence) === voteHash` in
   their historical chain.

See `docs/AUDITOR_GUIDE.md` for the full verification procedure.
