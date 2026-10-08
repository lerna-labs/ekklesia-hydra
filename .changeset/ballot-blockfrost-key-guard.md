---
"@lerna-labs/hydra-middleware": patch
---

Fix the five L1 ballot handlers (`/prepare`, `/prepare/cancel`, `/prepare/update`, `/prepare/handoff`, `/sweep`) casting an unset `BLOCKFROST_API_KEY` to a string and passing it straight into `BlockfrostProvider`/`getAdmin`. A missing key now returns `503 CLIENT_INIT_FAILED` naming the variable, instead of surfacing as a Blockfrost authentication failure.
