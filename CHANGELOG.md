# @lerna-labs/hydra-middleware

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
