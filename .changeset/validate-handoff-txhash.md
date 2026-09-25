---
"@lerna-labs/hydra-middleware": patch
---

Validate the transaction hash on POST /prepare/handoff before it is used to build an outbound Blockfrost request, rejecting anything that is not exactly 64 lowercase hexadecimal characters with a 400 response.
