// Tags the current commit with the version from package.json and pushes it.
// This repo releases as a container image, not an npm package, so this
// stands in for `changeset publish` — the pushed tag is what the existing
// GHCR publish workflow (.github/workflows/publish.yml) triggers from.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf8"));
const tag = `v${version}`;

// changesets/action runs this publish step on every push to main that has no
// pending changesets, not only right after a version bump. Skip if the tag
// already exists so those pushes are a no-op instead of a failed re-tag.
const existing = execSync(`git tag -l ${tag}`, { encoding: "utf8" }).trim();
if (existing) {
  console.log(`Tag ${tag} already exists; nothing to publish.`);
  process.exit(0);
}

execSync(`git tag ${tag}`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });

console.log(`Pushed tag ${tag}`);
