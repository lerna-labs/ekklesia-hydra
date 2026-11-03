---
"@lerna-labs/hydra-middleware": patch
---

Update @lerna-labs/hydra-sdk to 2.0.2 and @meshsdk/core to 1.9.1, which no longer pull the npm package into the production dependency tree, and remove the npm override. The undici, ip-address, brace-expansion, http-cache-semantics and postcss-selector-parser copies bundled under node_modules/npm leave the lockfile.
