---
"@lerna-labs/hydra-middleware": patch
---

Raise the ip-address override to ^10.7.1 and the nested js-yaml overrides to ^4.3.2 and ^3.15.2, the patched releases for GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw and GHSA-2883-xcg3-v3hh. The previous floors sat below those releases, so a fresh resolve onto a floor would have landed inside the vulnerable range. The lockfile already resolves ip-address 10.7.2, js-yaml 4.3.2 and js-yaml 3.15.2.
