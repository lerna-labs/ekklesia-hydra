# Ekklesia Hydra Integration

Express API middleware that manages voting operations inside a Hydra L2
state channel on Cardano. Ballots are minted on L1, voters register and
cast votes inside the head via the Transaction Resolution Protocol, all
evidence pins to IPFS, and settlement decommits the finalized ballot
token back to L1 at an operator-chosen custody address.

## Docs

- **[`openapi.yaml`](openapi.yaml)** — full API reference (OpenAPI 3.1).
  Paste into any OpenAPI viewer (Swagger UI, Redoc, Scalar) for an
  interactive browser.
- **[`docs/SETTLEMENT.md`](docs/SETTLEMENT.md)** — canonical head close-out
  order (burn → finalize → close), per-step behaviour, and failure modes
  of skipping or reordering steps. **Read this before wiring up the
  settlement calls.**
- **[`docs/BALLOT_PAYLOAD.md`](docs/BALLOT_PAYLOAD.md)** — how to shape
  the `ballot` JSON payload passed to `POST /prepare`, including all
  voting methods (binary, ranked, weighted, etc.) and validation rules.
- **[`docs/AUDITOR_GUIDE.md`](docs/AUDITOR_GUIDE.md)** — step-by-step
  third-party verification of a finalized ballot.
- **[`docs/dependency-overrides.md`](docs/dependency-overrides.md)** — why
  each entry in `package.json`'s `overrides` block exists, and what it
  takes to remove one safely.
- **[`schemas/`](schemas/)** — JSON Schemas for the ballot, vote-evidence,
  and results IPFS payloads. Usable directly with Ajv / `check-jsonschema`
  or for generating types in any language.

## Build & run

```sh
npm install
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest unit suite
npm run build        # esbuild → dist/ (ESM)
npm run dev          # tsx watch (local development)
npm start            # node dist/index.js
npm run test:e2e     # vitest integration tests (requires live env)
```

Before opening a pull request, run `typecheck`, `test:unit` and `build`
locally; CI runs the same three. The end-to-end (`npm run test:e2e`) and
load (`npm run test:load`) suites need live infrastructure (a running Hydra
node, IPFS, Blockfrost access, etc.) that CI doesn't have, so they're run
manually against a real environment and aren't part of the pull request
gate.
