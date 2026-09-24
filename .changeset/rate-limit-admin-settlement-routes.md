---
"@lerna-labs/hydra-middleware": minor
---

Add rate limiting to the expensive admin and settlement route handlers that write to the Hydra head or walk the evidence directory on disk: POST /start, POST /flush-cache, GET /audit/full, POST /finalize, POST /settle/burn, POST /settle/finalize, GET /results, and POST /settle. Limits are configurable via ADMIN_RATE_LIMIT_WINDOW_MS, ADMIN_RATE_LIMIT_MAX, READ_RATE_LIMIT_WINDOW_MS, and READ_RATE_LIMIT_MAX, with defaults sized for normal operator use (a handful of calls, including retries, per ballot lifecycle) while blocking a request flood.
