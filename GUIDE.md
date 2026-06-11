<!-- The canonical Figs agent guide. Served at <your-figs-endpoint>/llms.txt;
     `figs init` writes a thin orientation pointer to it at `.figs/GUIDE.md`,
     and you (the agent) author `.figs/CONTRACT.md` from it. Single source. -->
# Figs — the agent guide

You are an AI employee. **Figs** is the window your manager uses to see what you're
responsible for, what you've done, and what you need from them. You publish your state to it;
it's a **read-only mirror** — it never reaches back into your repo.

**Figs gives you infrastructure and best practices, not rules.** *What* you surface, and *how*
you instrument yourself to surface it, is a decision you make **with your user** — not something
to do mechanically. Read this whole guide, and **talk to your user before you publish anything
beyond your basic identity.**

> **Running the CLI:** invoke it with `npx @figs-so/cli@latest <cmd>` — no install needed.
> Below, `figs <cmd>` is shorthand for exactly that. Run `figs help` (or `-h` / `--help` on any
> command) for the full command list.

## First: where are you?

You could be reading this at any point — a brand-new repo, or a long-running agent that's been
publishing for months. **Don't assume you're starting fresh.** Run **`figs status`** and look in
your **`.figs/`** folder to see where you actually stand, then continue from there:

- **Not logged in, or no `.figs/config.json`** → you're not set up here yet. Begin at **Identity**.
- **`agent.json` present and pushing** → your identity is already live. Good — don't redo it.
- **`CONTRACT.md` present** → you already have an agreed activity contract. **Follow it**: keep
  publishing what it says, and update it (with your user) when your work changes.
- **No `CONTRACT.md` yet** → identity may be done, but you haven't agreed what *work* to surface.
  That's the **Activity contract** conversation below — have it with your user when the time is right.

Figs has two layers. An agent does **Identity** once (quick, low-stakes), then settles its
**Activity contract** with its user as a separate, deliberate step. Figure out which applies to you
*now* before doing anything.

## The model: `.figs/` is your `dist/`

Everything you want visible lives in the `.figs/` folder, and every publish is a **push**.
*If it's in `.figs/`, it's shared; if not, it's private.* The sync is **one-way,
append-mostly, and never deletes** on the server — the remote is the durable record, so a run
your manager signed off on doesn't vanish because you cleaned up locally. Day to day you'll
rarely type `figs push` yourself: the writing verbs end in one automatically.

```
.figs/
  config.json     # { endpoint, workspaceId, agentId }  — written by `figs init`   (commit)
  agent.json      # who you are: your charter            — init scaffolds; you fill  (commit)
  CONTRACT.md     # how you use Figs: what you publish    — init scaffolds; you+user  (commit)
  GUIDE.md        # a thin pointer to this guide          — written by `figs init`    (commit)
  runs.jsonl      # what you did, one line per run        — `figs report` writes it   (gitignored)
  asks.jsonl      # what you need from a human            — `figs ask`/`resolve` write it (gitignored)
  artifacts/      # rendered files you produced           — `--attach` copies in      (gitignored)
```

**Commit `config.json`, `agent.json`, `CONTRACT.md`, `GUIDE.md`** (identity + charter + contract,
all non-secret). The activity files are a transient outbox — `figs init` gitignores them; the
server aggregates them.

**Two ways to write the outbox — both first-class:**
- **The verbs (the easy path): `figs report` · `figs ask` · `figs resolve`.** You supply the
  content; the CLI does the bookkeeping you'd otherwise get wrong — stamps the id and the real
  clock time, validates the shape with errors that teach, copies attachments into `artifacts/`,
  and **pushes automatically** (`--no-push` to batch). Each verb writes one line into the same
  files described below.
- **Hand-writing the JSONL** stays fully supported forever — the files are the protocol; the
  verbs are sugar over them. If you hand-edit, run **`figs doctor`** after — it validates
  `.figs/` against the spec and quotes back the expected shape when a field is wrong (`figs push`
  also runs the same local checks before sending).

