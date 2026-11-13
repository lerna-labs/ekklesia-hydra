# @lerna-labs/hydra-middleware

## 1.2.0

### Minor Changes

- 532b3ed: Extend the keyed `GET /health` response, additively, with `ballot` (`ballotId`, `policyId`), `voters` (`registered`, `voted`), `queue` (`depth`, `built`, `submitted`, `accepted`, `confirmed`, `failed`), `snapshotNumber` and `probes` for IPFS, the TRP and Blockfrost. `voters.registered` counts distinct voter tokens in the head snapshot and is null when the head is not open. Each probe has a 3-second timeout, is cached for 15 seconds and reports one of a fixed set of reasons, never a URL or key. A failing probe does not change the response status.
- b6bb16d: Add `GET /version`, served without the `x-api-key` header. It returns `{ name, version, gitSha, buildTime }` with `Cache-Control: public, max-age=60`. The commit and build time are read from a `build-info.json` beside the bundle, or from the `GIT_SHA` and `BUILD_TIME` environment variables when that file is missing. They are null when neither source sets them, and when the file exists but cannot be read. A version in the same source (`APP_VERSION` in the environment) replaces the package version. The endpoint has its own rate limit of 120 requests per minute, separate from the keyed routes.
- cc347ee: Add rate limiting to the expensive admin and settlement route handlers that write to the Hydra head or walk the evidence directory on disk: POST /start, POST /flush-cache, GET /audit/full, POST /finalize, POST /settle/burn, POST /settle/finalize, GET /results, and POST /settle. Defaults are sized for normal operator use (a handful of calls, including retries, per ballot lifecycle) while blocking a request flood.

### Patch Changes

- 23fef71: Refresh the lockfile so axios, pulled in through @meshsdk/provider, resolves 1.20.0, the release that fixes the axios advisories published 2026-09-30.
- 7652344: Fix the five L1 ballot handlers (`/prepare`, `/prepare/cancel`, `/prepare/update`, `/prepare/handoff`, `/sweep`) casting an unset `BLOCKFROST_API_KEY` to a string and passing it straight into `BlockfrostProvider`/`getAdmin`. A missing key now returns `503 CLIENT_INIT_FAILED` naming the variable, instead of surfacing as a Blockfrost authentication failure.
- 711645d: Fix a tainted-format-string sink: request-supplied identifiers were interpolated directly into the first argument of `console.warn`/`console.error` calls that also took a trailing argument, so a `%`-directive placed in the identifier could be parsed by `util.format` and consume or garble that trailing argument instead of being printed literally. Affected call sites in the audit, settlement, and transaction queue logging now pass the identifier as a `%s`-substituted argument instead of baking it into the format string.
- 633dc4e: Update @lerna-labs/hydra-sdk to 2.0.2 and @meshsdk/core to 1.9.1, which no longer pull the npm package into the production dependency tree, and remove the npm override. The undici, ip-address, brace-expansion, http-cache-semantics and postcss-selector-parser copies bundled under node_modules/npm leave the lockfile.
- 072c7d1: Bump the postcss and mongoose dependency overrides to 8.5.28 and 9.10.1, and convert the path-to-regexp, qs, body-parser, and nanoid overrides from exact version pins to caret ranges, so each picks up its next patch release the next time `npm install` runs. This project ships as a Docker image, not a published npm package, so none of these changes affect a downstream consumer's own dependency resolution.
- eaefa1a: Raise the body-parser override to ^1.20.9 and the undici override to ^6.29.1, the patched releases for GHSA-27r3-jxmh-p828, GHSA-xjj6-f33q-929c and GHSA-4qv8-2p9j-2685. The lockfile now resolves body-parser 1.20.9 and undici 6.29.1.
- 04dff19: Raise the ip-address override to ^10.7.1 and the nested js-yaml overrides to ^4.3.2 and ^3.15.2, the patched releases for GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw and GHSA-2883-xcg3-v3hh. The previous floors sat below those releases, so a fresh resolve onto a floor would have landed inside the vulnerable range. The lockfile already resolves ip-address 10.7.2, js-yaml 4.3.2 and js-yaml 3.15.2.
- 5884ed5: Raise the ip-address override to ^10.7.4, the patched release for GHSA-rxp7-6hxx-x8q5, and raise vitest to ^4.1.12, which brings vite 8.3.5 and @vitest/mocker 4.1.12 into the lockfile in place of vite 8.3.0 and @vitest/mocker 4.1.11, clearing GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg, GHSA-9jrq-w75r-8gcw, GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp. The lockfile resolves ip-address 10.7.4.
- f1bbac1: Raise the qs override to ^6.16.1, the patched release for GHSA-6pq8-jhm2-2vcw. The lockfile now resolves qs 6.17.1.
- 349dcd6: Raise the undici and ip-address dependency overrides to ^6.28.1 and ^10.5.1, the patched releases for GHSA-3wwx-pv8p-q78v and GHSA-2vr4-cq9g-pvrc. The lockfile now resolves undici 6.29.0 and ip-address 10.7.2.
- acf0870: Refresh the transitive follow-redirects dependency to 1.16.2, the patched release for GHSA-mrwp-f3q8-3g9p. The lockfile previously resolved 1.16.1.
- 3480553: Refresh the lockfile so proxy-addr resolves 2.0.8, pbkdf2 resolves 3.1.7, and source-map-js resolves 1.2.2, the releases that fix GHSA-jqcg-44mw-7w3h, GHSA-477h-4r7f-fvrx, and GHSA-68fv-2mgg-jv7q.
- 2e3cfb6: Fix `POST /start` no longer naming a missing `BLOCKFROST_API_KEY` after the hydra-sdk 2.0.2 update. The request now returns `503 CLIENT_INIT_FAILED` naming the variable, before the head-state check, instead of reaching the `409` for an already-open head.
- d28b0d7: Resolve the vote history file path for a voterId and verify it still lands inside the vote history directory before every read or write, on top of the existing bech32 role allowlist, closing the remaining js/path-injection findings on POST /vote and GET /audit/vote/:voterId.

