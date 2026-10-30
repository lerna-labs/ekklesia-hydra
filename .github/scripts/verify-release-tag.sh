#!/usr/bin/env bash
# Verifies a release tag before anything is published from it.
# Usage: verify-release-tag.sh <tag>
# Reads GITHUB_REPOSITORY (owner/name) and GH_TOKEN from the environment.
set -euo pipefail

TAG="${1:?usage: verify-release-tag.sh <tag>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

fail() {
  echo "::error::$1"
  exit 1
}

ref_type=$(gh api "repos/$REPO/git/ref/tags/$TAG" --jq .object.type 2>/dev/null) ||
  fail "Tag $TAG was not found in $REPO."
[ "$ref_type" = "tag" ] ||
  fail "Tag $TAG is a lightweight tag. Release tags must be signed annotated tags (git tag -s)."

object_sha=$(gh api "repos/$REPO/git/ref/tags/$TAG" --jq .object.sha)
tag_json=$(gh api "repos/$REPO/git/tags/$object_sha")
verified=$(jq -r .verification.verified <<<"$tag_json")
if [ "$verified" != "true" ]; then
  reason=$(jq -r .verification.reason <<<"$tag_json")
  fail "GitHub does not report the signature on tag $TAG as verified (reason: $reason)."
fi

target_type=$(jq -r .object.type <<<"$tag_json")
[ "$target_type" = "commit" ] ||
  fail "Tag $TAG points at a $target_type, not a commit."

commit=$(jq -r .object.sha <<<"$tag_json")
expected="${GITHUB_SHA:-$commit}"
[ "$commit" = "$expected" ] ||
  fail "Signed tag $TAG points at $commit, but the pushed commit is $expected."

git cat-file -e "$commit^{commit}" 2>/dev/null ||
  fail "Commit $commit of tag $TAG is not present in the local clone."

git fetch --quiet origin main
git merge-base --is-ancestor "$commit" origin/main ||
  fail "Tag $TAG points at $commit, which is not an ancestor of origin/main."

version=$(git show "$commit:package.json" | jq -r .version)
[ "$TAG" = "v$version" ] ||
  fail "Tag $TAG does not match version $version in package.json at $commit (expected v$version)."

echo "Tag $TAG is a verified signed annotated tag at $commit on main."
