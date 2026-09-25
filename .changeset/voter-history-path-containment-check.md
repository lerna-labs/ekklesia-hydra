---
"@lerna-labs/hydra-middleware": patch
---

Resolve the vote history file path for a voterId and verify it still lands inside the vote history directory before every read or write, on top of the existing bech32 role allowlist, closing the remaining js/path-injection findings on POST /vote and GET /audit/vote/:voterId.
