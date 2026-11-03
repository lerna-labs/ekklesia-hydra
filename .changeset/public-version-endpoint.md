---
"@lerna-labs/hydra-middleware": minor
---

Add `GET /version`, served without the `x-api-key` header. It returns `{ name, version, gitSha, buildTime }` with `Cache-Control: public, max-age=60`. The commit and build time are read from a `build-info.json` beside the bundle, or from the `GIT_SHA` and `BUILD_TIME` environment variables when that file is missing. They are null when neither source sets them, and when the file exists but cannot be read. A version in the same source (`APP_VERSION` in the environment) replaces the package version. The endpoint has its own rate limit of 120 requests per minute, separate from the keyed routes.
