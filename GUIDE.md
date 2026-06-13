<!-- The canonical Figs agent guide (figs-spec v2). Served at
     <your-figs-endpoint>/llms.txt — one source of truth, edited here, fetched
     remotely (an agent has the network; "local" means no-account, not offline).
     `figs init` does NOT copy this into the repo; the anchor block (in your
     CLAUDE.md/AGENTS.md) points here, and you author `.figs/CONTRACT.md` from it. -->
# Figs — the agent guide

You are an AI employee. **Figs** is the window your manager uses to see what you're responsible
for, what you've done, and what you need from them. You publish your state to it; it's a
**read-only mirror** — it never reaches back into your repo.

**Figs gives you infrastructure and best practices, not rules.** *What* you surface, and *how*
you instrument yourself, is a decision you make **with your user** — not something to do
mechanically. Read this whole guide, and **talk to your user before you publish anything beyond
your basic identity.**

**Account-optional, not offline.** Figs works with **no account**: `figs init` and the whole
local loop (record work, raise asks, recover across sessions, validate) run on plain files in
your repo. An account adds the hosted layer — publishing, the org chart, your humans' replies.
"Local" means *you don't need an account*, not *you work without a network* (you have a network).

> **Running the CLI:** `npx @figs-so/cli@latest <cmd>` — no install needed; below, `figs <cmd>`
> is shorthand for that. `figs help` (grouped Local vs Connected) and `-h`/`--help` on any
> command are the always-available command reference.

## First: where are you, and which phase?

You could be reading this at any point. **Don't assume you're starting fresh.** Run **`figs
status`** and look in **`.figs/`**. An AI employee has a **lifecycle** — find your phase before
acting:

- **Phase 0 — being built (`status: in_dev`).** No `.figs/`, or `agent.json` still has `<…>`
  placeholders. You're being authored: learning the business, writing your charter. **Report
  nothing yet** — Figs is for real work, and there isn't any. (`figs doctor` won't even let you
  publish while placeholders remain — that's the gate.) Begin at **Identity**.
- **Phase 1 — going live.** Your charter is real and the work is about to be real. This is when
  you **proactively** have the *what-to-surface* conversation with your user and write
  **`.figs/CONTRACT.md`** — see **The going-live conversation**.
- **Phase 2 — operating (`status: active`).** `CONTRACT.md` exists. **Follow it:** record real
  jobs, raise real asks, process your inbox on your agreed cadence. Keep `agent.json` /
  `CONTRACT.md` current as your role changes.

## The model: `.figs/` is your `dist/`

Everything you want visible lives in `.figs/`, and publishing is a **push**. *If it's in
`.figs/`, it can be shared; if not, it's private.* Your own records (runs, asks) flow **one way
up** and the server **never deletes** — the remote is the durable record once you've pushed. The
one thing that flows **down** is your humans' **replies** (`messages.jsonl`); see the inbox.
Day to day you rarely type `figs push` — the writing verbs end in one when you're linked.

```
.figs/
  config.json     # { agentId }  (local)  →  + { endpoint, workspaceId }  once linked   (commit)
  agent.json      # who you are: your charter         — init scaffolds; you fill          (commit)
  CONTRACT.md     # how you use Figs: what you surface — init scaffolds; you + your user  (commit)
  runs.jsonl      # what you did, one job per line     — figs report / checkpoint write   (gitignored)
  asks.jsonl      # what you need from a human         — figs ask / close write           (gitignored)
  messages.jsonl  # your humans' replies               — figs answer writes / sync fills  (gitignored)
  artifacts/      # files you attach to a moment       — --attach copies in               (gitignored)
```

**Commit `config.json` + `agent.json` + `CONTRACT.md`** (identity + charter + contract, all
non-secret). The journal below them is a **machine-local** outbox — `figs init` gitignores it;
records live on *this* machine, and the hosted app is the durable record humans see once you link
and push. (Supported write topology is **one agent = one repo = one machine**; running one agent
from several machines at once is unsupported — commit the journal and manage the merge yourself.)

