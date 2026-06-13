# REDESIGN — the local-first CLI (FINAL, v3)

> **Working doc, final** (2026-06-13). The agreed design for making `figs` a 100/100
> open-source CLI: **fully usable with zero account, strictly better with one.** Two full
> independent review rounds (fresh Claude + Codex each), every finding adjudicated with
> Wayne, plus the vocabulary + artifacts passes. All decisions below are settled. Delete
> this file once shipped — its content lands in `SPEC.md` (v2), `README.md`, `GUIDE.md`,
> `CLAUDE.md`, and `figs.mjs`. The decision trail is this file's git history.
> Status: **design final, not yet implemented.** 0 users — the breaking wave is free and
> ships as **CLI 1.0.0 + `figs-spec` v2**.
>
> *v3 changes from v2: the vocabulary settled into clean pairs (`resolve`→`close`,
> `needs-decision`→`question`, `events.jsonl`→`messages.jsonl`), and artifacts were
> redesigned into per-moment attachments.*

---

## 1. The diagnosis (why a re-foundation, not patches)

**The spec says local-first; the CLI's front door is remote-first.** `SPEC.md` §1 lists
*Local-first* as a founding principle; the README calls `.figs` an open protocol anyone can
implement. The reference CLI contradicts both at the entry point:

| # | Gap (as shipped, 0.8.0) |
|---|---|
| 1 | `figs init` requires an account — no token + no `--workspace` dies; workspaces are server-minted, so a no-account user cannot init at all; `requireFigs()` demands `workspaceId`, transitively gating every writing verb |
| 2 | `figs doctor` dies "not logged in" after all local checks pass — yet it's billed as the conformance check for hand-authored setups |
| 3 | Writing verbs exit 1 without a token even though the record was written — and an agent's reflex to exit 1 is to re-run the verb, minting duplicates |
| 4 | Teaching-error chains terminate at "create an account"; README/onramps lead with `login` |
| 5 | `figs inbox` is fully remote — even in-flight jobs (local data in `runs.jsonl`) are fetched from the server; no local answer channel exists |
| 6 | Auth: custom `x-figs-token` header; one endpoint-blind global token |

Root cause: the CLI was grown app-outward (login → workspace → push) instead of
files-outward (init → work → optionally publish).

---

## 2. North star: the git mental model

Agents know git natively; map onto it and the learning curve vanishes:

| git | figs | Property |
|---|---|---|
| `git init` | `figs init` | purely local, **zero flags**, zero prerequisites, instant value |
| `git remote add origin` | `figs link` *(new)* | connecting is a separate, later, optional act — the ONLY place remote config exists |
| `git commit` | `report` / `checkpoint` / `ask` / `answer` / `close` | recording works offline, always |
| `git push` | `figs push` | the one explicit outward act — spine + attachments + messages |
| `git pull` | *(inside `figs inbox`)* | the only down-sync, internal and soft — one correct session-start command, no separate ritual |
| `git status` / `git show` | `figs status` / `figs show` | local truth first; inbox lists, show magnifies — both pure local reads |
| GitHub | the hosted app | the multiplayer layer is where the closed product earns its keep |

**Three layers, in these words everywhere:**
1. **The protocol** — the `.figs/` files. Tool-independent.
2. **The local CLI** — correctness + convenience over the files (stamping, folding,
   validation, navigation, the session ritual). Needs only a filesystem. **The complete product.**
3. **The connected layer** — publishing, the org chart, multiplayer answers. Strictly additive.

