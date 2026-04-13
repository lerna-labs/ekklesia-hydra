# Ekklesia JSON Schemas

JSON Schema (Draft 2020-12) definitions for the three off-chain payload shapes that flow through the Hydra middleware. Use these to validate request bodies, audit IPFS-pinned artifacts, or generate types in any language with a JSON Schema toolchain.

| File | Object | Where it lives |
|---|---|---|
| `ballot.schema.json` | `BallotDefinition` | Request body of `POST /prepare` and `POST /prepare/update`. Pinned to IPFS; `blake2b_256` of canonical JSON = on-chain (600) `contentHash`. |
| `vote-evidence.schema.json` | `VoteEvidence` | Pinned to IPFS at vote time. `blake2b_256` of canonical JSON = on-chain voter token `voteHash`. |
| `results.schema.json` | `FullResults` | Pinned to IPFS at finalization. `blake2b_256` of canonical JSON = on-chain (601) `resultsHash`. |

## Validating a payload

With [Ajv](https://ajv.js.org/) (Node, bundled with the middleware's deps):

```ts
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ballotSchema from './schemas/ballot.schema.json' with { type: 'json' };

const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateBallot = ajv.compile(ballotSchema);

if (!validateBallot(payload)) {
  console.error(validateBallot.errors);
}
```

With `check-jsonschema` (Python CLI):

```sh
check-jsonschema --schemafile schemas/ballot.schema.json my-ballot.json
```

## Conventions

- All on-chain hashes are referenced as **hex** strings.
- IPFS CIDs are referenced as their **string CID form** (not raw bytes), even though the on-chain datums store them as raw UTF-8 bytes.
- Timestamps are **ISO-8601 UTC** strings.
- Lovelace weights are **stringified BigInts** (JSON cannot represent arbitrary-precision integers safely).
- Question option `value` and ranking entries are always **integers**. Stable across the lifetime of a ballot — changing them after mint breaks vote verification.

## Cross-references between schemas

The schemas are intentionally self-contained — `VoteSelection`, `CoseWitness`, `NativeScriptDef`, etc. are duplicated across `vote-evidence.schema.json` and (where relevant) inlined locally. This keeps each file independently usable without resolving external `$ref`s. If you regenerate types from these, the duplicate inner types should hash-identical between files.

## Source of truth

These schemas mirror the TypeScript interfaces in `src/types.ts`. When the TS types change, regenerate or hand-edit these schemas to stay in sync — there is no automated codegen between them. The on-chain datum shapes (which these schemas do **not** describe) are defined in `tx3/main.tx3` and rebuilt via `trix codegen` into `src/protocol.ts`.
