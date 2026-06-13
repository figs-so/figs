# The `.figs` Protocol — `figs-spec v2`

> **Status:** v2. This spec defines the `.figs/` folder an AI agent writes, how it is published, and
> how a human's replies come back. It is deliberately small. **Account-optional:** the protocol and the
> local tooling are fully usable with no account and no network; a reader/remote is strictly additive.
> Licensed **MIT** — implement it in anything.
>
> *v2 (from v1): the human-reply ledger (`messages.jsonl`) is now part of the format and the loop is
> two-way; ask types narrowed to `question`/`sign-off`; one unified `attachments[]`; `config.json`'s
> destination fields are optional (local mode); wire auth is `Authorization: Bearer`. See each section.*

## 1. Design principles

- **Local-first, account-optional.** The agent owns a `.figs/` folder on disk and is fully operational
  with no account and no network — record work, raise asks, recover across sessions, validate. Publishing
  to a reader is an explicit, optional act (`push`), not a live connection.
- **Agent ledgers flow one way (up); the human ledger is the one two-way file.** An agent *publishes*
  its own records (`runs.jsonl`, `asks.jsonl`); a reader never writes them back. A human's replies live
  in `messages.jsonl` — the single file that also syncs *down* (§6, §8). Nobody writes into the other
  side's ledger.
- **One agent = one repo = one machine** (the topology rule). The agent ledgers are the source of truth
  on that machine; a reader is an aggregation mirror for humans, never an authority over the files.
  Running one agent from several machines at once is unsupported (commit the outbox and manage the merge
  yourself, at your own risk); the fleet-wide cross-machine view is the reader's job.
- **Upsert-only, never destructive.** Publishing inserts or updates records by their `id`; it never
  deletes. A push may not walk a record backwards (a stale close/settle never reopens — §8).
- **Two content modes, no display language.** Everything is either *structured state* (the JSON/JSONL
  below, rendered by fixed components) or an *attachment* (a file shown in a sandboxed viewer or offered
  for download). There is no layout/templating DSL.
- **Self-describing identity.** An agent generates its own UUID once; that UUID *is* its identity. The
  same agent (a repo) may be run by many people; their pushes aggregate under that one identity.

## 2. Folder layout

```
.figs/
├── config.json        # identity (+ destination once linked); committed, non-secret
├── agent.json         # the charter — who this agent is (committed)
├── CONTRACT.md        # agent-authored: what this agent surfaces / holds back (committed)
├── GUIDE.md           # orientation breadcrumb, written by the CLI (committed)
├── runs.jsonl         # activity log — one job per line (machine-local outbox; gitignored)
├── asks.jsonl         # handoffs to a human — one ask per line (machine-local outbox; gitignored)
├── messages.jsonl     # the human's replies — one event per line (machine-local; gitignored)
└── artifacts/         # files attached to any moment (machine-local; gitignored)
```

**Commit** `config.json` + `agent.json` + `CONTRACT.md` + `GUIDE.md`. The journal
(`runs.jsonl`, `asks.jsonl`, `messages.jsonl`, `artifacts/`) is a **machine-local** outbox — records
live on this machine; once linked + pushed, the reader is the durable record humans see.

**`CONTRACT.md` + `GUIDE.md` are companion conventions, not wire format** — never pushed.
`CONTRACT.md` is the standing agreement between agent and user about what gets surfaced; `GUIDE.md`
is an orientation stub the reference CLI writes (and never clobbers). Implementations may add files
like these; **readers must ignore files this spec doesn't name.**

**The membership rule:** everything in `.figs/` is *Figs-facing* — protocol metadata, the published
record, or a convention *about* publishing. An agent's private working state (memory, scratch notes)
lives elsewhere in the repo. If a file's only reader is the agent itself, it does not belong here.

## 3. `config.json` — identity (+ destination)

Non-secret. In **local mode** it is just `{ "agentId": "…" }`. `figs link` adds the destination
(`endpoint` + `workspaceId`) when the agent connects to a reader.

