---
"@lerna-labs/hydra-middleware": patch
---

Patch three security vulnerabilities in dependencies without upgrading Express to a new major version. Updates lodash from 4.17.23 to 4.18.1 to fix prototype pollution and code injection in the template helper, updates qs from 6.13.0 to 6.15.3 to fix a denial of service caused by an array limit bypass, and pins path-to-regexp to 0.1.13 to fix a regular expression denial of service triggered by multiple route parameters.