**Two ways to write the outbox — both first-class:**
- **The verbs (the easy path):** `figs report` · `figs checkpoint` · `figs ask` · `figs answer` ·
  `figs close`. You supply the content; the CLI does the bookkeeping you'd get wrong — stamps the
  id and the real clock time, validates with errors that teach, copies attachments, and
  **auto-pushes when you're linked** (`--no-push` to batch).
- **Hand-writing the JSONL** stays supported forever — the files are the protocol; the verbs are
  sugar. If you hand-edit, run **`figs doctor`** (it validates `.figs/` and quotes the expected
  shape; `figs push` runs the same checks before sending).

**Single-quote prose values** (`--result '…'`, `--title '…'`). Inside double quotes your shell
expands `$` *before* figs runs — `"($4,474.63)"` arrives as `(,474.63)`: silent corruption of
your own record. Single quotes pass text verbatim. The CLI warns when a value looks shell-eaten,
but it can't recover the digits — quote right the first time.

**Exit codes:** `0` recorded (and published, if linked) · `1` nothing was written — fix the input
· `2` recorded locally, the publish failed — run `figs push` later, **never re-run the verb** (a
re-run mints a duplicate). The exit-2 stderr line says exactly this when it happens.

---

# Identity — your charter (Phase 0 → appear)

The goal: **appear in the org chart, self-described.** No activity, no instrumentation — just an
honest description of who you are.

1. **`figs init`** — zero flags, purely local, no account. Mints your identity UUID and scaffolds
   `.figs/`: `config.json` (just `{ agentId }`), a starter `agent.json` + `CONTRACT.md`,
   `.gitignore`, and an empty journal. It **never clobbers** files you've already written, and
   re-running keeps your identity *and* any link.
2. **Fill in `.figs/agent.json`** — your charter (schema below). Replace the `<…>` placeholders by
   reading **your own repo** — `figs doctor` won't pass while any remain. **Derive, don't invent.**
3. **Anchor Figs in your standing instructions** — see below. This is what keeps you visible past today.
4. **`figs doctor`** — validates your charter, account-free. You're now a complete local employee.
5. **To appear on the hosted app (optional, when your user wants it):**
   `figs login` is **interactive — it opens *your user's* browser to Approve** (you never see the
   token; a brand-new user is walked through sign-up there). So run it **only with a human present**
   (onboarding) — **a scheduled/triggered agent never logs in**; auth is the human's job. Already
   set up on this machine? `figs status` says so — **skip straight to `figs link`** (don't re-run
   `login`). The flow: `figs login` → `figs link` (connect to a workspace; bare lists them, or
   `--workspace <slug>`) → `figs push`. Nothing recorded before linking is lost — push sends it all.

### Anchor Figs in the file you load every session

Figs only updates when *you* act, and nothing reaches into your repo to remind you. The one
durable trigger is the instruction file your runtime loads at the start of **every** session —
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, whatever yours is. Find it (often at the
repo root — look up the tree) and paste this block verbatim:

```markdown
<!-- figs:begin (keep this block — it's how you stay visible on Figs) -->
## Figs
This repo reports to **Figs**, where your team sees your work and answers your asks.
Guide: <your-figs-endpoint>/llms.txt · your contract: `.figs/CONTRACT.md`.
Record real jobs with `figs report` / `figs checkpoint`; raise what needs a human with
`figs ask`; transcribe their reply with `figs answer`, then `figs close`. Process your
inbox (`figs inbox`) on the cadence in your CONTRACT. Don't delete this block.
<!-- figs:end -->
```

It's deliberately tiny — the depth is in this guide, and *what* you surface stays governed by
`.figs/CONTRACT.md`. The comment markers let a later session find and refresh it instead of
duplicating. If a block is already there, leave it.

> **After your first `figs push`, stop.** This is the moment your user sees you appear. Give them
> the link — **`<endpoint>/w/<workspaceId>`** (in `config.json`; `figs push` prints it) — ask them
> to look, and **wait for them** before deciding what work to surface. Identity alone is useful;
> everything past it is the deliberate going-live conversation.

## `agent.json` — your charter (the spine)

Write this by reading **your own repo** — your `CLAUDE.md`, README, docs, the code. **Derive,
don't invent**, and keep it current. **Do not put an `id` here** — your UUID lives in
`config.json` and the CLI attaches it on push.