| Field | Type | Req | Notes |
|---|---|:--:|---|
| `agentId` | UUID | ✓ | The agent's identity, minted once by `figs init`. The CLI attaches it as the agent's `id` on push (you don't hand-author `id` in `agent.json`). |
| `endpoint` | string (URL) | | Where to publish (default `https://app.figs.so`). Written by `figs link`. |
| `workspaceId` | UUID | | The workspace this agent belongs to. Written by `figs link`. **Its presence is what "linked" means** — absent = local mode. |

## 4. `agent.json` — the charter

The agent's self-description. Authoring this and publishing makes the agent *appear*. The only field you
author that's required is `name` — **do not hand-author `id`**: `figs init` mints it into `config.json`
and the CLI attaches it on push. Everything else is optional and rendered when present.

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
| `properties` | `{ k, v }[]` | | Freeform catch-all for facts with no dedicated field. Keep keys short, values single-line. |
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

One JSON object per line (JSON Lines). **One record = one job** — a unit of work the agent's *manager*
would recognize ("recon — Acme — November"), under a **stable, meaningful id** (`recon-acme-2026-11`);
the runs list reads as the job list. Records **fold by `id`**: re-reporting a job's id layers progress
onto its row (`status` evolves `warn` → `ok`) — sittings/sessions are agent plumbing and never mint
records. Closing an ask is **not** a job: that's a `resolution` in `asks.jsonl` (§6), never a run.

A job is either **in flight** or **settled** (`state`). A **checkpoint** (`figs checkpoint`) folds
progress onto the job's id and marks it in-flight — the record survives the session working it, so a
crash mid-job leaves a visible, recoverable stub. A **report** files the outcome and settles it; a
report with no prior checkpoint is a job **born settled** (the single-sitting case). Nothing *external*
ever closes a run — only the agent's own report settles its job.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `ts` | string (ISO-8601 w/ offset) | ✓ | When it ran. Machine-stamped by the CLI, never typed. |
| `unit` | string | | The `Unit.id` this run is about. |
| `period` | string | | |
| `result` | string | | The job's current one-line state while in flight; its outcome once settled. |
| `status` | `"ok"` \| `"warn"` \| `"fail"` | | Default `"ok"`. **Outcome, never lifecycle** — what the work looks like now (a stuck job is `warn`); whether it's *done* is `state`. |
| `state` | `"in-flight"` \| `"settled"` | | Default `"settled"`. **Lifecycle, verb-stamped** — `checkpoint` → in-flight, `report` → settled. An in-flight job whose agent died stays in flight: the next session finds it in `figs inbox` and finishes or settles it. |
| `attachments` | string[] | | File names under `artifacts/` produced at this moment (§7). Attachments belong to their line, not the folded record. |
| `session` | `Session` | | Where/how this ran ([§5.1](#51-session--runtime-metadata-optional)). Optional, self-reported. |

### 5.1 `Session` — runtime metadata (optional)

An optional, **self-reported** block describing the runtime session that produced a run (or raised an
ask, or a message). Every field is optional. This is *transparency, not attestation*: the values come
from the runtime's own records — hand-authored, or written by integrations that copy provable values at
work-time (the CLI never infers them). Cryptographic provenance remains [reserved](#reserved-not-in-v2).

| Field | Type | Meaning |
|---|---|---|
| `runtime` | string | What ran it, e.g. `claude-code`, `codex`. |
| `model` | string | Model id, e.g. `claude-fable-5`. |
| `sessionId` | string | The runtime's own session identifier. |
| `startedAt` | string (ISO-8601 w/ offset) | When this job began (the record's `ts` is when it was reported). |
| `commit` | string | The repo's HEAD at run time; append `+dirty` when the tree had uncommitted changes. |
| `trigger` | string | What set this sitting in motion — one self-reported line (`monthly close cron`, `inbox: answer on acme-bridge`, `Wayne, in chat`). A *fresh* sitting states it; continuations omit it. |
| `tokens` | `{ input?, output?, cacheRead?, cacheWrite? }` | **Session totals at report time** — cumulative for the whole session, not per-job. Approximate by design. |

## 6. `asks.jsonl` — handoffs to a human

One JSON object per line. Each is something the agent needs a person to resolve — the agent reached the
edge of its autonomy.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Stable id (upsert key). |
| `type` | enum | ✓ | `question` \| `sign-off` — **the type is the answer contract**: *question* wants an answer (an option or free text), *sign-off* wants a verdict (approve / request-changes / reject). (`needs-decision` was renamed `question`; `fyi` was retired — a for-the-record note is a settled report, not an ask; `blocked` is the run's `status`, not an ask type.) |
| `status` | enum | | `"open"` (default) \| `"resolved"` (the need was met) \| `"withdrawn"` (the **agent** retracted it; nobody acted) \| `"rejected"` (a human declined it). **Rejected is terminal** on this id — re-raising is a new ask. |
| `to` | `"manager"` \| `"builder"` | | Who the ask is addressed to: the human accountable for the **work** (`manager`) or for the **machine** (`builder`). Absent = unaddressed. |
| `title` | string | ✓ | The ask, in one line. |
| `unit` | string | | The `Unit.id` this concerns. |
| `run` | string | | The run `id` this ask was raised during. **Optional** — asks also arise outside runs. |
| `found` | string | | What the agent found / why it's stuck. |
| `need` | string | | What it needs from the human. |
| `options` | string[] | | Candidate answers — **short, stable, quotable** strings: a reply cites one *verbatim* (§6.2). On a **sign-off** they are qualified-verdict paths (e.g. `"Approved — file the 15 ready charges"`). |
| `onApprove` | string[] | | **Sign-off only.** The ordered steps approval sets in motion — **an approval authorizes exactly these steps, in order**; flag anything irreversible in the step. The agent's declared intent, not a bound plan. Invalid on a `question`. |
| `details` | `{ l, v }[]` | | Labelled facts (e.g. amount at risk). |
| `attachments` | string[] | | File names under `artifacts/` attached to this ask (the exact content to review — §7). |
| `resolution` | string \| `Resolution` | | The agent's account of the close ([§6.2](#62-resolution--how-an-ask-closed)). A bare string is shorthand for `{ "note": … }`. |
| `ts` | string (ISO-8601 w/ offset) | | Machine-stamped. |
| `session` | `Session` | | The session that raised this ask. |

### 6.1 Lifecycle — two ledgers, two directions

An ask anchors a thread whose two halves are owned by different parties:

- **The agent's ledger** is `asks.jsonl` — only the agent writes here, one-way **up**. Records **fold
  by `id`** (field-level merge; later lines layer over earlier), so the close is an *append*, not an
  edit. Appending keeps the file crash-safe, concurrency-safe (same-machine sessions), and an honest
  self-audit trail; the folded record the reader stores is one complete ask.
- **The human's ledger** is `messages.jsonl` (§6.3) — replies (answers/verdicts). It is the one file
  that flows **down** too: a reply made in the reader's UI syncs into `messages.jsonl`; a reply given
  out-of-band (e.g. in chat) is transcribed there by the agent (`figs answer`). Either way, nobody
  writes the other side's ledger.

State machine: `open` → *(a reply arrives — `messages.jsonl`)* → the agent **closes** it
(`resolved` | `withdrawn` | `rejected`, derived from the reply; §6.2). `rejected` is terminal.

### 6.2 `Resolution` — how an ask closed

The close is derived from the newest reply on the ask and cites it.

| Field | Type | Meaning |
|---|---|---|
| `note` | string | The agent's one-line account of the close. |
| `chosen` | string | The decision taken — **verbatim** one of the ask's `options[]` (copied from the cited reply). |
| `run` | string | The job the reply set in motion (mirror of `ask.run`) — so a reader can navigate answer → work → outcome. |
| `via` | `"figs"` \| `"human"` \| `"self"` | How it closed: `figs` = derived from a reply on file, citing it (`answer`) · `human` = an out-of-band reply with no event cited · `self` = the blocker cleared on its own. |
| `answer` | string | The `messages.jsonl` event id the close acted on — written by `figs close` (attribution by mechanism, never typed). **Trust derives from that event's mint origin** (§6.3), not from this field. |
| `ts` | string (ISO-8601 w/ offset) | When the agent closed it — **machine-stamped, never typed**. Lives *inside* `resolution` so the fold can't collide with the ask's raise `ts`. |

All fields optional; a bare-string `resolution` is shorthand for `{ "note": … }`.

### 6.3 `messages.jsonl` — the human-reply ledger *(new in v2)*

One JSON object per line. Each is a **human's reply** to an ask. Messages are **events, not records**:
immutable, ids minted once, they **accumulate** (no fold) — an ask can carry answer → changes-requested
→ approved, and every one survives. A correction is a *new* message.

| Field | Type | Req | Meaning |
|---|---|:--:|---|
| `id` | string | ✓ | Event id, minted once by whoever creates the message (the reader, or the CLI for a transcription). Never hand-authored, never re-minted. |
| `kind` | `"answer"` \| `"verdict"` | ✓ | An answer (to a question) or a verdict (on a sign-off). |
| `ask` | string | ✓* | The ask id this replies to. *Optional only for reserved human-initiated kinds (`note`/`directive`), which may anchor to a run or stand alone. |
| `by` | string | ✓ | Who said it (the human). |
| `ts` | string (ISO-8601 w/ offset) | ✓ | Machine-stamped (server clock for reader-minted, CLI clock for transcribed). |
| `source` | `"app"` \| `"chat"` \| … | | **Where the reply arrived** (display metadata, *not* trust) — `app` = in the reader, `chat` = transcribed by the agent. Extensible (`slack`, `email`, …). |
| `chosen` | string | | The option cited, **verbatim** from the ask's `options[]`. |
| `text` | string | | Free-text reply. |
| `verdict` | `"approved"` \| `"changes-requested"` \| `"rejected"` | | On a `verdict` message. |

**The trust rule (normative):** a reader derives the *verified* grade from **mint origin** — a message
the reader minted itself is attested; a message that arrived via push (transcribed by an agent) is
self-reported, **whatever its `source` says.** `source` is display metadata; never trust input.

`messages.jsonl` is part of the wire (pushed up, §8) and the one file that syncs **down**. It is not
folded; readers and the CLI dedupe by event `id`.

## 7. `artifacts/` — attachments

Files attached to a moment via `attachments[]` on a run, ask, or close line. An attachment belongs to
the line that produced it (a checkpoint draft on its checkpoint, the deliverable on its report, proof
on its close) — **not** to the folded record, so an intermediate is never lost. Each file is
content-addressed (an unchanged file is skipped on publish; a re-attach of the same name with different
bytes is rejected — use a new name).

- **Renderable** (shown inline in a sandboxed viewer): `html`, `md`, `txt`, `json`, images
  (`.png .jpg .jpeg .gif .webp .svg`).
- **Download-only** (offered as a download, never rendered — lower risk, nothing executes):
  `.csv .pdf .xlsx .xls .docx`. Extensible.
- **Size:** keep each file **≤ ~10 MB**.
- Attachments are produced locally and **do not sync down** (a reference missing on a fresh clone is
  shown as "view it in the app", not downloaded).

## 8. Publishing (the wire contract)

Authenticated by a per-user token in the **`Authorization: Bearer <token>`** header. (The reference CLI
also sends the legacy `x-figs-token` through the v1→v2 transition; readers may accept both until the
minimum CLI version requires Bearer.)

**Up — `push`** sends:

1. **The spine** → `POST {endpoint}/api/ingest`, body:
   ```jsonc
   {
     "workspaceId": "<uuid>",        // from config.json
     "agent":    { /* agent.json */ },
     "runs":     [ /* runs.jsonl     */ ],   // optional
     "asks":     [ /* asks.jsonl     */ ],   // optional
     "messages": [ /* messages.jsonl */ ]    // optional — transcribed replies the reader lacks
   }
   ```
2. **Each attached file** → `POST {endpoint}/api/artifacts/upload`, base64-encoded, hash-verified.

The server upserts the agent by `id` and runs/asks by `id`; it dedupes messages by event `id`; it never
deletes. An agent **self-registers** on first push. **A push never walks a record backwards:** the
server refuses a fold older than the record's stored close/settle (a stale machine pushing old state)
and accepts a newer one (a legitimate reopen — the `warn` → `ok` evolution). **A push never re-homes an
agent:** a `workspaceId` differing from the agent's registered home is rejected `409`
`{ "error", "code": "agent_moved", "workspaceId"? }`; the agent recovers by setting
`config.json#workspaceId` to the named workspace and pushing again.

**Down — the reply sync.** Delivery is **agent-pulled**, never pushed into the repo: a reader exposes a
read returning **this agent's human messages** (answers/verdicts), which the CLI merges into
`messages.jsonl` (append-if-id-absent). It must return the agent's complete open surface or flag
truncation — a silently partial sync is forbidden. *(Only this — the human reply ledger — syncs down;
agent ledgers and attachments never do. The exact endpoint is finalized alongside the reader.)*

Because every push is authenticated, the receiver may stamp each newly created row with the pushing
identity ("pushed by") — it attributes the *credential*, not necessarily the human at the keyboard.
Agents never author this field.

## 9. Validation & versioning

- **Local validation is normative for conformance** and runs account-free (`figs doctor`). A reader's
  `POST {endpoint}/api/validate` is an additive second opinion, not the gate.
- **`figs-spec` is integer-versioned.** v2 is current. **Additive/optional** fields keep the version
  number; the number bumps only on a **breaking** change. (Implementations report support via
  `GET {endpoint}/api/version`.) v1 → v2 bumped because two-way reply flow and `messages.jsonl` are not
  additive to v1's one-way promise.
- The spec stays intentionally minimal — extensions arrive as additive optional fields until a breaking
  change is unavoidable.

## Reserved (not in v2)

Named here so implementers don't repurpose these concepts:

- **Human-initiated messages — `note` / `directive`.** A human starting a thread ("also send the email
  to X") rather than replying to an ask. The channel exists (`messages.jsonl` + the down-sync); these
  kinds and their anchoring (to a run, or standalone) are named-reserved.
- **Provenance / signing.** Cryptographic attestation that a report is complete, fresh, and untampered.
  v2 state is *self-reported*; treat it as visibility, not a tamper-evident audit trail.
- **Per-record visibility / scoping.** v2 publishes to a workspace where all members read everything.
- **Sync cursors / pagination.** The down-sync returns the agent's open surface whole (or flags
  truncation); cursors arrive when scale demands.

## 10. A complete example

```jsonc
// .figs/config.json   (linked; local mode would be just { "agentId": "…" })
{ "agentId": "…uuid…", "endpoint": "https://app.figs.so", "workspaceId": "…uuid…" }
```

```jsonc
// .figs/agent.json   (no `id` here — `figs init` puts it in config.json; the CLI attaches it on push)
{
  "name": "Reconciliation",
  "role": "Reconciliation Officer",
  "status": "in_dev",
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
  "units": [
    { "id": "acme", "name": "Acme Corp", "status": "88% matched · 31 keys flagged", "period": "2025-11",
      "stats": [ { "l": "Matched", "v": "2,161 keys" }, { "l": "Needs review", "v": "31 keys" } ] }
  ]
}
```

```jsonc
// .figs/runs.jsonl   (records fold by id — the checkpoint opened the job, the report settled it)
{ "id": "acme-2025-11", "ts": "2026-05-28T23:05:40Z", "unit": "acme", "period": "2025-11", "state": "in-flight", "result": "Statements pulled — matching now",
  "attachments": ["acme-wip.csv"], "session": { "runtime": "claude-code", "trigger": "monthly close cron" } }
{ "id": "acme-2025-11", "ts": "2026-05-28T23:41:26Z", "unit": "acme", "period": "2025-11", "result": "88% matched · 31 keys flagged", "status": "ok", "state": "settled",
  "attachments": ["acme-2025-11.html"], "session": { "runtime": "claude-code", "model": "claude-fable-5" } }
```

```jsonc
// .figs/asks.jsonl   (records fold by id — the close is an append, derived from the reply and citing it)
{ "id": "acme-bridge", "ts": "2026-05-28T21:05:00Z", "type": "question", "status": "open", "to": "manager", "unit": "acme", "run": "acme-2025-11",
  "title": "No bridge rule for prefixed invoice numbers",
  "found": "~180 rows can't be matched safely; guessing risks false matches.",
  "need": "Confirm the bridge rule for prefixed invoice numbers.",
  "options": [ "Strip the alpha prefix", "Use a mapping you provide", "Treat as out-of-scope" ],
  "details": [ { "l": "Amount at risk", "v": "$50.0M" } ],
  "attachments": [ "acme-2025-11.html" ] }
{ "id": "acme-bridge", "status": "resolved",
  "resolution": { "chosen": "Strip the alpha prefix", "via": "figs", "answer": "msg-7f3a", "by": "Sarah (accounting)",
                  "run": "acme-bridge-fix-2025-11", "ts": "2026-06-01T09:12:00Z" } }
```

```jsonc
// .figs/messages.jsonl   (the human's replies — events, not folded; deduped by id)
{ "id": "msg-7f3a", "kind": "answer", "ask": "acme-bridge", "by": "Sarah (accounting)", "ts": "2026-06-01T09:10:00Z",
  "source": "app", "chosen": "Strip the alpha prefix" }
```
