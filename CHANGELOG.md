# @lerna-labs/hydra-middleware

## 1.1.1

### Patch Changes

- 0158977: Patch three security vulnerabilities in dependencies without upgrading Express to a new major version. Updates lodash from 4.17.23 to 4.18.1 to fix prototype pollution and code injection in the template helper, updates qs from 6.13.0 to 6.15.3 to fix a denial of service caused by an array limit bypass, and pins path-to-regexp to 0.1.13 to fix a regular expression denial of service triggered by multiple route parameters.

## 1.1.0

### Minor Changes

- c213421: Wire the Ekklesia Release Manager bot into release automation. Version bumps, release PRs, and tags now run as the Release Manager App instead of github-actions[bot]. Features accumulate on development, staging builds ephemeral snapshot release-candidate images for the preprod testnet, and merges to main cut the versioned release and publish the production image to GHCR.