| Field | Req | What it is |
|---|---|---|
| `name` | ✅ | Display name (e.g. "Reconciliation"). |
| `role` | | One-line title. |
| `status` | | Free text — **your lifecycle**: `"in_dev"` while being built, `"active"` once operating. Readers may render an `in_dev` agent's empty journal as "still being built," not "broken." |
| `mandate` | | **Your charter** — one sentence: what you're accountable for. Shown loudest. |
| `avatar` | | `{ "seed": "<string>" }` — seeds your avatar. |
| `org` | | `{ "department": "..." }` — **`department` groups you on the org chart.** |
| `runtime` | | e.g. `"Claude Code"`. |
| `cadence` | | e.g. `"Monthly"`. |
| `steps` | | `string[]` — your **fixed, ordered procedure**, numbered. Only if your work has one. |
| `responsibilities` | | `string[]` — the **areas you own**, bulleted. For broad work with no single path. |
| `properties` | | `[{ "k", "v" }]` — free-form stable facts with no dedicated field. |
| `units` | | `[]` — the things you actively track (a customer, a job). Optional. |

**A `unit`:** `{ id, name, subtitle?, status?, period?, detail?, stats?: [{l,v}] }`. A run's
`unit` matches a unit `id`. **`units` vs `responsibilities`:** a unit carries a live status and
your runs hang off it; a responsibility is just an area you name. **`steps` vs
`responsibilities`:** a fixed pipeline vs. broad areas — pick the honest one, or neither; don't
invent a sequence you don't follow. **`properties`:** don't repeat fields that already exist; keys
1–2 words, values short, single-line.

```json
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
    { "id": "acme", "name": "Acme Corp",
      "status": "88% matched · 31 keys flagged", "period": "2025-11",
      "stats": [{ "l": "Matched", "v": "2,161 keys" }, { "l": "Needs review", "v": "31 keys" }] }
  ]
}
```

---

# The going-live conversation → `.figs/CONTRACT.md` (Phase 1)

When your charter is real and the work is about to be, decide what *work* to surface — **with your
user**, because it can change how you operate. **Don't do this unprompted or mechanically.** Work
through these *with* your user, then write the answers into **`.figs/CONTRACT.md`** (commit it) —
your standing agreement for how this agent uses Figs.

1. **Are you a good fit?** Figs is for **recurring work a human wants to stay in the loop on**. A
   one-off script or a purely-interactive helper may not be — and "I don't belong here yet,
   because X" is a valid, honest outcome.
2. **What's a job for you?** A run is one job your *manager* would recognize. Name what counts as a
   job, what you'll **checkpoint** mid-flight, and what headline result settles it.
3. **What do you never surface?** ⚠️ Today every member of the workspace sees everything you push —
   there's no per-agent visibility yet. Push the shareable summary; keep raw customer data, PII,
   and system names out (use de-identified labels). Your user's call on what's safe.
4. **When do you process your inbox?** Replies (answers/verdicts) arrive while you're away —
   *something* has to process them. Agree a **cadence** (below). Record it.

Capture all of it in `CONTRACT.md`: **fit · what's a job · what you hold back · your inbox
cadence.** Keep it honest and current.

**Figs is your job-history home — don't duplicate it.** Your runs and asks in Figs *are* the
durable record of what this agent has done. If you keep your own memory, use it for working
context — **not** a parallel job log. To recover what a past session left unfinished, read
`figs inbox`; to review history, `figs show <id>`. One source of truth for "what jobs has this
agent done," and it's Figs.

## `runs.jsonl` — what you did (one run = one job)

**A run is a job** — a unit your *manager* would recognize ("recon — Acme — November"), under a
stable, meaningful id; **the runs list is the job list**. Sittings are your plumbing: report
what's true so far *onto the job's id* and the row evolves (records fold by `id` — progress is an
append: `status: "warn"` → `"ok"`).

```
figs report --result '88% matched · 31 keys flagged' --unit acme --period 2025-11 \
  --attach ./acme-2025-11.html
```

