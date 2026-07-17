# Contributing

Thanks for your interest in contributing to ekklesia-hydra.

## Branching

`development` is the integration branch — branch from it, and open your pull
request back against it. Changes flow `development` → `staging` → `main` as
they're promoted toward release; `main` is what ships.

## Local checks

Before opening a pull request, run these locally:

```bash
npm run typecheck    # tsc --noEmit
npm run test:unit    # vitest unit suite
npm run build        # esbuild -> dist/
```

These are also what CI runs on your pull request.

The end-to-end (`npm run test:e2e`) and load (`npm run test:load`) suites
require live infrastructure (a running Hydra node, IPFS, Blockfrost access,
etc.) that CI doesn't have. They're run manually against a real environment
and are **not** part of the default PR gate.

## Changelog entries

Every change needs a changelog entry, added via `npx changeset` in your
branch. CI fails a pull request into `development` that's missing one unless
it's labeled to skip.

## Filing issues

Issues for the Ekklesia platform are tracked centrally in the
[ekklesia-docs](https://github.com/Lerna-Labs/ekklesia-docs) repository, not
here — please file bugs and feature requests there.
