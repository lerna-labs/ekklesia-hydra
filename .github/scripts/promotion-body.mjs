// Builds a promotion PR body that lists the pending changesets, so the
// accumulator PR shows which changes are queued for the next release.
// Usage: node promotion-body.mjs <staging|main>
import { readdirSync, readFileSync } from "node:fs";

const target = process.argv[2];
const intros = {
  staging:
    "Merging this promotes the queued changes into `staging`, which builds a release-candidate image for the preprod testnet. Version bumps are cut later, on `main`.",
  main:
    "Merging this promotes the tested release candidate into `main`, where the Release Manager opens a Version Packages PR that cuts the production version, image, and GitHub Release.",
};
const intro = intros[target] ?? "";

const items = [];
try {
  for (const f of readdirSync(".changeset")) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const c = readFileSync(`.changeset/${f}`, "utf8");
    const m = c.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!m) continue;
    const bump = (m[1].match(/\b(major|minor|patch)\b/) || [])[1] || "change";
    const summary = m[2].trim().split(/\r?\n/)[0].trim();
    if (summary) items.push(`- **${bump}**: ${summary}`);
  }
} catch {}

const list = items.length ? items.join("\n") : "_No pending changesets._";
process.stdout.write(`${intro}\n\n### Changes queued (${items.length})\n\n${list}\n`);
