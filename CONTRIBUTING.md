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

## Dependency overrides

`package.json` carries an `overrides` block that forces a resolved version
for a package this project doesn't depend on directly. Every entry exists to
close a vulnerability in a transitive dependency, with one exception noted
below. Before touching an entry, check whether the direct dependency that
pulls the package in question has since shipped a version that resolves to a
patched copy on its own; if it has, bumping that direct dependency is
preferable to carrying the override, since an override only rewrites this
project's own installed tree, not what a consumer of a published package
resolves.

### `npm`

This is the one entry that looks like dead weight and isn't. Three copies of
`@cardano-sdk/crypto` in this tree (pulled in through `@meshsdk/provider` and
its own nested `@cardano-sdk/input-selection` and `@cardano-sdk/key-management`)
declare `npm: ^9.3.0` as a plain runtime dependency. Left unconstrained, that
resolves to npm 9.9.4, which bundles `tar` 6.2.1. That `tar` version falls
inside GHSA-23hp-3jrh-7fpw / CVE-2026-59873, a critical decompression denial
of service (an attacker-supplied archive with a small compressed size and an
oversized claimed content length exhausts disk space during extraction),
fixed in `tar` 7.5.19. The vulnerable range is `<= 7.5.18`.

No override on `tar` itself can reach this. npm ships its own dependencies
bundled inside its package tarball: every package under
`node_modules/npm/node_modules/` is recorded in the lockfile with
`"inBundle": true` and no `resolved` field, and `overrides` cannot rewrite a
bundled dependency. The only available fix is bumping the package that does
the bundling, which is why the override targets `npm` and not `tar`.

`npm: 11.19.1` resolves the bundled copy to `tar` 7.5.22, outside the
vulnerable range. This is verifiable directly: the `staging` and `main`
branches carry no `npm` override and resolve
`node_modules/npm/node_modules/tar` to 6.2.1; `development` resolves it to
7.5.22. Removing the override reintroduces the critical without changing a
single line outside `package.json`.

### `libsodium-sumo`

`libsodium-sumo: 0.7.15` has no advisory behind it in the GitHub Advisory
Database or anywhere else searched while writing this section. It was added
to fix a runtime version mismatch between `libsodium-sumo` and another
package in this tree, not a security issue, and the commit that added it
does not name which package required the match or what the mismatch broke.
Until someone restates that requirement precisely, treat this entry as
unverified rather than as either a safe removal target or a confirmed ABI
pin.

### Everything else

The remaining entries (`path-to-regexp`, `qs`, `nanoid`, `postcss`,
`mongoose`, `body-parser`, the nested `js-yaml` pins under
`@changesets/parse` and `read-yaml-file`, `ip-address`, and `undici`) each
close a specific advisory in a transitive dependency; the advisory IDs are in
this project's `CHANGELOG.md` under the change that added or moved each one.

## Filing issues

Issues for the Ekklesia platform are tracked centrally in the
[ekklesia-docs](https://github.com/Lerna-Labs/ekklesia-docs) repository, not
here — please file bugs and feature requests there.