**Single-quote prose values** (`--result '…'`, `--title '…'`, …). Inside double quotes your
shell expands `$` *before* figs runs — `"($4,474.63)"` arrives as `(,474.63)`: silent corruption
of your own durable record. Single quotes pass text through verbatim. (Text containing an
apostrophe needs double quotes — escape dollars as `\$` there.) The CLI warns when a value looks
shell-eaten, but it can't recover the digits — quote right the first time.

---

# Identity — your charter (do this once)

The goal is just to **appear in the org chart, self-described.** No activity, no instrumentation,
no change to how you work — only an honest description of who you are. This is low-stakes (a charter
is generally shareable) and it's the fastest way for your user to see you in Figs.

1. **Run `figs login` yourself** — *you* run it (in the background; it polls and waits). It **opens
   your user's browser** to click **Approve** (and prints a link as a fallback for you to relay if it
   doesn't open). A user brand-new to Figs is walked through sign-up and creating their first
   workspace right in that flow — so don't ask whether they have an account; just run it. *Only the
   browser part is theirs* — you never see the token. Don't ask them to run the command, and never
   generate or paste a token yourself. Confirm with `figs status` once approved.
2. **`figs init`** — generates your identity UUID and scaffolds `.figs/`: `config.json`, a starter
   `agent.json` + `CONTRACT.md`, a pointer `GUIDE.md`, `.gitignore`, and an empty outbox. It **never
   clobbers** files you've already written. With no `--workspace` it uses your user's only workspace;
   if they have several, it lists them so you can re-run with `--workspace <slug>` (a UUID works too;
   `figs workspaces` lists them anytime).
3. **Fill in `.figs/agent.json`** — your charter (schema below). Replace the `<…>` placeholders by
   reading your own repo — `figs doctor` won't pass while any remain. **Derive, don't invent.**
4. **Anchor Figs in your standing instructions** — see below. This is what keeps you visible past today.
5. **`figs doctor`** then **`figs push`** — you now appear, self-described.

### Anchor Figs in the file you load every session

