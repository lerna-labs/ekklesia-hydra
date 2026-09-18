---
"@lerna-labs/hydra-middleware": patch
---

Pin transitive dependencies to fix open advisories: nanoid infinite loop on zero-size input (GHSA-2v37-7h3g-55p8), qs array-limit bypass via bracket-key comma parsing (GHSA-x5fp-wj9c-mxmx), PostCSS arbitrary `.map` file read when no `from` option is set (GHSA-fxqj-rqcc-2cmp), Mongoose prototype pollution in update casting (GHSA-664h-wqgq-64gw), and body-parser silently skipping its size limit on an invalid `limit` value (GHSA-v422-hmwv-36x6).
