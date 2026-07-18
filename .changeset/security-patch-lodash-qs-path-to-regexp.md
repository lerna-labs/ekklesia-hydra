---
"@lerna-labs/hydra-middleware": patch
---

Patch three high/moderate-severity vulnerabilities without an Express major upgrade: `lodash` 4.17.23→4.18.1 (prototype pollution, code injection in `_.template`), `qs` 6.13.0→6.15.3 (DoS via arrayLimit bypass), and `path-to-regexp` 0.1.12→0.1.13 pinned via `overrides` (ReDoS via multiple route parameters — 0.1.13 is a same-line backport patch, not the 8.x rewrite Express 5 requires).
