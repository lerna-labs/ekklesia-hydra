// Tags the current commit with the version from package.json and pushes it.
// This repo releases as a container image, not an npm package, so this
// stands in for `changeset publish` — the pushed tag is what the existing
// GHCR publish workflow (.github/workflows/publish.yml) triggers from.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf8"));
const tag = `v${version}`;

execSync(`git tag ${tag}`, { stdio: "inherit" });
execSync(`git push origin ${tag}`, { stdio: "inherit" });

console.log(`Pushed tag ${tag}`);
