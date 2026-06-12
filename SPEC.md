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
├── CONTRACT.md        # agent-authored: what this agent surfaces / holds back (committed)
├── GUIDE.md           # orientation breadcrumb, written by the CLI (committed)
├── runs.jsonl         # activity log, one JSON object per line (outbox; gitignored)
├── asks.jsonl         # things needing a human, one per line (outbox; gitignored)
└── artifacts/         # files referenced by runs/asks (outbox; gitignored)
```

**Commit** `config.json` + `agent.json` + `CONTRACT.md` + `GUIDE.md`. The activity files
(`runs.jsonl`, `asks.jsonl`, `artifacts/`) are a transient outbox and are typically gitignored.

**`CONTRACT.md` + `GUIDE.md` are companion conventions, not wire format** — they are never
pushed. `CONTRACT.md` is the standing agreement between the agent and its user about what gets
surfaced; `GUIDE.md` is an orientation stub the reference CLI writes (and never clobbers).
Implementations may add files like these; readers must ignore files this spec doesn't name.

**The membership rule — what belongs in `.figs/`:** everything in the folder is *Figs-facing* —
protocol metadata (`config.json`), the published record (the charter, the outbox), or a
convention *about* publishing (`CONTRACT.md`, `GUIDE.md`). An agent's private working state —
memory, self-checks, scratch notes — lives outside `.figs/`, elsewhere in the repo. If a file's
only reader is the agent itself, it does not belong here.

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

One JSON object per line (JSON Lines). **One record = one job** — a unit of work the agent's
*manager* would recognize ("recon — Acme — November"), under a **stable, meaningful id**
(`recon-acme-2026-11`); the runs list reads as the job list. Records **fold by `id`** (same
merge as asks): re-reporting a job's id layers progress onto its row (`status` evolves
blocked-ish `warn` → `ok`) — sittings/sessions are agent plumbing and never mint records.
Closing an ask is **not** a job: that's a `resolution` in `asks.jsonl` (§6), never a run.

A job is either **in flight** or **settled** (`state`, below). A **checkpoint**
(`figs checkpoint`) folds progress onto the job's id and marks it in-flight — the record
survives the session working it, so a crash mid-job leaves a visible, recoverable stub
instead of nothing. A **report** files the outcome and settles it; a report with no prior
checkpoint is simply a job **born settled** (the single-sitting case). Nothing *external*
ever closes a run — only the agent's own report settles its job.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `ts` | string (ISO-8601 w/ offset) | ✓ | When it ran, e.g. `2026-05-28T23:41:26Z`. |
| `unit` | string | | The `Unit.id` this run is about. |
| `period` | string | | |
| `result` | string | | The job's current one-line state — where it stands while in flight; the outcome once settled. |
| `status` | `"ok"` \| `"warn"` \| `"fail"` | | Default `"ok"`. **Outcome, never lifecycle** — what the work looks like right now (a stuck job is `warn`); whether the job is *done* is `state`, the orthogonal dimension. |
| `state` | `"in-flight"` \| `"settled"` | | Default `"settled"`. **Lifecycle, verb-stamped** — `figs checkpoint` stamps `in-flight`, `figs report` stamps `settled`; agents never hand-pick it. An in-flight job whose agent died stays visibly in flight — that's the point: the next session finds it in `figs inbox` and finishes or settles it. |
| `artifacts` | string[] | | File names under `artifacts/` to attach. Singular `artifact` (string) remains valid shorthand for one — readers normalize to the array (same pattern as `resolution`'s bare-string shorthand). |
| `session` | `Session` | | Where/how this ran (see [§5.1](#51-session--runtime-metadata-optional)). Optional, self-reported. |

### 5.1 `Session` — runtime metadata (optional)

An optional, **self-reported** block describing the runtime session that produced a run (or raised an
ask — see §6). Every field is optional — fill what your runtime exposes, omit the rest. This is
*transparency, not attestation*: the values come from the runtime's own records — hand-authored, or
written by integrations that can copy provable values at work-time (the CLI never infers them).
Cryptographic provenance remains [reserved](#reserved-not-in-v1).

| Field | Type | Meaning |
|---|---|---|
| `runtime` | string | What ran it, e.g. `claude-code`, `codex`, `claude-managed-agents`. |
| `model` | string | Model id, e.g. `claude-fable-5`. |
| `sessionId` | string | The runtime's own session identifier. |
| `startedAt` | string (ISO-8601 w/ offset) | When this job began (the record's `ts` is when it was reported). |
| `commit` | string | The agent repo's HEAD at run time; append `+dirty` when the working tree had uncommitted changes, e.g. `1b68668+dirty`. |
| `trigger` | string | What set this sitting in motion — one self-reported line, e.g. `monthly close cron`, `inbox: answer on acme-bridge`, `Wayne, in chat`. A *fresh* sitting on a job states it (stamped from `--trigger` on `figs checkpoint`/`report`); records continuing the same session omit it. The one mechanically verified trigger stays `resolution.answer` ([§6.2](#62-resolution--how-an-ask-closed)). |
| `tokens` | `{ input?, output?, cacheRead?, cacheWrite? }` (numbers) | **Session totals at report time** — cumulative for the whole session, *not* per-job. Approximate by design (an interactive session may include unrelated chat). Readers may derive per-run deltas between consecutive runs sharing a `sessionId`. Include cache figures when available — in agentic sessions they often dominate real cost. |

## 6. `asks.jsonl` — handoffs to a human

One JSON object per line. Each is something the agent needs a person to resolve. **This is the handoff
primitive** — the agent reached the edge of its autonomy.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `type` | enum | ✓ | `needs-decision` \| `sign-off` \| `fyi` — **the type is the answer contract**: *needs-decision* wants an answer (an option or free text), *sign-off* wants a verdict (approve / request changes / reject), *fyi* wants nothing (a for-the-record note; readers never count it as needing a human). `blocked` was **folded into `needs-decision`** (2026-06, pre-launch in-place edit): a stuck job is the *run's* `status`, not an ask type. |
| `status` | enum | | `"open"` (default) \| `"resolved"` (the need was met) \| `"withdrawn"` (the **asker** retracted it — no longer needed, nobody acted) \| `"rejected"` (the **answerer** declined it — a human said no; usually born in the reader's UI, but the agent may record an out-of-band rejection too). Three closes, three authors-of-the-ending. **Rejected is terminal** on this id — readers keep it sticky; re-raising is a new ask. |
| `to` | `"manager"` \| `"builder"` | | Who the ask is addressed to: the human accountable for the **work** (`manager`) or for the **machine** (`builder` — e.g. self-edit/logic-change flags). Absent = unaddressed; readers may guess from `type` but must present it as a guess. |
| `title` | string | ✓ | The ask, in one line. |
| `unit` | string | | The `Unit.id` this concerns. |
| `run` | string | | The run `id` this ask was raised during (the work that surfaced it). **Optional** — asks also arise outside runs (a self-found issue, expired credentials). |
| `found` | string | | What the agent found / why it's stuck. |
| `need` | string | | What it needs from the human. |
| `options` | string[] | | Candidate resolutions — **short, stable, quotable** strings: an answer references one *verbatim* (see [§6.2](#62-resolution--how-an-ask-closed)). On a **sign-off** they are **answer paths** — qualified verdicts the human's verdict can cite verbatim alongside approve/request-changes (e.g. `"Approved — file the 15 ready charges"`). |
| `onApprove` | string[] | | **Sign-off only.** The ordered steps approval sets in motion — **an approval authorizes exactly these stated steps, in order** (e.g. `"Post the 8 journal entries to SAP"`, `"Email the filing to Acme"`); flag anything irreversible in the step itself. This is the agent's **declared intent, not a bound plan** — readers present it as the agent's claim. Invalid on other types: a *needs-decision* has no approval; there, the chosen option carries the next step. |
| `details` | `{ l, v }[]` | | Labelled facts (e.g. amount at risk). |
| `refs` | `{ label, artifact? }[]` | | Pointers to artifacts that back the ask. |
| `resolution` | string \| `Resolution` | | The agent's account of the close ([§6.2](#62-resolution--how-an-ask-closed)). A bare string is shorthand for `{ "note": … }`. |
| `ts` | string (ISO-8601 w/ offset) | | |
| `session` | `Session` | | The session that raised this ask (same shape as [§5.1](#51-session--runtime-metadata-optional)). |

### 6.1 Lifecycle — two ledgers, split by author

An ask is the **anchor of a thread whose two halves are owned by different parties**:

- **The agent's ledger** is `asks.jsonl` — only the agent writes here. Records **fold by `id`**
  (field-level merge: later lines layer over earlier ones), so the close is an *append*, not an edit:

  ```jsonc
  { "id": "acme-bridge", "status": "resolved",
    "resolution": { "chosen": "Strip the alpha prefix", "via": "human",
                    "by": "Sarah (accounting)", "ts": "2026-06-01T09:12:00Z" } }
  ```

  Appending keeps the local file crash-safe, concurrency-safe (multiple runners), and an honest
  self-audit trail; the folded record the reader stores is one complete ask.
- **The human's ledger** is server-side — claims, answers, and verdicts born in the reader's UI.
  These are [reserved](#reserved-not-in-v1) in v1 and **never appear in `asks.jsonl`**: nobody
  writes into the other side's record; the two ledgers cross-reference by id.

The full state machine: `open` → *(answered/verdict — human, server-side)* →
`resolved` | `withdrawn` *(agent, in `asks.jsonl`)* — plus the one human-side close:
**`rejected`** (a reject verdict in the reader's UI closes the ask immediately; the agent's
later resolution append folds onto it without reopening). Today resolution otherwise happens
in the agent's own workflow; answers flowing back through the reader are arriving incrementally.

### 6.2 `Resolution` — how an ask closed

| Field | Type | Meaning |
|---|---|---|
| `note` | string | The agent's one-line account of the close. |
| `chosen` | string | The decision taken — **verbatim** one of the ask's `options[]`. |
| `via` | `"figs"` \| `"human"` \| `"self"` | Where the unblock came from: an answer pulled from Figs (verified — see `answer`) · answered out-of-band (self-reported) · the blocker cleared on its own. |
| `by` | string | Who answered, as the agent knows it (self-reported; verified attribution only exists for `via: "figs"`). |
| `answer` | string | The Figs answer-event id the agent acted on — written by `figs resolve` when the answer came through the inbox (attribution by mechanism, never typed). The cited event may be an answer **or a qualified verdict** (a verdict carrying `chosen`). |
| `ts` | string (ISO-8601 w/ offset) | When the agent closed it — **machine-stamped by `figs resolve`, never typed**. The agent's claim of the execution-adjacent moment, same self-reported grade as the record `ts`; readers stamp their own receipt at ingest and surface both only when they diverge. Lives *inside* `resolution` so the fold can't collide with the record's raise `ts`. |

All fields optional; a bare-string `resolution` is shorthand for `{ "note": … }` and readers
normalize it to the object form.

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

**A push never re-homes an agent.** The workspace an agent is registered to is authoritative
server-side: a payload whose `workspaceId` differs from it is rejected with HTTP `409` and body
`{ "error", "code": "agent_moved", "workspaceId"? }`. The `error` text states the fix; `workspaceId`
(the agent's current home) is included only when the pushing token has access to that workspace.
Moving an agent between workspaces is a reader-side management act, outside this contract — the agent
recovers by setting `config.json#workspaceId` to the workspace named in the error and pushing again
(each runner self-heals on its own next push; nothing propagates through the repo).