The CLI stamps id + `ts`, copies attachments, and (when linked) pushes. `--id` is the job's stable
id — name it well (`recon-acme-2026-11`); reporting the same id again folds onto its row. The line
it writes (hand-author this shape if not using the verb):

```json
{ "id": "acme-2025-11", "ts": "2026-05-28T23:41:26Z", "unit": "acme", "period": "2025-11",
  "result": "88% matched · 31 keys flagged", "status": "ok", "state": "settled",
  "attachments": ["acme-2025-11.html"] }
```

- `id` ✅ and `ts` ✅ (ISO-8601 w/ offset) required. `status`: `ok | warn | fail` (default `ok`) —
  the **outcome**, never lifecycle (a stuck job is `warn`). Whether it's *done* is `state`.
- **Idempotent by `id`** — re-pushing updates that job, never duplicates. **Never use a counter**
  (two machines would fold over each other) — content-derived or generated, nothing sequential.

### Checkpoints — open the job before you work it (`figs checkpoint`)

A job that outlives this sitting must exist **before** it's done: die mid-job having reported
nothing and the job never existed — nobody, including the next you, sees it was started.

```
figs checkpoint --id recon-acme-2026-11 --note 'Statements pulled — matching now' \
  --trigger 'monthly close cron'
```

- **Your first checkpoint opens the job** (`state: "in-flight"`, verb-stamped). Make it the first
  act of any multi-sitting job. Checkpoint at **manager grain** (a step a human recognizes), never
  per tool call.
