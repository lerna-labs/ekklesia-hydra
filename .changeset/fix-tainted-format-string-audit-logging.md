---
"@lerna-labs/hydra-middleware": patch
---

Fix a tainted-format-string sink: request-supplied identifiers were interpolated directly into the first argument of `console.warn`/`console.error` calls that also took a trailing argument, so a `%`-directive placed in the identifier could be parsed by `util.format` and consume or garble that trailing argument instead of being printed literally. Affected call sites in the audit, settlement, and transaction queue logging now pass the identifier as a `%s`-substituted argument instead of baking it into the format string.
