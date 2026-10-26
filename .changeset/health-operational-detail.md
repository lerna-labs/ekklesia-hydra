---
"@lerna-labs/hydra-middleware": minor
---

Extend the keyed `GET /health` response, additively, with `ballot` (`ballotId`, `policyId`), `voters` (`registered`, `voted`), `queue` (`depth`, `built`, `submitted`, `accepted`, `confirmed`, `failed`), `snapshotNumber` and `probes` for IPFS, the TRP and Blockfrost. `voters.registered` counts distinct voter tokens in the head snapshot and is null when the head is not open. Each probe has a 3-second timeout, is cached for 15 seconds and reports one of a fixed set of reasons, never a URL or key. A failing probe does not change the response status.