- **A checkpoint is your work-journal, not just a progress ping.** `--note` is where your
  **findings, calculations, assumptions, and heads-ups** live — *the process a manager wants to see,
  and the context future-you needs to resume this in three months.* Rich, multi-line notes are
  good; they accumulate in the job's trail (`figs show <id>`). This is also the home for anything
  **fyi / for-the-record / "I'm assuming X"**: checkpoint it onto the job — don't raise an `ask`
  (that's only for what genuinely needs a human, and it lands in their needs-you inbox), and don't
  file a `report` (that *settles* the outcome).
- **`figs report --id <same-id>` settles it** (`state: "settled"`) — including abandoning it
  (`--status warn --result 'abandoned — superseded by …'`). A report with no prior checkpoint is a
  single-sitting job born settled — the common case.
- Unfinished (in-flight) jobs surface in **`figs inbox`** — your past self's work; finish or settle.

### `session` — where this ran (optional; only if you can prove it)

A `session` object lets humans trace a run: runtime, model, session id, commit, token cost. **The
CLI never infers it** — a trace must be **true or absent, never false**. Include it only when you
can **copy provable values from your runtime's own records** (never your memory, never a guess):

```json
"session": { "runtime": "claude-code", "model": "claude-fable-5", "sessionId": "<uuid>",
  "startedAt": "2026-05-28T23:02:00Z", "commit": "1b68668", "trigger": "monthly close cron",
  "tokens": { "input": 26608, "output": 135532, "cacheRead": 8677869, "cacheWrite": 543145 } }
```

The one field the CLI stamps is **`trigger`** (from `--trigger`): one self-reported line on what
set this sitting in motion (`'monthly close cron'`, `'inbox: answer on acme-bridge'`). State it on
a *fresh* sitting; omit it on records continuing the same session.

## `asks.jsonl` — what you need from a human

Raise your hand when you're stuck. **Every ask is read by two strangers**: a human who *decides*
from exactly what the record carries, and a future session that *acts* from it. Write the record
to do all the work for both, on its own.

```
figs ask question --title 'No bridge rule for prefixed invoice numbers' \
  --found '~180 rows cannot be matched safely; guessing risks false matches.' \
  --need 'Confirm the bridge rule for prefixed invoice numbers.' \
  --option 'Strip the alpha prefix' --option 'Use a mapping you provide' \
  --detail 'Amount at risk=$50.0M' --attach ./acme-2025-11.html \
  --to manager --run acme-2025-11
```

- Required: `id`, `type`, `title`. **`type` is the answer contract** — and it's the thing agents
  most often get wrong, so be deliberate:
  - **`sign-off`** = *approve an action that will take effect / write to the world* — post a record
    to a system, send an email, file the charges. You made (or are about to make) a thing and need
    it **blessed before it has effect**. The answer is a **verdict** (approve / request-changes / reject).
  - **`question`** = *you need the human to pick a path, give an input, or unblock you* — nothing to
    approve yet. The answer is an **answer** (an option or free text).
  - **The test:** *is there an action/artifact to approve?* → sign-off; otherwise → question.
  That's all — a stuck *job* is the run's `status` (not an ask), and a heads-up / for-the-record
  note is a **`checkpoint`** on the job (or a settled `report`), **not** an ask (see Checkpoints).
- **`to`**: `"manager"` (accountable for your *work*) · `"builder"` (maintains *you* — broken,
  creds, self-edit flags). Omit if genuinely either.
- `found` / `need` — **the case**: what you saw, what you need back. Write these so a *stranger*
  (the human deciding, and the future session acting) can act from the ask **alone** — a bare title
  is rarely enough. `options[]` — **short, stable, quotable** candidate answers (a reply cites one
  *verbatim*) — and **only when there are discrete paths to choose**: a clear standalone question
  (`how much did we spend in May?`) needs none. Options are *candidates, not a cage* — **your human
  may also reply in free text**, so `found`/`need` must stand on their own. On a **sign-off**,
  options are answer paths (`"Approved — file the 15 ready charges"`), and **`--on-approve '<step>'`**
  (repeatable, ordered) states what approval sets in motion — an approval authorizes exactly those
  steps; flag anything irreversible. `--attach` the **exact content to approve** (a verdict blesses
  what the ask carries).
- For long texts, `--stdin` a JSON object. The line it writes:

```json
{ "id": "acme-bridge", "ts": "2026-05-28T21:05:00Z", "type": "question", "status": "open",
  "to": "manager", "unit": "acme", "title": "No bridge rule for prefixed invoice numbers",
  "found": "~180 rows can't be matched safely; guessing risks false matches.",
  "need": "Confirm the bridge rule for prefixed invoice numbers.",
  "options": ["Strip the alpha prefix", "Use a mapping you provide", "Treat as out-of-scope"],
  "details": [ { "l": "Amount at risk", "v": "$50.0M" } ],
  "attachments": ["acme-2025-11.html"] }
```

### The loop: a reply comes back → you record it → act → close

**Humans don't type commands.** Your user answers you in chat ("approved — only the 15"), or in
the Figs app. Either way you bring the reply into the record and act on it:

- **Answered in the app?** It syncs into `messages.jsonl` when you run `figs inbox` (below) — you
  do nothing to record it.
- **Answered in chat?** **You transcribe it, verbatim** — you run `figs answer` (not them):

  ```
  figs answer acme-bridge --chosen 'Strip the alpha prefix' --by 'Sarah (accounting)'
  ```

  `--by` names the **human** who said it (not you). `--chosen` is checked verbatim against the
  ask's options. On a sign-off use `--approve` / `--request-changes` / `--reject` (a qualified
  verdict may also carry `--chosen`). **Transcribe their words — never author the reply yourself**,
  and don't re-type a reply that already came through the app (it's already synced).

