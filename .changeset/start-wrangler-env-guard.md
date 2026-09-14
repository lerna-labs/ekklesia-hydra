---
"@lerna-labs/hydra-middleware": patch
---

Fix POST /start hanging until client timeout when a required Wrangler environment variable (e.g. BLOCKFROST_API_KEY) is unset. The handler now validates request shape first, then constructs its Hydra client inside a try/catch, returning a 503 CLIENT_INIT_FAILED response naming the missing configuration instead of leaving the request unanswered.
