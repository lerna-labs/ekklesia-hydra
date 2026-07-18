# @lerna-labs/hydra-middleware

## 1.1.0

### Minor Changes

- c213421: Wire the Ekklesia Release Manager bot into release automation. Version bumps, release PRs, and tags now run as the Release Manager App instead of github-actions[bot]. Features accumulate on development, staging builds ephemeral snapshot release-candidate images for the preprod testnet, and merges to main cut the versioned release and publish the production image to GHCR.
