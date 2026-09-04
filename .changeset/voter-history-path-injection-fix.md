---
"@lerna-labs/hydra-middleware": patch
---

Reject a voterId that isn't a well-formed, known-role bech32 identifier before using it to build the vote history file path, closing a path injection route through POST /vote and GET /audit/vote/:voterId.
