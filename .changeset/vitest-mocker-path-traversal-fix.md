---
"@lerna-labs/hydra-middleware": patch
---

Update the locked `vitest` and `@vitest/mocker` resolutions to 4.1.11 to fix a path traversal / arbitrary file read reachable through a redirected mock (GHSA-82fw-gwwq-j7x9). `vitest` is a development-only dependency, so this does not touch the published artifact.
