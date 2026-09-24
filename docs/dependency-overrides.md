# Dependency overrides

`package.json` carries an `overrides` block that forces a resolved version for
a package this project doesn't depend on directly. Each entry is one of two
kinds. An **advisory-floor** entry exists only to keep a transitive package
above a version an advisory covers, so it is written as a caret range: a
routine `npm install` then picks up the next patch release without anyone
revising the manifest. An exact pin on this kind of entry is a defect, since
it goes stale again the moment a new advisory lands inside the version it is
frozen on. A **functional** entry exists because a version boundary changes
runtime behavior independent of any advisory, and stays an exact pin because
a caret range could resolve to a version that reintroduces the problem the
pin exists to avoid.

Before touching an entry, check whether the direct dependency that pulls the
package in question has since shipped a version that resolves to a patched
copy on its own; if it has, bumping that direct dependency is preferable to
carrying the override, since an override only rewrites this project's own
installed tree, not what a consumer of a published package resolves.

## Functional pins

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

A caret range is the wrong shape here because npm's own bundled dependency
tree is not monotonic across releases: a newer npm version can ship an older,
vulnerable copy of a bundled package. The pin has to be revisited by hand
against each candidate npm release rather than left to float.

### `libsodium-sumo`

`libsodium-sumo: 0.7.15` has no advisory behind it; it is a functional pin.
`@meshsdk/core` pulls in more than one version of `@meshsdk/core-cst`, and
those versions bundle two separate copies of `libsodium-wrappers-sumo`.
Loading both copies makes `_sodium_init()` fail with "libsodium was not
correctly initialized", which breaks `MeshWallet` signing. Pinning a single
resolved version through `overrides` keeps one copy of the library in the
tree and avoids the double-load. A caret range does not fix this: the failure
comes from two different versions coexisting, not from either version being
too old, so the pin has to stay exact until the tree only pulls one
`@meshsdk/core-cst` version on its own.

## Advisory-floor overrides

Every entry below exists only to clear an advisory in a transitive
dependency, and every one is a caret range for that reason.

### `postcss`

`^8.5.28`. Originally pinned exactly at `8.5.23` to fix GHSA-fxqj-rqcc-2cmp
(an arbitrary `.map` file read when no `from` option is set, pulled in via
`vite`), a ceiling of `<= 8.5.22`. An exact pin one patch above a former
ceiling has no margin: the next advisory in the same package needs a person
to notice and re-pin by hand before it is covered. The caret range picks up
`8.5.28`, the current release, and keeps picking up whatever patch follows it.

### `mongoose`

`^9.10.1`. Originally pinned exactly at `9.7.2` to fix GHSA-664h-wqgq-64gw
(prototype pollution in update casting), a ceiling of `< 9.7.2`, pulled in
transitively through `@lerna-labs/ekklesia-helpers`. A Dependabot pull
request bumping this override to `9.8.1` was opened and then auto-closed
unmerged under this project's policy against automatic dependency pull
requests, and the override was left unchanged through three more minor
releases. The caret range now resolves to `9.10.1`, the current release.

### `path-to-regexp`

`^0.1.13`. Fixes GHSA-37ch-88jc-xwx2, a regular expression denial of service
triggered by multiple route parameters, ceiling `< 0.1.13`. Because the major
version is `0`, npm's caret rule locks the range to the `0.1.x` line only
(`^0.1.13` resolves `>= 0.1.13 < 0.2.0`), and `0.1.13` is currently the
newest release published in that line, so the caret and the exact pin
resolve identically today. The caret still picks up a future `0.1.14` on its
own if one is ever published, which the exact pin would not.

### `qs`

`^6.16.0`. Fixes GHSA-x5fp-wj9c-mxmx, an array-limit bypass via bracket-key
comma parsing, ceiling `>= 6.14.2, <= 6.15.3`. The override previously sat
exactly on that ceiling at `6.15.3`, which read as coverage while actually
sitting on the last vulnerable version; it was bumped to the exact version
`6.16.0` to clear it. That same `6.16.0` is also the fixed version for an
older, separate denial-of-service advisory, GHSA-4mjr-xmp4-gh2g (`>= 2.2.5,
< 6.16.0`), which this override cleared as a side effect of qs's own
upstream release moving past it, not because of anything done in this
project. The lesson from the first exact pin applies again: an exact pin one
version above a ceiling is the same failure shape twice, so this is now a
caret range.

### `body-parser`

`^1.20.6`. Fixes GHSA-v422-hmwv-36x6, a silently skipped size limit when an
invalid `limit` value is supplied, ceiling `< 1.20.6`, pulled in via
`express`. Exact pin converted to a caret range for the same reason as the
others above.

### `nanoid`

`^3.3.18`. Fixes GHSA-2v37-7h3g-55p8, an infinite loop on zero-size input in
a custom generator. Both packages that pull nanoid in, `@cardano-ogmios/client`
and `postcss`, load it with `require('nanoid')`. nanoid's own current release
is `6.0.1` and ships ESM only, so a `require()` call against it fails outright.
The caret range is written against the `3.x` line specifically (`^3.3.18`
resolves within `3.x`, never to `4.x`, `5.x`, or `6.x`) so a routine
reinstall stays on a version both consumers can load while still picking up
any future `3.x` patch release.

### Nested `js-yaml`, `ip-address`, `undici`

`@changesets/parse` pins `js-yaml` to `^4.3.1` and `read-yaml-file` pins it
to `^3.15.1`, fixing GHSA-5p4m-2wfm-xmqj (quadratic CPU consumption on
crafted input) in both of the two `js-yaml` major lines this tree resolves.
`ip-address` is pinned to `^10.3.1`, fixing GHSA-mwp4-54f8-5fhr (an
octal/decimal parsing mismatch that lets a malformed address slip past
validation). `undici` is pinned to `^6.27.0`, fixing a set of WebSocket
denial-of-service issues (GHSA-vxpw-j846-p89q, GHSA-vrm6-8vpv-qv8q,
GHSA-v9p9-hfj2-hcw8). All three were already caret ranges and needed no
change; each still resolves clear of every advisory against it.