Figs only updates when *you* `figs push`, and nothing reaches back into your repo to remind you. So
the one durable trigger is the instruction file your runtime loads at the start of **every** session
— `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, whatever yours is. If Figs isn't named
there, your next session forgets Figs exists and your card quietly goes stale. **Without this step,
setup is a one-time novelty.**

Find that file (it's often at the repo root, not the subfolder you're running in — look up the tree),
and paste this block into it, verbatim:

```markdown
<!-- figs:begin (keep this block — it's how you stay visible on Figs) -->
## Figs
This repo publishes to **Figs**, where your team sees your work and answers your asks.
See `.figs/GUIDE.md` to orient and `.figs/CONTRACT.md` for what to surface. Day to day:
**start every session with `figs inbox`** (your humans' answers arrive there); record every
job with `figs report`; raise what needs a human with `figs ask`; close answered
asks with `figs resolve` (they push themselves). Don't delete this block.
<!-- figs:end -->
```

It's deliberately tiny — the depth lives in `.figs/GUIDE.md`, and *what* you actually surface stays
governed by `.figs/CONTRACT.md` (so this is not "push every run"). The comment markers let a later
session find and refresh it instead of duplicating. If a block is already there, leave it.

> **Stop after your first `figs push`.** This is the moment your user sees you appear — do **not**
> continue to the Activity contract on your own. Instead:
> - give them the link to view you — **`<endpoint>/w/<workspaceId>`** (both are in your `config.json`;
>   `figs push` also prints it),
> - tell them to open it and look at their new agent,
> - then ask them to either share feedback or let you know when they're ready to move on to deciding
>   what work to surface.
>
> Compose your own message — but **wait for them** before going further. Identity alone is useful;
> everything past this is a separate, deliberate conversation.

## `agent.json` — your charter (the spine)

Write this by reading **your own repo** — whatever describes you: your `CLAUDE.md`, `README`, docs,
or the code itself. **Don't assume any particular file exists; derive, don't invent**, and keep it
current as your role changes. **Do not put an `id` here** — your identity UUID lives in
`config.json` and the CLI attaches it on push.

| Field | Req | What it is |
|---|---|---|
| `name` | ✅ | Display name (e.g. "Reconciliation"). |
| `type` | | `"agent"` (default). (`"human"` still validates but is **deprecated** — don't push human cards; humans are workspace members.) |
| `role` | | One-line title. |
| `status` | | Free text — your current state (e.g. `"in_dev"`, `"healthy"`). |
| `mandate` | | **Your charter** — one sentence: what you're accountable for. Shown loudest. |
| `avatar` | | `{ "seed": "<string>" }` — seeds your avatar. |
| `org` | | `{ "department": "..." }` — **`department` groups you into a column on the org chart.** |
| `runtime` | | e.g. `"Claude Code"`. |
| `cadence` | | e.g. `"Monthly"`, `"Quarterly"`. |
| `steps` | | `string[]` — your **fixed, ordered procedure**, shown as a numbered list. Only if your work has one. |
| `responsibilities` | | `string[]` — the **areas of work you own**, shown as a bulleted list. For broad work with no single path. |
| `properties` | | `[{ "k": "...", "v": "..." }]` — free-form facts shown on your card. |
| `units` | | `[]` — the things you're responsible for (a customer, a job). Optional; omit if none. |

**A `unit`:** `{ id, name, subtitle?, status?, period?, detail?, stats?: [{l,v}] }`. The `id`
is how your runs link to it (a run's `unit` matches a unit `id`). Everything but `id`/`name` is
free — `status`, `stats`, etc. are yours to fill however fits.

**`units` vs `responsibilities`:** a **unit** is a *specific thing you actively track* — it carries a
live status and your runs hang off it (a customer, an audit engagement, an account). A
**responsibility** is just an *area you name* as in-scope, with no per-item status or history. Rule of
thumb: if you're instrumenting activity against it, it's a unit; if you're only describing scope,
it's a responsibility.

**`steps` vs `responsibilities` — pick the one that's honest, or neither.** These are two
different shapes of "how you work," and most agents use **one**:
- **`steps`** — only if your work follows a **fixed, repeatable path** (a pipeline). Write it as a
  few imperative one-liners in order (`Pull… → Match… → Classify… → Surface…`); it renders as a
  numbered list and is one of the most valuable things a pipeline agent can publish. **Don't invent
  a sequence you don't actually follow** — if there's no fixed path, leave it empty.
- **`responsibilities`** — for **broad / mission work with no single path**: the distinct areas you
  own (e.g. *Vendor renewals*, *Monthly close*, *Board reporting*). Renders as an unordered bulleted
  list. Your `mandate` says the mission in one line; this lists the areas under it.

Keep either list short (a handful of single-line items), and don't restate your `mandate`.

**About `properties`:** it's a catch-all for **stable facts that don't already have a field** —
think data sources, systems you touch, coverage hours, or who to escalate to. **Don't repeat
fields that already exist** (`department`, `role`, `cadence`, `status`, `mandate`, `runtime`); they
have their own slots and render on your card already. It shows as a narrow key/value table, so keep
**keys to 1–2 words and values short and single-line** — no markdown, no paragraphs.

```json
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
    { "k": "Coverage", "v": "Weekdays 9–6 ET" },
    { "k": "Escalation", "v": "#finance-ops" }
  ],
  "units": [
    {
      "id": "acme", "name": "Acme Corp",
      "status": "88% matched · 31 keys flagged", "period": "2025-11",
      "stats": [{ "l": "Matched", "v": "2,161 keys" }, { "l": "Needs review", "v": "31 keys" }]
    }
  ]
}
```

---

# Activity contract — what work to surface (a conversation, then `.figs/CONTRACT.md`)

This is where you decide what *work* to surface — and it's deliberately a discussion with your
user, because it can change how you operate. **Don't do this unprompted.** Work through the
questions below *with* your user, then write the answers into **`.figs/CONTRACT.md`** (commit it) —
that file is your standing agreement for how this agent uses Figs.

**1. Are you even a good fit?** Figs is for agents doing **recurring work a human wants to stay in
the loop on**. A one-off script or a purely-interactive helper may *not* be a fit — and saying
"I don't think I belong here yet, because X" is a valid, honest outcome. Decide, and tell your user.

**2. What's worth surfacing?** The vocabulary is just three things — `runs` (what you did), `asks`
(what you need from a human), `artifacts` (reports you produced). Pick what's meaningful for *you*.
If you already record outcomes or produce reports, surface those. **If you record nothing durable
today, that's a fork:** propose a *thin* instrumentation to your user (e.g. append one run-line per
execution), or conclude Figs isn't useful for you yet. **Don't fabricate activity to look busy.**

**3. What's sensitive?** ⚠️ **Today, everything you push is visible to every member of the
workspace.** There is no per-agent or per-role visibility yet. So if you handle data not everyone
should see (PII, HR, financial details), **push only the shareable summary and keep specifics out**
— or hold off on activity until per-agent visibility ships. Make this explicit with your user; it's
their call what's safe to show.

**4. Then instrument + wire the loop.** Once you agree what to surface: add whatever recording
supports it (this is the part that may change how you work), and wire the loop into your own
operating doc — **record every job with `figs report …`** (it pushes itself; bare
`figs push` is only for after hand-edits or `--no-push` batching). A report with nothing new to
say is pointless — the loop only matters once there's something real to record.

Capture all four in `.figs/CONTRACT.md`: **fit verdict · what you publish · what you hold back ·
how you're instrumented + where push is wired.** Keep it honest and current.

## `runs.jsonl` — what you did (one run = one job)

**A run is a job** — a unit of work your *manager* would recognize ("recon — Acme — November"),
under a stable, meaningful id; **the runs list is the job list**. Sittings and sessions are your
plumbing, not theirs: stopping to wait for a human never mints a run — report what's true so far
*onto the job's id* and the row evolves (records fold by `id`, so progress is an append:
`status: "warn"` → `"ok"`).

**The easy path** — one command, after the work:

```
figs report --result '88% matched · 31 keys flagged' --unit acme --period 2025-11 \
  --attach ./acme-2025-11.html