## 1.1.2

### Patch Changes

- 74e5eb8: Pin transitive dependencies to fix open advisories: nanoid infinite loop on zero-size input (GHSA-2v37-7h3g-55p8), qs array-limit bypass via bracket-key comma parsing (GHSA-x5fp-wj9c-mxmx), PostCSS arbitrary `.map` file read when no `from` option is set (GHSA-fxqj-rqcc-2cmp), Mongoose prototype pollution in update casting (GHSA-664h-wqgq-64gw), and body-parser silently skipping its size limit on an invalid `limit` value (GHSA-v422-hmwv-36x6).
- ac0859d: Raise the `tsx` floor to 4.23.1 so `npm run dev` starts from source. Older tsx versions resolve `tx3-sdk`'s ESM entry as CommonJS and fail on the `TRPClient` named import; tsx 4.23.1 fixed the underlying module-format detection. The production build, which bundles with esbuild, was never affected.
- 4cbec10: Fix POST /start hanging until client timeout when a required Wrangler environment variable (e.g. BLOCKFROST_API_KEY) is unset. The handler now validates request shape first, then constructs its Hydra client inside a try/catch, returning a 503 CLIENT_INIT_FAILED response naming the missing configuration instead of leaving the request unanswered.
- 80d20a0: Update the bundled tar dependency to a release that fixes a decompression denial-of-service issue.
- 516e31e: Bump transitive dependencies to fix open high-severity advisories: picomatch ReDoS (GHSA-c2c7-rcm5-vvqj), pacote DoS (GHSA-w4pp-8pjf-rmxw), brace-expansion DoS (GHSA-rgw5-rvv9-x895, GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg), js-yaml quadratic CPU consumption (GHSA-5p4m-2wfm-xmqj), ip-address octal/decimal parsing mismatch (GHSA-mwp4-54f8-5fhr), sigstore certificate constraint bypass (GHSA-52v5-jr5w-gjxr), and undici WebSocket denial-of-service issues (GHSA-vxpw-j846-p89q, GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8).
- 96b9efe: Validate the transaction hash on POST /prepare/handoff before it is used to build an outbound Blockfrost request, rejecting anything that is not exactly 64 lowercase hexadecimal characters with a 400 response.
- 94e8c69: Update the locked `vitest` and `@vitest/mocker` resolutions to 4.1.11 to fix a path traversal / arbitrary file read reachable through a redirected mock (GHSA-82fw-gwwq-j7x9). `vitest` is a development-only dependency, so this does not touch the published artifact.
- 4e4404e: Reject a voterId that isn't a well-formed, known-role bech32 identifier before using it to build the vote history file path, closing a path injection route through POST /vote and GET /audit/vote/:voterId.

## 1.1.1

### Patch Changes

- 0158977: Patch three security vulnerabilities in dependencies without upgrading Express to a new major version. Updates lodash from 4.17.23 to 4.18.1 to fix prototype pollution and code injection in the template helper, updates qs from 6.13.0 to 6.15.3 to fix a denial of service caused by an array limit bypass, and pins path-to-regexp to 0.1.13 to fix a regular expression denial of service triggered by multiple route parameters.

## 1.1.0

### Minor Changes

- c213421: Wire the Ekklesia Release Manager bot into release automation. Version bumps, release PRs, and tags now run as the Release Manager App instead of github-actions[bot]. Features accumulate on development, staging builds ephemeral snapshot release-candidate images for the preprod testnet, and merges to main cut the versioned release and publish the production image to GHCR.