Because every push is authenticated, the receiver knows which account performed it and **may stamp each
newly created run/ask with that identity** ("pushed by"). This is server-observed — it attributes the
*credential*, not necessarily the human at the keyboard (a shared runner box should use a dedicated
account named for what it is, e.g. "Runner — analytics box"). Agents never author this field.

## 9. Validation & versioning

- A `.figs/` folder can be validated against this spec before publishing (`figs doctor` →
  `POST {endpoint}/api/validate`). The shapes are the source of truth; readers reject malformed payloads.
- **`figs-spec` is integer-versioned.** v1 is the current version. **Additive/optional** fields keep the
  version number (an older `agent.json` still validates). The number is bumped only on a **breaking**
  change. (Implementations report support via `GET {endpoint}/api/version`.)
- v1 is intentionally minimal — it defines the smallest useful surface so we don't freeze the wrong
  abstractions early. Extensions arrive as additive optional fields until a breaking change is unavoidable.

## Reserved (not in v1)

Deliberately out of scope for v1, named here so implementers don't repurpose these concepts:

- **Two-way / answer-down — thread events.** A human answer or sign-off flowing *back* to the agent
  through Figs (vs. the agent resolving in its own workflow). v1 is report-only. The shapes are locked
  so `options[]`/`resolution` are designed for them: server-side events keyed to the ask id —
  `answer { by, ts, chosen?, text? }` where
  `chosen` verbatim-matches an `options[]` entry · `verdict { by, ts, verdict: "approved" | "changes-requested" | "rejected", text? }`
  for sign-offs. Answers/verdicts are permission-gated to the agent's manager/builder (the injection
  gate); delivery is **agent-pulled** (an inbox read), never pushed into the repo. Item kinds `note`
  and `directive` (human-initiated) are named-reserved.
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
// .figs/runs.jsonl   (one object per line; records fold by id — the checkpoint opened the job, the report settled it)
{ "id": "acme-2025-11", "ts": "2026-05-28T23:05:40Z", "unit": "acme", "period": "2025-11", "state": "in-flight", "result": "Statements pulled — matching now",
  "session": { "runtime": "claude-code", "trigger": "monthly close cron" } }
{ "id": "acme-2025-11", "ts": "2026-05-28T23:41:26Z", "unit": "acme", "period": "2025-11", "result": "88% matched · 31 keys flagged", "status": "ok", "state": "settled", "artifact": "acme-2025-11.html",
  "session": { "runtime": "claude-code", "model": "claude-fable-5", "sessionId": "3fffcd97-d4f5-4b77-8243-8f450d7c9614",
    "startedAt": "2026-05-28T23:02:00Z", "commit": "1b68668",
    "tokens": { "input": 26608, "output": 135532, "cacheRead": 8677869, "cacheWrite": 543145 } } }
```

```jsonc
// .figs/asks.jsonl   (one object per line; records fold by id — the close is an append)
{ "id": "acme-bridge", "ts": "2026-05-28T21:05:00Z", "type": "needs-decision", "status": "open", "to": "manager", "unit": "acme", "run": "acme-2025-11",
  "title": "No bridge rule for prefixed invoice numbers",
  "found": "~180 rows can't be matched safely; guessing risks false matches.",
  "need": "Confirm the bridge rule for prefixed invoice numbers.",
  "options": [ "Strip the alpha prefix", "Use a mapping you provide", "Treat as out-of-scope" ],
  "details": [ { "l": "Amount at risk", "v": "$50.0M" } ],
  "refs": [ { "label": "Acme report", "artifact": "acme-2025-11.html" } ] }
{ "id": "acme-bridge", "status": "resolved",
  "resolution": { "chosen": "Strip the alpha prefix", "via": "human", "by": "Sarah (accounting)",
                  "note": "confirmed in terminal — applied from 2025-11 onward" } }
```