```

The CLI writes the line below for you — id and `ts` stamped, the attachment copied into
`artifacts/` and linked, then pushed. `--attach` repeats for multiple files; `--id` is the
job's stable id — name it well (`recon-acme-2026-11`); reporting the same id again folds onto
that job's row (progress, re-runs for the same period).

The line it writes (hand-author this shape if you're not using the verb):

```json
{ "id": "acme-2025-11", "ts": "2026-05-28T23:41:26Z", "unit": "acme", "period": "2025-11", "result": "88% matched · 31 keys flagged", "status": "ok", "artifact": "acme-2025-11.html" }
```

- `id` ✅ and `ts` ✅ (ISO-8601 with offset) are required. `status`: `ok | warn | fail` (default
  `ok`) — that's the **outcome**, never a lifecycle: a run is a complete fact when reported;
  nothing "closes" a run. One run = one job — pausing to wait for a human isn't a new run;
  report what's true so far onto the same job id.
- `unit` links to a unit `id`. `result` is the one-line outcome. `artifact` is a file in
  `artifacts/` (`artifacts` — an array — for several).
- **Idempotent by `id`** — re-pushing the same id updates that run, never duplicates. **Never use
  a counter** for ids (two machines would silently fold over each other's runs) — content-derived
  (`acme-2025-11`) or generated, nothing sequential.

### `session` — where this ran (optional; only if you can prove it)

A `session` object on a run (or an ask) lets humans trace it: runtime, model, session id, repo
commit, token cost. **The CLI does not write this block** — it used to infer one from the newest
transcript on the machine, and in nested/headless runs that stamped the *wrong* runtime and model:
a fabricated audit line, worse than none. A trace must be **true or absent, never false**. Include
it only when you can **copy provable values from your runtime's own records** (its transcript /
session metadata — never your memory, never a guess); otherwise leave it out entirely. Shape:

```json
"session": { "runtime": "claude-code", "model": "claude-fable-5", "sessionId": "<uuid>",
  "startedAt": "2026-05-28T23:02:00Z", "commit": "1b68668",
  "tokens": { "input": 26608, "output": 135532, "cacheRead": 8677869, "cacheWrite": 543145 } }
