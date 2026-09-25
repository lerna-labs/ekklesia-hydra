---
"@lerna-labs/hydra-middleware": patch
---

Bump the postcss and mongoose dependency overrides to 8.5.28 and 9.10.1, and convert the path-to-regexp, qs, body-parser, and nanoid overrides from exact version pins to caret ranges, so each picks up its next patch release the next time `npm install` runs. This project ships as a Docker image, not a published npm package, so none of these changes affect a downstream consumer's own dependency resolution.
