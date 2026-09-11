---
"@lerna-labs/hydra-middleware": patch
---

Raise the `tsx` floor to 4.23.1 so `npm run dev` starts from source. Older tsx versions resolve `tx3-sdk`'s ESM entry as CommonJS and fail on the `TRPClient` named import; tsx 4.23.1 fixed the underlying module-format detection. The production build, which bundles with esbuild, was never affected.
