# Ballot Payload Structure

This document describes how to structure the `ballot` JSON payload passed to
`POST /prepare`. It is the input that defines what voters will see and how their
answers are validated and tallied.

The payload is a `BallotDefinition` (see `src/types.ts`). It combines the
CIP-179 `surveyDetails` core with an Ekklesia-specific extension block.

---

## Top-level shape

```json
{
  "specVersion": "0.3.0",
  "title": "Intersect Budget 2026",
  "description": "Constitutional budget allocation vote.",
  "questions": [
    /* BallotQuestion[] */
  ],
  "roleWeighting": {
    /* RoleWeighting */
  },
  "endEpoch": 512,
  "ekklesia": {
    /* EkklesiaBallotExtension */
  }
}
```

| Field           | Type                      | Notes                                                            |
|-----------------|---------------------------|------------------------------------------------------------------|
| `specVersion`   | string                    | Ekklesia spec version. Currently `"0.3.0"`.                      |
| `title`         | string                    | Short human label. Also embedded in the (600) on-chain datum.    |
| `description`   | string                    | Free-form description.                                           |
| `questions`     | `BallotQuestion[]`        | One or more questions. Order matters for the merkle tree.        |
| `roleWeighting` | `RoleWeighting`           | How each role's votes are weighted at tally time.                |
| `endEpoch`      | integer                   | Cardano epoch at which voting ends. Embedded in the (600) datum. |
| `ekklesia`      | `EkklesiaBallotExtension` | Required extension (see below).                                  |

The middleware fills in `ekklesia.namespace`, `ekklesia.merkleRoot`, and
`ekklesia.ballotIpfsCid` for you based on the request body — but you must
provide the fields listed under **Ekklesia extension** below.

---

## Ekklesia extension

```json
"ekklesia": {
"votingAuthority": "addr1...", "context": "hydra-head", "acceptedCredentials": ["drep", "pool", "stake"], "votingWindow": {
"open": "2026-05-01T00:00:00Z", "close": "2026-05-08T00:00:00Z"
}
}
```

| Field                 | Type            | Notes                                                                                                                    |
|-----------------------|-----------------|--------------------------------------------------------------------------------------------------------------------------|
| `votingAuthority`     | string (bech32) | Admin address that mints ballot tokens. Should match the middleware's admin wallet.                                      |
| `context`             | `"hydra-head"`  | Fixed value — voting happens inside a Hydra head.                                                                        |
| `acceptedCredentials` | string[]        | Bech32 HRPs that may register as voters. Allowed: `drep`, `pool`, `calidus`, `stake`, `stake_test`, `addr`, `addr_test`. |
| `votingWindow.open`   | ISO-8601 UTC    | **The timelock anchor.** Must be in the future when `/prepare` is called — the minting policy is locked at this slot.    |
| `votingWindow.close`  | ISO-8601 UTC    | Informational; enforced by the middleware, not the script.                                                               |

Fields the middleware will overwrite:

- `namespace` — copied from the `namespace` request field.
- `merkleRoot` — computed as `blake2b_256` of the question leaves.
- `ballotIpfsCid` — the CID of the pinned ballot JSON. Set to `"self"` in the
  pinned copy to avoid a self-reference loop, then patched to the real CID in
  the cached copy.

---

## Questions

Every question has `questionId`, `question`, and `method`. The remaining fields
depend on `method`.

### `binary` and `single-choice`

Pick exactly one option.

```json
{
  "questionId": "q1",
  "question": "Approve the budget?",
  "method": "binary",
  "options": [
    {
      "label": "Yes",
      "value": 1
    },
    {
      "label": "No",
      "value": 0
    },
    {
      "label": "Abstain",
      "value": -1
    }
  ]
}
```

Voter submits `selection: [<one value>]`.

### `multi-choice`

Pick N of M.

```json
{
  "questionId": "q2",
  "question": "Which working groups should be funded?",
  "method": "multi-choice",
  "options": [
    {
      "label": "Research",
      "value": 1
    },
    {
      "label": "Tooling",
      "value": 2
    },
    {
      "label": "Outreach",
      "value": 3
    },
    {
      "label": "Education",
      "value": 4
    }
  ],
  "minSelections": 1,
  "maxSelections": 3
}
```

Voter submits `selection: [1, 3]`. Duplicates are rejected. Defaults:
`minSelections = 0`, `maxSelections = options.length`.

### `range`

Submit a single integer within `valueRange`.

```json
{
  "questionId": "q3",
  "question": "Rate the proposal (-5 to +5).",
  "method": "range",
  "valueRange": {
    "min": -5,
    "max": 5
  }
}
```

Voter submits `selection: [3]`. `options` is not required.

### `ranked`