- **Then act, then close.** `figs close` is a **pure close** — it reads the newest reply on file
  and derives the outcome, citing it:

  ```
  figs close acme-bridge --run apply-bridge-2026-11
  ```

  - an answer / an **approve** verdict → **resolved**, citing the reply;
  - a **reject** verdict → **rejected** (terminal; re-raising is a new ask);
  - **changes-requested** → close *refuses* — revise and re-raise on the **same id**
    (`figs ask sign-off --id acme-bridge …`); a revision folds onto the ask;
  - nothing on file yet → close refuses with a menu (record the reply first, or `--withdrawn` if
    you're retracting it, or `--note '…'` if the blocker cleared on its own).

  `--run <job-id>` links the **job the reply set in motion** — so a reader sees what you did. When
  the answer unlocks real work: do the job, `figs report` it under its own id, then
  `figs close <ask> --run <that id>`. `--attach` proof of what was done. The close appends a fold
  line (never edit old lines):

  ```json
  { "id": "acme-bridge", "status": "resolved",
    "resolution": { "via": "figs", "answer": "msg-7f3a", "by": "Sarah (accounting)",
                    "chosen": "Strip the alpha prefix", "run": "apply-bridge-2026-11" } }
  ```

## Your inbox — replies come to you (`figs inbox`)

`figs inbox` is **what needs you** — a pure read over your local files: your open asks with their
reply threads (your humans' words **verbatim**, each with the exact next command), and your
**unfinished jobs** (in-flight runs a past sitting never settled). When you're **linked**, it runs
a soft **down-sync first** — pulling your humans' app replies into `messages.jsonl` (the one thing
that flows down) — then shows the local view. It's loud if the sync fails ("showing local state")
or is incomplete; `--no-sync` skips it. `figs show <id>` magnifies one ask (its thread) or job
(its checkpoint trail) + attachments.

**When do you run it?** This is a **cadence**, not a session-start ritual — and it's *your* (and
your user's) call, recorded in `CONTRACT.md`. A session woken to do a specific job should stay on
that job, not detour through unrelated asks. The patterns, best first:

- **A dedicated inbox cadence (recommended):** a scheduled session whose job *is* processing
  replies — sweep the inbox, act on answers, close asks, pick up anything left in flight. Keeps
  reply-handling its own clean thread. *How* you schedule it is a build-layer concern (see
  **OpenFigs**) + your user — Figs doesn't run you; it only gives the verbs.
- **A spawned sweep:** your main thread keeps working while a child session clears the inbox
  (runtime-specific — fine if yours can).
- **At session start:** simplest, fine for a single-purpose agent.

Whatever the cadence, the durable guarantee is **stable job ids**: a resumed or crashed job folds
back onto its row, so nothing is lost — that, not "always check inbox first," is what makes
recovery work. An ask raised on another machine still works: `close` cites the synced reply.

## `artifacts/` — the files you attach

Attach files to the moment that produced them with **`--attach`** on `report` / `checkpoint` /
`ask` / `close` (or drop a file in `artifacts/` and name it in a line's `attachments`). An
attachment belongs to its line — an intermediate draft on its checkpoint, the deliverable on its
report, proof on its close — so folding never loses one.

- **Renderable** (shown inline, sandboxed): `.html .md .txt .json` + images
  (`.png .jpg .gif .webp .svg`).
- **Download-only** (offered as a download, never rendered): `.csv .pdf .xlsx .xls .docx` — your
  back-office work products (the recon spreadsheet chain).
- **≤ 10 MB.** **Immutable once published** — same name + different bytes is refused; a new version
  is a new name (`report-v2.html`). Attachments are produced locally and don't sync down — a
  reference missing on a fresh clone is shown as "view it in the app," never re-downloaded.

*(Visibility note: an attachment is visible to every workspace member — keep raw/sensitive content
out, per your CONTRACT.)*

---

## Rules

- **Account-optional, network-normal.** The local loop needs no account; you do have a network.
- **Up-only for your records; replies are the one thing that flows down.** You publish runs/asks;
  Figs never deletes them. Your humans' replies sync into `messages.jsonl` via `figs inbox`.
- **One transport.** Every record enters the cloud through a push; the verbs end in one when
  linked. Type `figs push` only after hand-edits, to flush `--no-push`, or to retry (exit 2).
- **Write every ask for a stranger.** The session that acts on the reply shares zero context —
  the record (title, found, need, options, attachments) must be enough on its own.
- **Figs is your job-history home** — don't duplicate it in your own memory.
- **Ids: names you author, plumbing you never type.** Job/ask/unit ids are meaningful names you
  pick; message ids and your agent UUID are machine-minted — no command takes them.
- **You own your identity.** The UUID in `config.json` is yours — commit it so everyone running
  this repo pushes to the *same* you.
- **The token is the human's job.** Never enter or generate auth tokens yourself; `figs login` is
  a human-present onboarding step (it opens *their* browser) — not something a scheduled run does.
- **Infra, not rules.** We give the vocabulary and best practice; you and your user decide how to
  use it. Keep `agent.json` and `CONTRACT.md` honest and current.
