---
"@lerna-labs/hydra-middleware": minor
---

Wire the Ekklesia Release Manager bot into release automation. `release.yml` (main) and the new `prerelease.yml` (staging, continuous `rc` prerelease mode) now run as the bot instead of `github-actions[bot]`, and `publish.yml` no longer fires on prerelease tags.