Order options by preference. `rankCount` entries required (defaults to all
options). Position 0 = first preference. No duplicates.

```json
{
  "questionId": "q4",
  "question": "Rank these candidates.",
  "method": "ranked",
  "options": [
    {
      "label": "Alice",
      "value": 1
    },
    {
      "label": "Bob",
      "value": 2
    },
    {
      "label": "Carol",
      "value": 3
    }
  ],
  "rankCount": 3
}
```

Voter submits `ranking: [2, 1, 3]` (Bob > Alice > Carol).

### `weighted`

Distribute a fixed budget across options. Weights must be non-negative integers
that sum **exactly** to `budget`.

```json
{
  "questionId": "q5",
  "question": "Allocate 100 points across programs.",
  "method": "weighted",
  "options": [
    {
      "label": "Research",
      "value": 1
    },
    {
      "label": "Tooling",
      "value": 2
    },
    {
      "label": "Outreach",
      "value": 3
    }
  ],
  "budget": 100
}
```

Voter submits
`weights: [{"option":1,"weight":40},{"option":2,"weight":35},{"option":3,"weight":25}]`.

---

## `roleWeighting`

Maps each role to how its votes are aggregated during tally:

```json
"roleWeighting": {
"DRep": "CredentialBased", "SPO": "StakeBased", "Stakeholder": "StakeBased"
}
```

Allowed values per role:

| Role          | Allowed modes                                  |
|---------------|------------------------------------------------|
| `DRep`        | `CredentialBased`, `StakeBased`                |
| `SPO`         | `CredentialBased`, `StakeBased`, `PledgeBased` |
| `CC`          | `CredentialBased`                              |
| `Stakeholder` | `StakeBased`                                   |

Only roles you intend to count need to be listed. Results are raw unweighted
counts — stake weighting is applied externally (intentional).

---

## Option values

- `value` is always an **integer**. Human labels live in `label`.
- Values must be unique within a question.
- Keep them stable — they end up in signed vote payloads and evidence files on
  IPFS. Changing a value after minting breaks verification.

---

## Complete minimal example

```json
{
  "specVersion": "0.3.0",
  "title": "Intersect Budget 2026",
  "description": "Approve or reject the constitutional budget.",
  "endEpoch": 512,
  "questions": [
    {
      "questionId": "approve",
      "question": "Approve the 2026 budget?",
      "method": "binary",
      "options": [
        {
          "label": "Yes",
          "value": 1
        },
        {
          "label": "No",
          "value": 0
        }
      ]
    }
  ],
  "roleWeighting": {
    "DRep": "CredentialBased",
    "SPO": "CredentialBased"
  },
  "ekklesia": {
    "votingAuthority": "addr_test1qzadmin...",
    "context": "hydra-head",
    "acceptedCredentials": [
      "drep",
      "pool"
    ],
    "votingWindow": {
      "open": "2026-05-01T00:00:00Z",
      "close": "2026-05-08T00:00:00Z"
    }
  }
}
```

Send this as `ballot` in the `POST /prepare` body:

```json
{
  "namespace": "vote.ekklesia.intersect.budget2026",
  "ballot": {
    /* the payload above */
  },
  "gasAmount": 3,
  "cip179": false
}
```

---

## Validation rules (enforced by `/vote`)

The middleware runs `validateSelections()` against the cached ballot:

- `questionId` must exist.
- `binary` / `single-choice`: exactly one `selection`; must be a known option
  value.
- `multi-choice`: respects `minSelections` / `maxSelections`; no duplicates; all
  values valid.
- `range`: exactly one value; within `valueRange`.
- `ranked`: `ranking.length === rankCount`; all values valid options; no
  duplicates.
- `weighted`: all options valid; no duplicate option entries; weights are
  non-negative integers; weights sum to `budget`.

Selections that fail any of these return HTTP 400 with
`code: INVALID_INPUT`.

---

## Pitfalls

- **Timelock**: `votingWindow.open` **must** be in the future at `/prepare`
  time. It becomes `invalidHereafter` on the minting script — once that slot
  passes, nothing can mint or burn under this policy ever again.
- **Question ordering**: `questions[]` order determines leaf order in the
  content merkle tree. Reordering changes `merkleRoot` and breaks any
  pre-computed proofs.
- **Stringifying**: the content hash uses `JSON.stringify(question)`. Don't
  inject extra whitespace or key reordering into individual question objects
  before submission.
- **Namespace is in the request, not the payload**: pass `namespace` as a
  top-level request field on `/prepare`; the middleware writes it into
  `ekklesia.namespace` for you.
- **`options` with `range`**: omit `options` — `valueRange` defines the domain.
  Including both is not a validation error but is ignored.