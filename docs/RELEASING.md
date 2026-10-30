# Releasing

Releases are cut from `main`. Automation never creates a version tag: the maintainer pushes a signed annotated tag, and publishing starts only from that tag.

1. Changesets on `main` opens and updates the "chore: release" pull request (branch `changeset-release/main`). Merging it bumps `package.json` and `CHANGELOG.md` and tags and publishes nothing.
2. The maintainer creates a signed annotated tag at the version commit on `main` and pushes it, where `X.Y.Z` is the version in `package.json` and `<version-commit-sha>` is the merge commit of the "chore: release" pull request:

   ```
   git fetch origin main
   git tag -s vX.Y.Z -m "vX.Y.Z" <version-commit-sha>
   git push origin vX.Y.Z
   ```

3. The tag push triggers `publish.yml`. Its first job runs `.github/scripts/verify-release-tag.sh`, and the image build only starts if every check passes:
   - the ref is an annotated tag object, not a lightweight tag;
   - GitHub reports the tag's signature as verified;
   - the tagged commit is an ancestor of `main`;
   - the tag equals `v` plus the version in `package.json` at the tagged commit.
4. The workflow then builds and pushes the image to GHCR and creates the GitHub Release with the `CHANGELOG.md` section as notes, unless the release already exists.

The verification script can be run locally against an existing tag:

```
GITHUB_REPOSITORY=lerna-labs/ekklesia-hydra GH_TOKEN=$(gh auth token) .github/scripts/verify-release-tag.sh vX.Y.Z
```

Release candidates are built from `staging` by `staging-rc.yml` and carry no version tag.
