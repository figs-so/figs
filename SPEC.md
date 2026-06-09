# The `.figs` Protocol — `figs-spec v1`

> **Status:** v1 — minimal and stable. This spec defines the `.figs/` folder an AI agent writes and how
> it is published. It is deliberately small: it describes *reporting* (agent → human), which is all v1
> covers. Two-way (answers/sign-off flowing back to the agent) is **reserved for a future version** — see
> [Reserved](#reserved-not-in-v1). Licensed **MIT** — implement it in anything.

## 1. Design principles

- **One-way.** An agent *publishes* its state. A Figs reader is a **read-only mirror** — it never writes
  back into the agent or its repo.
- **Local-first.** The agent owns a `.figs/` folder on disk. Publishing is an explicit act (`push`), not a
  live connection.
- **Upsert-only.** Publishing inserts or updates records by their `id`; it **never deletes** remote rows.
  The remote is a durable record; the local folder is a transient outbox.
- **Two content modes, no display language.** Everything is either *structured state* (JSON/JSONL we
  describe below, rendered by fixed components) or a *rendered artifact* (a file shown in a sandboxed
  viewer). There is no layout/templating DSL.
- **Self-describing identity.** An agent generates its own UUID once; that UUID *is* its identity. The same
  agent (a repo) may be run by many people; their pushes aggregate under that one identity.

## 2. Folder layout

```
.figs/
├── config.json        # identity + destination (committed, non-secret)
├── agent.json         # the charter — who this agent is (committed)
├── runs.jsonl         # activity log, one JSON object per line (outbox; gitignored)
├── asks.jsonl         # things needing a human, one per line (outbox; gitignored)
└── artifacts/         # files referenced by runs/asks (outbox; gitignored)
```

**Commit** `config.json` + `agent.json` (identity + charter). The activity files (`runs.jsonl`,
`asks.jsonl`, `artifacts/`) are a transient outbox and are typically gitignored.

## 3. `config.json` — identity + destination

Non-secret. Pins one shared identity so many runners' pushes aggregate.

| Field | Type | Notes |
|---|---|---|
| `endpoint` | string (URL) | Where to publish (default `https://app.figs.so`). |
| `workspaceId` | UUID | The workspace this agent belongs to. |
| `agentId` | UUID | The agent's identity, generated once by `figs init`. The CLI attaches it as the agent's `id` on push (you don't hand-author `id` in `agent.json`). |

## 4. `agent.json` — the charter

The agent's self-description. Authoring this and publishing makes the agent *appear*. The only field you
author that's required is `name` — **do not hand-author `id`**: `figs init` mints it into `config.json` and
the CLI attaches it on push. Everything else is optional and rendered when present.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | UUID | ✓ | Identity. **Supplied from `config.json#agentId` by the CLI on push — not written in this file.** |
| `name` | string | ✓ | Display name. |
| `key` | string | | Display slug; derived from `name` if absent. |
| `type` | `"agent"` \| `"human"` | | Default `"agent"`. |
| `avatar` | `{ seed: string }` | | Seed for the generated avatar. |
| `role` | string | | Short title, e.g. "Reconciliation Officer". |
| `status` | string | | Free-text lifecycle, e.g. `in_dev`, `active`. |
| `org` | `{ department?: string }` | | `department` groups the agent into an org-chart column. |
| `runtime` | string | | What runs it, e.g. "Claude Code". |
| `cadence` | string | | How often it runs, e.g. "Monthly". |
| `mandate` | string | | One-paragraph statement of what it's responsible for. |
| `steps` | string[] | | **Ordered** procedure (numbered render). For pipeline-shaped agents. |
| `responsibilities` | string[] | | **Unordered** areas of work (bulleted render). For broad/mission agents. |
| `properties` | `{ k, v }[]` | | Freeform catch-all for facts with no dedicated field. Keep keys short, values single-line. Don't duplicate first-class fields. |
| `units` | `Unit[]` | | The instances/things the agent operates on (see below). |

Use **`steps`** *or* **`responsibilities`** depending on shape — a fixed pipeline vs. a set of work areas.

### 4.1 `Unit` — a thing the agent operates on

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (referenced by `runs`/`asks` via `unit`). |
| `name` | string | ✓ | Display name. |
| `subtitle` | string | | |
| `status` | string | | Current one-line state. |
| `period` | string | | The period in view, e.g. `2025-11`. |
| `detail` | string | | |
| `stats` | `{ l, v }[]` | | Labelled values (`l` = label, `v` = value). |

## 5. `runs.jsonl` — activity

One JSON object per line (JSON Lines). Each is something the agent did.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `ts` | string (ISO-8601 w/ offset) | ✓ | When it ran, e.g. `2026-05-28T23:41:26Z`. |
| `unit` | string | | The `Unit.id` this run is about. |
| `period` | string | | |
| `result` | string | | One-line outcome. |
| `status` | `"ok"` \| `"warn"` \| `"fail"` | | Default `"ok"`. |
| `artifact` | string | | File name under `artifacts/` to attach. |

## 6. `asks.jsonl` — handoffs to a human

One JSON object per line. Each is something the agent needs a person to resolve. **This is the handoff
primitive** — the agent reached the edge of its autonomy.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `type` | enum | ✓ | `blocked` \| `needs-decision` \| `sign-off` \| `fyi`. `fyi` is a non-blocking heads-up (no decision needed). (`confirm-assumption` still validates but is **deprecated** — use `needs-decision` or `fyi`.) |
| `status` | `"open"` \| `"resolved"` | | Default `"open"`. |
| `title` | string | ✓ | The ask, in one line. |
| `unit` | string | | The `Unit.id` this concerns. |
| `found` | string | | What the agent found / why it's stuck. |
| `need` | string | | What it needs from the human. |
| `options` | string[] | | Candidate resolutions. |
| `details` | `{ l, v }[]` | | Labelled facts (e.g. amount at risk). |
| `refs` | `{ label, artifact? }[]` | | Pointers to artifacts that back the ask. |
| `ts` | string (ISO-8601 w/ offset) | | |

> In v1, an ask is **one-way**: it announces that a human is needed. Resolution happens in the agent's own
> workflow (the agent sets `status: "resolved"` on a later push). Answers flowing *back* through Figs are
> [reserved for a future version](#reserved-not-in-v1).

## 7. `artifacts/` — rendered files

Files referenced by a run's `artifact` or an ask's `refs[].artifact`. Each is content-addressed (an
unchanged file is skipped on publish).

- **Supported kinds** (by extension): `html`, `markdown` (`.md`), `text` (`.txt`), `json`, and `image`
  (`.png` `.jpg` `.gif` `.webp` `.svg`).
- **Size:** keep each file **≤ ~3 MB** (compress images client-side if needed).
- Artifacts are shown in a **sandboxed iframe** by the reader; an artifact cannot reach the host app.

## 8. Publishing (the wire contract)

`push` sends two things, authenticated by a per-user token in the `x-figs-token` header:

1. **The spine** → `POST {endpoint}/api/ingest`, body:
   ```jsonc
   {
     "workspaceId": "<uuid>",      // from config.json
     "agent": { /* agent.json */ },
     "runs":  [ /* runs.jsonl  */ ],   // optional
     "asks":  [ /* asks.jsonl  */ ]    // optional
   }
   ```
2. **Each referenced artifact** → `POST {endpoint}/api/artifacts/upload`, content base64-encoded (so
   binaries survive), hash server-verified.

The server upserts the agent by `id` and runs/asks by `id`; it never deletes. An agent **self-registers**
on first push — there is no "create agent" step.

## 9. Validation & versioning

- A `.figs/` folder can be validated against this contract before publishing (`figs doctor` →
  `POST {endpoint}/api/validate`). The shapes are the source of truth; readers reject malformed payloads.
- **`figs-spec` is integer-versioned.** v1 is the current version. **Additive/optional** fields keep the
  version number (an older `agent.json` still validates). The number is bumped only on a **breaking**
  change. (Implementations report support via `GET {endpoint}/api/version`.)
- v1 is intentionally minimal — it defines the smallest useful surface so we don't freeze the wrong
  abstractions early. Extensions arrive as additive optional fields until a breaking change is unavoidable.

## Reserved (not in v1)

Deliberately out of scope for v1, named here so implementers don't repurpose these concepts:

- **Two-way / answer-down.** A human answer or sign-off flowing *back* to the agent through Figs (vs. the
  agent resolving in its own workflow). v1 is report-only.
- **Provenance / signing.** Cryptographic attestation that a report is complete, fresh, and untampered.
  v1 state is *self-reported*; treat it as visibility, not a tamper-evident audit trail.
- **Per-record visibility / scoping.** v1 publishes to a workspace where all members can read everything.

## 10. A complete example

```jsonc
// .figs/config.json
{ "endpoint": "https://app.figs.so", "workspaceId": "…uuid…", "agentId": "…uuid…" }
```

```jsonc
// .figs/agent.json   (no `id` here — `figs init` puts it in config.json; the CLI attaches it on push)
{
  "name": "Reconciliation",
  "type": "agent",
  "role": "Reconciliation Officer",
  "status": "in_dev",
  "avatar": { "seed": "Reconciliation" },
  "org": { "department": "Finance Ops" },
  "runtime": "Claude Code",
  "cadence": "Monthly",
  "mandate": "Reconciles open invoices every month — flags what doesn't match for review.",
  "steps": [
    "Pull our open invoices and the customer's statement for the month.",
    "Match on PO / delivery-number keys within tolerance.",
    "Classify every key — matched / needs-review / our-side-only / customer-only — with a 'why'.",
    "Surface discrepancies. Never write back to the source."
  ],
  "properties": [
    { "k": "Data sources", "v": "Stripe · NetSuite" },
    { "k": "Escalation", "v": "#finance-ops" }
  ],
  "units": [
    { "id": "acme", "name": "Acme Corp", "status": "88% matched · 31 keys flagged", "period": "2025-11",
      "stats": [ { "l": "Matched", "v": "2,161 keys" }, { "l": "Needs review", "v": "31 keys" } ] }
  ]
}
```

```jsonc
// .figs/runs.jsonl   (one object per line)
{ "id": "acme-2025-11", "ts": "2026-05-28T23:41:26Z", "unit": "acme", "period": "2025-11", "result": "88% matched · 31 keys flagged", "status": "ok", "artifact": "acme-2025-11.html" }
```

```jsonc
// .figs/asks.jsonl   (one object per line)
{ "id": "acme-bridge", "ts": "2026-05-28T21:05:00Z", "type": "needs-decision", "status": "open", "unit": "acme",
  "title": "No bridge rule for prefixed invoice numbers",
  "found": "~180 rows can't be matched safely; guessing risks false matches.",
  "need": "Confirm the bridge rule for prefixed invoice numbers.",
  "options": [ "Strip the alpha prefix", "Use a mapping you provide", "Treat as out-of-scope" ],
  "details": [ { "l": "Amount at risk", "v": "$50.0M" } ],
  "refs": [ { "label": "Acme report", "artifact": "acme-2025-11.html" } ] }
```