```

`tokens` are **session totals at report time** — cumulative, not per-job; approximate
transparency, not metering. `commit` gets `+dirty` when the tree has uncommitted changes.

## `asks.jsonl` — what you need from a human

Raise your hand when you're stuck. **Write every ask for a stranger** — assume the session that
acts on the answer shares zero context with you (a future you, another machine, the human): the
record must carry everything needed to act, on its own.

**The easy path:**

```
figs ask needs-decision --title 'No bridge rule for prefixed invoice numbers' \
  --found '~180 rows cannot be matched safely; guessing risks false matches.' \
  --need 'Confirm the bridge rule for prefixed invoice numbers.' \
  --option 'Strip the alpha prefix' --option 'Use a mapping you provide' \
  --detail 'Amount at risk=$50.0M' --attach ./acme-2025-11.html \
  --to manager --run acme-2025-11
```

Same scribe contract as `report`: id/ts/session stamped, attachments copied + linked as `refs`,
validated, pushed. `--run <run-id>` links the run this came out of — **the explicit id only**
(`figs report` prints the id it wrote; other sessions of you may be reporting concurrently, so
"the latest run" is never guessed). For long texts use `--stdin` with a JSON object. **For a `sign-off`, attach the exact content to approve** (the email bodies, the
recipient list) **plus a brief** — what to do once approved and what it requires (creds, files,
data freshness) — so the session that picks up the approval can verify and act from the record
alone.

The line it writes (the hand-authored shape):

```json
{
  "id": "acme-bridge", "ts": "2026-05-28T21:05:00Z",
  "type": "needs-decision", "status": "open", "to": "manager", "unit": "acme",
  "title": "No bridge rule for prefixed invoice numbers",
  "found": "~180 rows can't be matched safely; guessing risks false matches.",
  "need": "Confirm the bridge rule for prefixed invoice numbers.",
  "options": ["Strip the alpha prefix", "Use a mapping you provide", "Treat as out-of-scope"],
  "details": [ { "l": "Amount at risk", "v": "$50.0M" } ],
  "refs": [ { "label": "Acme report", "artifact": "acme-2025-11.html" } ]
}
```

- Required: `id`, `type`, `title`. `type` is **the answer contract** — what you want back:
  `needs-decision` (an answer: a decision, an input, an unblock) · `sign-off` (a verdict:
  approve / request changes / reject) · `fyi` (nothing — a for-the-record note; it never counts
  as needing a human). There is no `blocked` type: a stuck **job** is the *run's* status
  (re-report `--status` onto the same job id); the thing you need from a human is a
  `needs-decision`. Rule of thumb: **status of work → run result; for-the-record flag → fyi.**
- **Address it with `to`** when you know who you need: `"manager"` = the human accountable for your
  *work* (decisions, sign-offs on output) · `"builder"` = the human who maintains *you* (you're
  broken, credentials, **self-edit/logic-change flags**). Omit it if genuinely either — readers
  will guess from the type, labeled as a guess.
- Optional context (each renders only if present): `found`, `need`, `options[]`, `details[]`, `refs[]`.
  Write `options[]` as **short, stable, quotable** strings — a future answer (and your own
  `resolution.chosen`) references one *verbatim*. On a **sign-off**, options are **answer
  paths**: qualified verdicts the human can cite alongside approve / request-changes
  (`"Approved — file the 15 ready charges"` / `"Hold — wait for Capital Grille"`) — write them
  so each one tells you exactly what to do next. An ask can also carry the same `session` block
  as a run — useful, since asks mark the moments a human will want to trace.
- **You own the lifecycle — close it honestly.** The easy path:

  ```
  figs resolve acme-bridge --chosen 'Strip the alpha prefix' --by 'Sarah (accounting)'
  ```

  `--chosen` is checked **verbatim** against the ask's `options[]` (a paraphrase gets a
  "did you mean…"). **Three closes — pick by who ended it:** `resolved` (default — the need was
  met) · `--withdrawn` (**you** retracted it; nobody acted) · `--rejected` (**a human** declined
  it). The gray zone: a human says "don't bother" out-of-band → that's `--rejected`, not
  withdrawn — if a human declined, record the decline. Rejected is terminal on that id;
  re-raising is a new ask. A close is **not** a job — `resolve` never writes a run. When the
  answer unlocked real work, do the job, `figs report` it under its own id, *then* resolve
  (cite the job in `--note` so a reader can find the work). Hand-authored, the close is an
  appended fold line (by `id`; never edit old lines):

  ```json
  { "id": "acme-bridge", "status": "resolved",
    "resolution": { "chosen": "Strip the alpha prefix", "via": "human", "by": "Sarah (accounting)",
                    "note": "confirmed in terminal" } }
  ```

  `resolution` says how it closed: `chosen` = the option taken (verbatim); `via` = `"figs"`
  (the answer came through your inbox — **the CLI writes this for you**, citing the exact
  answer event in `resolution.answer`: verified attribution, by mechanism) · `"human"` (someone
  told you out-of-band, self-reported) · `"self"` (the blocker cleared on its own); `by` = who,
  as best you know (auto-filled from the event on the figs path). A bare string works as a
  shorthand note.

## Your inbox — answers come to you (`figs inbox`)

**Start every session with `figs inbox`.** Your humans answer your asks in the Figs app —
answers, approvals, change requests, rejections — and the inbox is where you read them. It's a
**pure read** (writes nothing): every ask of yours with thread activity, each with your humans'
words **verbatim** and the exact next command.

```
figs inbox                 # the list: answered · rejected-to-acknowledge · still waiting
figs inbox <ask-id>        # the handoff package for one ask
```

The package assumes you have **zero context** (you may be a fresh session, or a different
machine): the full ask, the whole thread, and the ask's attached artifacts **restored into
`.figs/artifacts/`** (hash-verified; a local file with different content is never clobbered).
Read it, verify any prerequisites the ask stated, do the work, then close:

- approved / answered → fork on what the answer unlocked: nothing left to do →
  `figs resolve <ask-id>` right away; real work → do the job, `figs report` it under its own
  id, then `figs resolve <ask-id> --note 'job <id>'`. Either way the close cites the event it
  acted on (`via: "figs"`, automatic);
- changes requested → revise, then re-raise **on the same id** (`figs ask <type> --id <ask-id> …`);
- rejected → acknowledge with `figs resolve <ask-id> --rejected` (the human already closed it;
  this records your own account, citing their event).

An ask answered on another machine works too — `resolve` fetches your own record home first,
then folds the close onto it.

## `artifacts/` — the rendered files you produce

You author artifacts wherever you work; `--attach` on `report`/`ask` copies them in and links
them (or drop a file here yourself and point to it from a run's `artifact` / an ask's `refs`).
Supported: **`.html` `.md` `.txt` `.json`** and images (`.png .jpg .gif .webp .svg`), **≤ 3 MB**
(compress larger images). HTML/markdown render in a sandboxed viewer; the file is shown exactly
as you produced it. **Artifacts are immutable once published** — same name + different content is
refused; a new version is a new name (`report-v2.html`) referenced from the new run/ask. Treat
`artifacts/` as a copy-in outbox, never a working directory. *(Remember the visibility note above
— an artifact is visible to every workspace member.)*

---

## Rules

- **One-way, never deletes.** You publish; Figs mirrors. Deleting locally doesn't delete remote.
- **One transport.** Every record enters the cloud through a push; the verbs end in one
  automatically. You only type `figs push` after hand-editing files, to flush a `--no-push`
  batch, or to retry a failed auto-push.
- **Write every ask for a stranger.** Assume the session that acts on the answer shares zero
  context with you — the record (title, found, need, options, attachments) must be enough on
  its own.
- **You own your identity.** The UUID in `config.json` is yours — commit it so everyone running
  this repo pushes to the *same* you.
- **Your workspace can change server-side.** A human may move you to another workspace in the app;
  your next push then fails with the fix spelled out — update `workspaceId` in
  `.figs/config.json` as the error says, and push again.
- **Idempotent.** Re-running `figs push` is always safe; records fold by `id`. Never use
  sequential ids — content-derived or generated only (the verbs generate them for you).
- **The token is the human's job.** Never enter or generate auth tokens yourself.
- **Infra, not rules.** We give the vocabulary and best practice; you and your user decide how
  to use it. Keep `agent.json` and `CONTRACT.md` honest and current.
