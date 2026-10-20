---
"@lerna-labs/hydra-middleware": patch
---

Fix `POST /start` no longer naming a missing `BLOCKFROST_API_KEY` after the hydra-sdk 2.0.2 update. The request now returns `503 CLIENT_INIT_FAILED` naming the variable, before the head-state check, instead of reaching the `409` for an already-open head.
