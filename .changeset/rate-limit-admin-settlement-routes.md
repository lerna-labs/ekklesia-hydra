---
"@lerna-labs/hydra-middleware": minor
---

Add rate limiting to the expensive admin and settlement route handlers that write to the Hydra head or walk the evidence directory on disk: POST /start, POST /flush-cache, GET /audit/full, POST /finalize, POST /settle/burn, POST /settle/finalize, GET /results, and POST /settle. Defaults are sized for normal operator use (a handful of calls, including retries, per ballot lifecycle) while blocking a request flood.