The honest pitch: **local = the full loop, self-reported · linked = the same loop, attributed
and multiplayer.** README leads the linked pitch with *multiplayer + fleet view* ("verified
answers" is a thin delta for a solo user; the team is the customer).

---

## 3. The state model (keystone #1)

Two orthogonal facts, both explicit, no heuristics:

- **local vs linked** — does `config.json` have a `workspaceId`? Local-mode config is
  **`{ agentId }` only** — zero remote concepts in an unlinked repo (the endpoint is a
  *connection* property, written by `link`, never `init`).
- **authenticated** — does this machine have a token (`~/.figs/credentials.json` / `FIGS_TOKEN`)?

**The rule: the config declares intent; the CLI errors only when declared intent can't be met.**

### Exit codes (uniform; documented in `figs help` + README)

| Code | Meaning | Agent's correct reaction |
|---|---|---|
| `0` | recorded (and published, if linked) | continue |
| `1` | **nothing was written** — bad input, unmeetable intent, broken state | fix the input |
| `2` | **your data is safe locally; publishing failed** | `figs push` later — **never re-run the verb** (re-running mints duplicates) |

| State | Writing verbs | Push |
|---|---|---|
| local | write, **exit 0** | not attempted; one calm line: `local mode — figs link to publish` |
| linked + `--no-push` | write, **exit 0** | deliberately deferred |
| linked, no token | write, **exit 2** | `not logged in — figs login, then figs push` |
| linked, push fails | write, **exit 2** | record safe locally; `figs push` retries |
| linked, push ok | write, exit 0 | pushed |

- **Bare `figs push`**: structural failure (not linked, local validation) = exit 1 ("fix
  something"); network/server failure = exit 2 ("retry later"). Local-mode push errors
  clearly: `not linked — local records are safe; figs link to publish`.
- **Exit 2 inverts some CLI priors** (argparse's 2 = usage error), so the code is not the
  whole contract: **every exit-2 path prints one canonical stderr line** — `recorded locally
  — do NOT re-run this verb; figs push retries` — and §10 states that the line, not the
  number, is what agents key on.
- `checkpoint`'s loud "this checkpoint is NOT protecting the job yet" warning fires only when
  linked (in local mode the file *is* the protection).
- Degraded-sync `inbox` (read succeeded, sync didn't): **exit 0**, `--json` `ok: true` with a
  structured `sync` field (§10).

---

## 4. The topology rule (keystone #2)

**Supported write topology: one agent = one repo = one machine.** Chosen over multi-machine
reconciliation machinery because it makes the worst failure — *machine B sees machine A's
in-flight job as "hanging" and redoes finished work* — **structurally impossible: runs and
asks never sync down, so another machine's work is never visible in your inbox to wrongly
pick up.** The fleet-wide, cross-machine view is exactly what the app is for.

- **Agent ledgers (`runs.jsonl`, `asks.jsonl`): local is the source of truth, one-way UP.**
  The server is an aggregation mirror for humans, never an authority over the agent's files.
- **Human messages (`messages.jsonl`): the one two-way file — and the one where conflict is
  mathematically impossible.** Messages are immutable, ids minted once by whoever creates the
  message; up (push) and down (inbox sync) both reduce to *append if id absent*. Any order,
  any repetition, same result.
- **Concurrent sessions on the same machine are fine** (same files, append-only writes,
  fold-by-id; crash tolerance §7).
- **Multi-machine is unsupported-but-not-forbidden:** commit the outbox and manage the merge
  yourself — at your own risk, documented honestly.

### The server regression guard (timestamp-aware)

Belt-and-braces for the at-your-own-risk crowd, written so it never fights the supported
topology: **a push may not walk a record backwards in time** — the server refuses a fold
*older* than the record's latest close/settle (a stale machine pushing old state) and accepts
a fold *newer* than it (the agent's genuine latest truth). Reopening a settled job is
**legal and existing behavior** (fold-by-id has always meant it: the warn→ok evolution on one
row; "a corrected re-run heals the row"); `checkpoint` adds a teaching warning when it
reopens a settled id — *"reopening a settled job — continue only if it's truly the same job;
new work wants a new id."*

### Two priced-in edges, documented honestly

- **Fresh clone / machine replacement:** the journal is gitignored → a new machine starts a
  fresh journal. The app retains all history for humans. Docs say it plainly: *"your journal
  lives on this machine; the app is the durable record your humans see."*
- **Orphan messages:** a message can sync down for an ask id not in this journal (pre-clone
  ask). Inbox still **shows** it with a note (*"ask not in this copy's journal; full context
  in the app"*), and `close`/`show` work on it — **reference checks pass if the id appears in
  `asks.jsonl` OR `messages.jsonl`** (the two ledgers together are "the journal" for
  lookups). The ask record itself is never written down.

---

## 5. The verb surface (16 verbs)

**Vocabulary (clean pairs):** an **ask** is the umbrella record (`asks.jsonl`, raised by
`figs ask`). It has two **types**, each pairing with its reply: **question → answer** ·
**sign-off → verdict**. The human's replies are **messages** (`messages.jsonl`). The
lifecycle end is **`figs close`** (not part of the ask/answer exchange — a separate axis),
closing as `resolved` / `withdrawn` / `rejected`.

| Verb | Local mode | Linked |
|---|---|---|
| `init` | **zero flags.** Scaffolds `.figs/` (config `{agentId}`, charter template, CONTRACT, GUIDE, gitignore, empty ledgers). Never touches the network — structurally cannot need auth. **Idempotent and never clobbers — including the link fields of an already-linked config** (re-init must not unlink). Scaffolded stubs (GUIDE stub, `.gitignore` comment) are local-first prose (step-1 work, not step-6) | same (init is always local) |
| `link` *(new)* | — | THE connector: writes `endpoint` + `workspaceId`. Bare = list your workspaces (needs token; absorbs the deleted `workspaces` verb) — **with exactly one workspace, bare `link` just links it**. `--workspace <slug\|uuid>` + optional `--endpoint <url>`. **Verifies when a token is present**; token-less `link` accepts **UUIDs only** (slug resolution needs the API — a slug without a token gets a teaching error naming both fixes) and warns "unverified until first push." Unlinking = delete the fields (documented; no verb) |
| `report` / `checkpoint` | write + validate, exit 0; **announce new-vs-fold** (§6); `--attach <file>` (repeatable, §7) | + auto-push (exit table §3) |
| `ask` | **two types: `question` · `sign-off`.** Local closing line, first clause first: *"show this ask to your human in chat now — nothing else will surface it"*, then the type-matched record command (question → `figs answer <id> --chosen '…'/--text '…' --by '<who>'` · sign-off → the verdict flags). `--attach` (repeatable); sign-off keeps one tip: *"attach what you're asking them to approve"* (the old `refs` intent, kept as education) | same, plus "or they answer in the app" |
| `answer` *(new)* | **agent-run** — records the human's out-of-band reply **verbatim** (humans never type commands; `--text` help says *"verbatim, never summarize"*). `--chosen` (verbatim-checked) · `--text` · `--approve\|--request-changes\|--reject` · `--by` (required; its error teaches *"the human's name, not yours"*) · `--no-push`. Stamps `source: "chat"` and the message `ts` itself. Ask must exist in the journal (§4 union rule). Taught rules: *"transcribe your human's words verbatim — never author the answer yourself"* and *"answers from the app are already in your journal — `figs answer` is only for replies that exist nowhere but your chat"* (+ a warn when the newest message already carries the same content: the double-transcription trap) | same; auto-push carries it to the app's thread |
| `close` *(was `resolve`)* | **pure close — fully local in its logic** (the citation is read from disk, never fetched; standard auto-push like every writing verb). **No `--chosen`, no `--by`, no `--answer-id`, no `--rejected`** — see the close matrix below. Keeps `--note` · `--run <run-id>` · `--withdrawn` · `--attach` (proof of what was done) · `--no-push`. **The cut flags are special-cased with a teaching error** (the migration path for trained priors): *"replies are recorded with `figs answer <id> … --by '<who>'`; close only ends the ask"* | same + auto-push |
| `inbox` | **the list**: what needs you — in-flight jobs (`runs.jsonl`), open asks (`asks.jsonl`), threads (`messages.jsonl`), grouped per ask, time-ordered, **no win-logic: complete transparent truth, the agent judges**. Orphan messages shown with their note. Each item carries its exact next command | + the soft down-sync first (§7); `--no-sync` to skip; degraded sync is loud, exit 0 |
| `show <id>` *(new)* | **the magnifier, pure local**: auto-detects run or ask; prints the **folded** record + its checkpoint trail / answer thread + attachment names at each moment; `--json`. Kills the raw-read footgun (a naive JSONL reader takes an early line as current state — folding is the one thing raw reads get wrong). **Absorbs `inbox <ask-id>`**, which is deleted. A referenced attachment missing locally → *"not in this copy — view it in the app at <url>"* (never downloads; §7) | same (no network — local read) |
| `doctor` | **full conformance offline, exit 0** ("server validation skipped" note). Validates everything: charter placeholders, runs/asks/messages shapes, message ids, cross-references (`run`, `unit`, options-vs-chosen, attachment files) | + server validate as a second opinion |
| `push` | error: `not linked — local records are safe; figs link to publish` (exit 1) | spine + attachments + **messages the server lacks**; version floor check lives here; exit 1 structural / 2 network |
| `status` | mode, files, journal honesty line ("records live on this machine") | + account, workspace |
| `login` / `logout` | inherently connected; device flow unchanged; `login` when already logged in says so before replacing | — |
| `version` | **prints locally, no network**; `--check` opts into the update check | same |
| `help` | grouped **local / connected**; exit codes documented; `answer` described as *"record your human's reply"* | same |

### The close matrix (explicit-in-output, implicit-in-typing)

Plain `figs close <id>` reads the newest message for that ask and does exactly one of:

| Newest message on file | Behavior |
|---|---|
| nothing (still waiting) | **refuse**, with the teaching menu: *answered in chat? → `figs answer` first · you retracted it? → `--withdrawn` · cleared on its own? → add `--note` (recorded `via: "self"`)* |
| answer / approved verdict | close **resolved**, citing it — prints *"resolved — acting on 'Strip the alpha prefix' by Wayne (2h ago)"* |
| changes-requested verdict | **refuse** — *"revise and re-raise on the same id; this isn't a close"* |
| reject verdict | close **rejected**, citing it — prints *"closed as rejected — acknowledging Wayne's reject (2h ago)"* |

Two properties make the derivation safe: **the state machine forces it** (rejected is
terminal in the spec — once a reject verdict exists no other close is legal, so plain close
cannot pick wrongly), and **everything is announced** (stdout + `--json` always state the
derived close and the cited message; nothing happens silently — but the agent never *types*
the close-type, and typing is where agents err). Chat rejections route through the ledger
first (`figs answer <id> --reject --by '…'` → plain `close`), so every rejection — app or
chat — leaves the human's "no" on the thread. A rejected ask's acknowledgment is the same
plain `close` (the agent recording in its own journal that it saw the rejection and stands
down).

### Cut and kept

**Cut across all rounds** (each made the model stronger): the `workspaces` verb (= bare
`link`) · `init --workspace` / `init --endpoint` (init must be incapable of needing the
network; endpoint is connection config → `link`) · `close --chosen/--by` (replies belong to
`answer`; kept flags would let trained priors skip the ledger forever) · `close --answer-id`
(auto-cite; contradictions get addressed, not cited around) · `close --rejected` (derived
from the cited verdict; also kills the `--rejected`/`--reject` two-letter near-collision on
adjacent verbs) · the `--source` flag (field stays; flag was a spoofing surface) ·
`inbox <ask-id>` (absorbed by `show`) · **the `fyi` ask type** (§7) · the run `artifact`
singular field, the `artifacts` field, and the ask `refs` field (all → one `attachments`, §7).

**Considered and kept:** `report`/`checkpoint` as two verbs (the one-shot settle is the
common case → `report` stays the everyday verb; `checkpoint` is the specialist for jobs that
outlive a sitting) · `--no-push` (batching) · `ask --stdin` (long prose vs shell quoting) ·
`--to manager|builder` · the three verdict flags on `answer` (self-teaching sugar for the
spec's `verdict` values — the named exception to flags-mirror-fields) · `--trigger` (what set
the sitting in motion) · `--unit` (which charter unit) · `--period` (which time slice) ·
`--withdrawn` (the one close with no message — the agent's own act).

### When there's no `.figs/` here: peek, never use

No walk-up — **the fleet topology forbids it** (an openfigs fleet has the recruiter's `.figs`
at the root and each employee's own `.figs` in its folder; walk-up would let an
un-initialized subagent silently report as its parent: identity bleed). The error peeks
upward and informs: *"no `.figs/` here, but found one at `../..` (agent: Recruiter) — if you
ARE that agent, cd there; if you're a different agent, run `figs init` at YOUR root."* The
CLI never adopts a parent's identity. GUIDE teaches: open agents at their own root;
delegating means entering the agent's root.

---

## 6. Ids: names vs plumbing (keystone #3)

Two id classes with opposite designs:

- **Names** — job ids, ask ids, unit ids. **Agent-authored, meaningful, stable**
  (`recon-acme-2026-11`); the runs list reads as a job list *because* agents name jobs.
- **Plumbing** — **message ids and the agent UUID** (record-level plumbing). Machine-minted,
  machine-cited; **no command accepts one — enforcement by absence of surface.** `answer`
  mints message ids; `close` auto-cites from disk; `init` mints the agent UUID; `push`
  attaches it. **Contract rule: no new flag may ever accept a message id or the agent UUID.**
  *The one named exception:* `link --workspace <uuid>` — the workspace id is **connection
  configuration** (set once by the connector verb, committed in config.json), not
  record-level plumbing. The rule is scoped identically in `CLAUDE.md` rule 7 and
  `CONTRIBUTING.md`.

### Reference checks (every typed id, every command)

*Creatable ids announce; reference ids are checked; closes die, links warn.*

- **Creatable** (`report --id`, `checkpoint --id`, `ask --id`) — can't validate (new ids and
  folds are both legitimate), so every write **announces which happened**: `new job opened:
  <id>` vs `folded onto existing job <id>`. A typo meant as a continuation prints "new job"
  and the agent catches itself.
- **Reference** — checked against the journal (= `asks.jsonl` ∪ `messages.jsonl` for ask
  lookups, complete under the topology rule): `close <ask-id>` / `answer <ask-id>` /
  `show <id>` → must exist, else **die** ("not in this journal — `figs inbox` shows your open
  asks") · `--run <run-id>` → unknown id **warns loudly** ("typo? this link will dangle" —
  warn not die: a dangling link is damage-limited, a blocked ask is not) · `--unit` → checked
  against the charter, warn · `--chosen` → verbatim-checked with did-you-mean (shipped; the
  prototype for the pattern).

### Flag-naming rule

Flags mirror the spec field they set (`--run` sets `run`, `--unit` sets `unit`); help text
always shows the id placeholder (`--run <run-id>`). Named exceptions: `answer`'s verdict
flags (`--approve`/`--request-changes`/`--reject` — boolean sugar for `verdict` values) and
`link --workspace` (above).

---

## 7. The data plane in detail

### `messages.jsonl` — the human ledger (renamed from `answers.jsonl` → `events.jsonl` → this)

Named for what it holds: every **message from your humans** — answers, verdicts, and (later)
directives. "A directive arrives in your messages" reads true; never-cleared fits message
*history*. Renaming post-1.0 would be breaking; renaming now is free.

Separate file, not folds into `asks.jsonl`, for a load-bearing reason: **the two files have
different algebra.** Asks are *records that fold* (field-merge by id, latest wins); messages
*accumulate* (answer → changes-requested → approved must all survive). Folding messages into
a folding file forces two merge rules into one file — complexity every implementer inherits.

Message shape (spec v2 §6.3):
`{ "id": "msg-…", "kind": "answer" | "verdict", "ask": "<ask-id>", "by": "<who>", "ts": "…", "source": "app" | "chat", "chosen"?: "<option verbatim>", "text"?: "…", "verdict"?: "approved" | "changes-requested" | "rejected" }`

- **The anchor is optional-by-kind**: `answer`/`verdict` messages carry `ask`; reserved kinds
  (`note`, `directive`) may anchor to a run or stand alone. Spec'd now so implementers don't
  hard-require `ask` and force a schema break later.
- **`source` = *where*, not who** (always a human): `"app"` = answered in Figs
  (server-minted) · `"chat"` = told to the agent in its session, transcribed (CLI-stamped; no
  flag). Extensible additively when integrations exist.
- **The trust rule (normative, spec v2):** readers derive the verified grade from **mint
  origin** — a server-minted message is attested; a message pushed up from a machine is
  transcription, whatever its fields say. `source` is display metadata, never trust input.
- **Messages are immutable; corrections are new messages.** Multiple per ask are normal
  (clarifications, corrections, changes-requested → approved): inbox shows the whole thread,
  time-ordered — **no win-logic; the agent judges.**

### Artifacts — attachments pinned to a moment

**The concept:** an attachment is a file pinned to the **moment** that produced it — the
line that recorded it (a checkpoint, report, ask, or close) — not a property of the folded
job or ask. That reframe is the whole design: intermediate work gets a home, the chain is
visible, and closes can carry proof.

- **One flag, everywhere, always multiple:** `--attach <file>` (repeatable) on `report`,
  `checkpoint`, `ask`, `close`. There is no singular special case to learn.
- **One field:** **`attachments: ["invoices-acme.xlsx", "recon.html"]`** — an array of bare
  filenames, on the line. **Deletes** the run `artifact` string, the run `artifacts` array,
  and the ask `refs: [{label, artifact}]` shape (the filename is the label; a display label
  can return additively if dogfooding wants it).
- **Pinned to the line, not folded** — each moment keeps its own attachments; the timeline
  shows them where they happened; **nothing collapses or is lost** (today's folding field
  drops intermediates from the record and the upload path; this fixes it). **No "hero", no
  "deliverable" concept** — every attachment is an equal timeline item. (If the app ever
  wants to feature one, that's a pure app-rendering choice, outside the protocol.)
- **Two render classes:**
  - **Renderable** (sandboxed inline viewer): `.html .md .txt .json` + images
    (`.png .jpg .gif .webp .svg`) — unchanged.
  - **Download-only** (offered as a download, never rendered — lower risk than HTML
    rendering, nothing executes): the back-office work types — `.xlsx .csv .pdf .docx`
    (extensible). The recon chain is the case: `checkpoint "data received" --attach
    invoices-acme.xlsx` → `checkpoint "matched"` → `report "done" --attach
    processed-recon.xlsx --attach recon.html`.
- **Files** live in `.figs/artifacts/<name>`, immutable (same name = same bytes, **409 on a
  clash**) — so a per-line reference is permanent by construction; a changed file uses a new
  name (`-v2`), and the timeline then honestly shows both versions at their moments.
- **Size cap raised to ~10 MB** (from 3 MB) now that data files are in scope; one cap across
  types. *(Adjustable at implementation — the one open number.)*
- **No download path.** `figs show` is local-only; a referenced attachment missing locally →
  *"not in this copy — view it in the app at <url>"*, never fetched. Consistent with "only
  messages sync down; local is the source of truth" — the agent produced its attachments, so
  on the supported topology they're always on disk.
- **Sign-off keeps the `refs` intent as a tip** (not a field): *"attach what you're asking
  them to approve."* One line — don't overdo it.

### Timestamps (the clock rules)

- **Every `ts` is machine-stamped; no verb has a `--ts` flag.** Record `ts` by
  `report`/`checkpoint`/`ask`; `resolution.ts` by `close` (inside the resolution object so
  folds can't collide); **message `ts` by `answer`**; app-minted messages carry the server's
  clock.
- **Two clocks, claim vs receipt** (existing spec posture, extended to messages): the CLI's
  stamp is the *claim*; the server stamps its own *receipt* at ingest; readers surface both
  only when they diverge.
- **Cross-clock ordering is approximate** (a thread interleaves app messages on the server's
  clock with transcriptions on the machine's) — harmless by design: **ids are identity; `ts`
  is display order only.**
- The one self-reported exception, by design: the optional `session` block (`startedAt`,
  tokens) — copied from the runtime's own records, true-or-absent, never inferred.
- **Education line (GUIDE/llms.txt):** *"hand-writing the files is legal — files are the
  protocol — but the verbs stamp ids, timestamps, and validation for you; an agent should
  never hand-write what a verb can write."* Doctor validates the hand-written stragglers.

### Direction purity

- **Up = `figs push`** (and every writing verb's auto-push): spine, referenced attachments,
  and messages the server lacks (dedupe by id; server stores transcriptions as such, by mint
  origin).
- **Down = `figs inbox`'s soft sync, messages only** (worded **agent-scoped** in the spec —
  *all human messages for this agent* — so future kinds flow through the same GET with zero
  wire change): ~5s budget; on failure or an incomplete response, **loud** ("showing local
  state — couldn't reach {endpoint}" / "sync incomplete — the server returned a partial set")
  and degrade to the local view, exit 0. The server must return the complete open surface or
  flag truncation. No cursors until scale demands.
- **Attachments never sync down.** They are produced locally; a missing reference points to
  the app (above). `show` is a pure local read.
- Nothing else touches the network. `close` and `answer` are fully local in their logic —
  the citation is read from disk, never fetched — and share the standard auto-push like every
  writing verb. Scripts wanting machine-readable sync use `inbox --json`.

### fyi: retired

The spec's own principle — *the ask type IS the answer contract* — made `fyi` the odd one
out: an ask that asks nothing. Its content already has a home: job-related notes ARE
checkpoint/report lines, and a standalone note is a small settled report — **the runs feed is
the for-the-record channel** a manager watches. Retiring it makes the type system exact
(**`question` → answer · `sign-off` → verdict**), deletes the fyi-lifecycle problem outright
(an fyi sat "open" forever with nothing to wait for), and simplifies spec, app, and teaching.
Spec v2 removes the type; at 0 users, free.

### The full loop, one ritual, both modes

ask *(+ relay it into chat — locally nothing else surfaces it)* → reply arrives (app → syncs
down · chat → `figs answer`) → act → real work reported under its own job id
(`--trigger 'inbox: answer on <ask-id>'`) → `figs close <ask-id> --run <job-id>`.
Back-and-forth works by construction: revisions fold on the same ask id; messages accumulate;
the thread interleaves by `ts`. Rejected is sticky/terminal.

### Interconnections — ids and time, never pointers between same kinds

**Chains emerge from ids + time; no record points at its own kind.** The graph is bipartite
with the **job as the hub**: `ask.run` (the job an ask was born from) · `resolution.run` (the
job an answer caused — mirror of `ask.run`; how a manager sees what happened between answer
and close: the job's row carries its whole checkpoint trail, since checkpoints are folds on
the job id) · `message.ask` (the thread anchor) · `resolution.answer` (the cited decisive
message id, CLI-stamped) · `session.trigger` (the prose breadcrumb back). **Explicitly
refused: `ask.parent`/`supersedes`** — follow-up needs chain through the job; the zero-work
follow-up names the prior ask in `found` (convention). Additive later if dogfooding demands.

### Crash tolerance (the journal must survive the agent dying)

Append isn't atomic — a process killed mid-write leaves a half line, which today bricks every
verb until hand-repaired. Fix: **tolerate exactly one malformed final line** — shout ("last
line of runs.jsonl is broken — likely a crash mid-write; skipped; re-report that record") and
keep working; die loudly on malformed *interior* lines. Plus a re-check-before-append guard
for concurrent same-machine sessions.

### Files and verbs

Verbs cover the *streams* (report/checkpoint → runs · ask/close → asks · answer → messages)
and the *reads* (inbox lists, show magnifies — both pure local). `agent.json` deliberately
has **no verb**: it's a *document* (the charter, prose-rich) — agents edit files natively;
`init` scaffolds the template, `doctor` refuses placeholders. Hand-writing any file stays
*legal* — never *necessary* (see the education line above).

---

## 8. Auth — review and redesign

**Keep (ahead of most CLIs):** device flow where the agent never sees the token ·
pasted-token fallback · `0600`/`0700` perms enforced on every save · `FIGS_TOKEN` for CI ·
logout naming the server-side revocation step · the split *auth = the user, identity = the
agent*.

**Change:**
1. **`Authorization: Bearer <token>`** replaces `x-figs-token`. App dual-accepts until the
   next `MIN_CLI` bump.
2. **Credentials keyed by endpoint origin** (`{ "https://app.figs.so": { "token": "…" }, … }`)
   — fixes the real bug (prod token sent to whatever `FIGS_ENDPOINT` points at) and allows
   prod + local dev side by side. **Migration:** key the old single token to the **baked
   default endpoint** and print what happened (simplest correct move at ~0 users); normalize
   origins (scheme, host, port; no trailing slash).
3. **`figs_…` token prefix** (app-side mint) — self-identifying, greppable, secret-scanning
   ready.
4. `figs link` is the auth-adjacent verb: verifies workspace access when a token exists;
   UUID-only without one (+ "unverified until first push").

**Deliberately not doing:** refresh tokens/expiry (long-lived revocable PATs are simpler for
agents) · OS keychain (headless world) · multi-profile (per-endpoint covers it) · token
scopes (parked: a push-only token for runner boxes).

---

## 9. What local mode gives instantly (say this everywhere)

One zero-flag `figs init`, no account:

- **Identity** — a stable UUID + the charter template.
- **A work journal** — jobs under meaningful ids, fold-by-id progress, in-flight/settled
  lifecycle, crash-tolerant file handling. **Crash-recoverable memory across sessions** on
  this machine: the next session's `figs inbox` finds what its past self left in flight.
- **The full handoff loop** — structured asks (relayed into chat by the agent — that's the
  taught step); replies recorded verbatim (`figs answer`); closes that cite their evidence;
  the whole conversation greppable on disk and navigable (`figs show`); files attached to the
  moments that produced them.
- **Validation that teaches** — `doctor` + validate-on-write + reference checks, offline.
- **A session ritual** — inbox → checkpoint → report → close. The shape of a trustworthy
  employee, enforced by tooling.
- **A costless exit ramp** — `figs link` later and everything recorded since day one
  publishes. Nothing is lost by starting local.

Honesty lines that keep the claim trustworthy: the journal is **machine-local** (a fresh
clone starts fresh; the app is the durable record humans see) · local records are
self-reported (mint-origin attestation is what linking adds) · **a local ask reaches a human
only through the agent's own session** (unattended local agents have no chat — surfacing
their asks is a linked-mode feature by nature).

---

## 10. Output + craft

- **`--json` envelope, defined before coding:** `{ ok, data, warnings: [] }` on every read
  verb (status, inbox, show, doctor, version); warnings mirrored to stderr; `inbox --json`
  includes a structured `sync` field (`ok | degraded | skipped`, with reason) so a degraded
  sync is machine-detectable.
- stdout = data, stderr = warnings/teaching (sweep the stragglers).
- Exit codes per §3; **the canonical exit-2 stderr line is the agent-facing contract**, the
  number is secondary.
- Ship `GUIDE.md` in the npm package (`files[]`) for air-gapped agents.
- README quickstart flips: 30-second **no-signup** local quickstart first; linking as the
  upgrade, pitched **multiplayer/fleet first**.
- The scaffolded `.figs/.gitignore` comment explains the machine-local journal choice; all
  init-written stubs are local-first prose (step-1 work).
- **The no-account audit is a committed test script**, not a checklist: runs every verb with
  credentials absent + endpoint unroutable, asserts the §3/§5 tables. Release blocks on it.
  The matrix additionally covers: linked/no-token, network-off, duplicate message ids,
  truncated sync, crashed-tail recovery, peek-don't-use, re-init-preserves-link, the close
  matrix, the cut-flag teaching errors, and attachments (multi-attach, download-only types,
  show's local-only behavior).

---

## 11. Spec changes — `figs-spec` v2

Two-way flow + sync is **not** additive to a spec whose v1 says "one-way; two-way reserved
for a future version" — claiming v1 would make the governance look unserious. **v2**, shipped
with CLI 1.0.0:

- §1 principles: add **Account-optional** (protocol + local tooling fully usable with no
  account or network; a reader is strictly additive) and the **topology rule** (§4: one
  agent = one repo = one machine; agent ledgers up-only; messages the sole two-way file).
- §2 folder layout: add `messages.jsonl` (+ the scaffolded `.gitignore` line).
- §3 `config.json`: `workspaceId` *and* `endpoint` optional — absent = local mode; written
  together by `link`.
- §5/§6: **`fyi` removed** — two ask types, the type IS the answer contract
  (**question → answer · sign-off → verdict**). For-the-record notes are activity (runs).
- §5/§7 attachments: replace the run `artifact`/`artifacts` and ask `refs` with a single
  **`attachments: string[]`** on any record line; define the two render classes (renderable
  inline vs download-only) and the expanded type list; raise the size cap to ~10 MB;
  attachments are per-line (not folded) and never sync down.
- §6.1 reframed: the human ledger is no longer "server-side only / reserved" — it mirrors
  locally as `messages.jsonl`; the two-ledger split (who writes what) survives as
  agent-ledgers vs the human-message file.
- §6.2 `Resolution`: add `run` (the job the answer caused); `answer` = the cited message id,
  **CLI-stamped**; **`via: "figs"` reworded** — "closed through the figs mechanism, citation
  attached; trust derives from the cited message's mint origin" (close stamps `"figs"`
  whenever a citation exists; the message carries the grade).
- §6.3 *(new)*: `messages.jsonl` — file, message shape, **anchor optional-by-kind**,
  `source`, immutability, mint-once ids, machine-stamped `ts`, **the trust rule** (verified
  grade = mint origin; `source` is display only).
- §8 wire: `Authorization: Bearer`; push payload gains `"messages": […]`; the down-sync GET
  (**agent-scoped: all human messages for this agent**; complete-or-flag-truncation); the
  **timestamp-aware regression guard** (refuse folds older than the stored close, accept
  newer); two-clock claim/receipt extended to messages.
- §9 validation: **local validation is normative** for conformance; server validation
  optional.
- Reserved: kinds `note`/`directive` (human-initiated) stay named-reserved — their future
  home is `messages.jsonl` + the same sync; provenance/signing stays reserved;
  cursors/pagination named-deferred.

---

## 12. Rollout

1. **State model + surface**: optional `workspaceId`/`endpoint`, `requireFigs` →
   agentId-only, zero-flag `init` (+ local-first stub rewrite, re-init preserves link), new
   `link` (absorbs `workspaces`; single-workspace convenience; UUID-only token-less), exit
   codes 0/1/2 + the canonical exit-2 line, peek-don't-use error, `version` offline,
   announce new-vs-fold, reference checks.
2. **`doctor` offline + validation completeness** (incl. the new files/fields) + the
   `--json` envelope everywhere.
3. **The data plane** (one step — the pieces only work together): `messages.jsonl` +
   `figs answer` + inbox local read + messages-only soft down-sync + the close matrix
   (auto-cite, derived closes, cut-flag teaching errors) + `figs show` (pure local; absorbs
   `inbox <ask-id>`) + push carrying messages + crash tolerance + fyi retirement +
   **attachments** (unified `attachments[]`, `--attach` on all four verbs, expanded types,
   per-line). App work in the same step: ingest accepts `messages`, the down-sync GET
   (agent-scoped, complete-or-flag), the ts-aware regression guard, thread rendering by mint
   origin, fyi removal, timeline rendering of per-moment attachments + download-only types.
4. **Auth**: Bearer (+ app dual-accept), per-endpoint credentials + migration, `figs_`
   prefix, `link` verification.
5. **The audit script + test matrix** (release gate live from here on).
6. **Docs flip**: README (local-first quickstart, exit codes, multiplayer pitch), GUIDE,
   llms.txt, help regrouping; SPEC v2 lands.
7. **Cross-repo**: `create-openfigs` outro → `figs init` first, login later · `openfigs`
   template GUIDE wording · HQ `docs/architecture.md` updated at ship (including one quiet
   line that a conforming server is substitutable — known consequence, chosen knowingly, not
   a public claim) · **delete this file**.

*(After this wave ships: the same audit-and-redesign pass on the app and openfigs as
products — tracked in HQ `docs/roadmap.md` item 0. This wave deliberately touches the app
only where the CLI requires it.)*

---

## 13. Deferred (post-1.0, named so nothing repurposes them)

- **Human-initiated `note`/`directive` messages** ("can you also send the email to xxx" from
  the app) — the channel already exists (immutable messages → down-sync → inbox surfaces →
  agent does the job → reports). Design-on-arrival: the app compose UI + permission gate
  (same injection gate as answers), the inbox next-command teaching, and how a report cites
  the directive without typing message ids (the auto-cite pattern — inbox hands the agent a
  pre-filled command, as it does for asks today).
- A public bare-sync verb (`pull`) — additive if scripts/cron ever need sync-without-display.
- Sync cursors/pagination — when an agent's open surface stops fitting one response.
- Multi-message citation (`resolution.answers[]`) — via the bare-string/array shorthand
  pattern, if ever needed.
- An optional attachment display `label` (`{name, label}` shorthand) · `source` values beyond
  `app`/`chat` · CSV-rendered-as-table — all arrive additively when a real need appears.
- Token scopes (push-only runner tokens) · ask→ask links (only if dogfooding shows bare
  follow-up chains are common) · a journal list/`log` verb (inbox + show + files cover it).

## 14. Assumptions

- 0 users → one breaking wave: **CLI 1.0.0 + spec v2**, no compatibility shims beyond the
  app's brief `x-figs-token` dual-accept and the credentials-file migration.
- App contract changes are scoped to: Bearer dual-accept, ingest `messages`, the down-sync
  GET, the ts-aware regression guard, `figs_` token mint, mint-origin thread rendering, fyi
  removal, attachments (unified field + timeline render + download-only types).
- The Meridian demo fleet + dogfood agents are linked already; optional fields are a
  relaxation. The fyi retirement and the `artifact`/`refs` → `attachments` rename may need a
  one-time sweep of existing rows.
- Local-mode value is a goal in itself, not merely a funnel tactic; docs are written from
  that posture.
