# REDESIGN — the local-first CLI (FINAL)

> **Working doc, final version** (2026-06-12). The agreed design for making `figs` a 100/100
> open-source CLI: **fully usable with zero account, strictly better with one.** Reviewed by
> two independent agents (fresh Claude session + Codex), every finding adjudicated with Wayne;
> all decisions below are settled. Delete this file once shipped — its content lands in
> `SPEC.md` (v2), `README.md`, `GUIDE.md`, `CLAUDE.md`, and `figs.mjs`. The decision trail is
> this file's git history.
> Status: **design final, not yet implemented.** 0 users — the breaking wave is free and ships
> as **CLI 1.0.0 + `figs-spec` v2**.

---

## 1. The diagnosis (why a re-foundation, not patches)

**The spec says local-first; the CLI's front door is remote-first.** `SPEC.md` §1 lists
*Local-first* as a founding principle, and the README calls `.figs` an open protocol anyone
can implement. The reference CLI contradicts both at the entry point:

| # | Gap (as shipped, 0.8.0) |
|---|---|
| 1 | `figs init` requires an account — no token + no `--workspace` dies; workspaces are server-minted, so a no-account user cannot init at all; `requireFigs()` demands `workspaceId`, transitively gating every writing verb |
| 2 | `figs doctor` dies "not logged in" after all local checks pass — yet it's billed as the conformance check for hand-authored setups |
| 3 | Writing verbs exit 1 without a token even though the record was written — and an agent's reflex to exit 1 is to re-run the verb, minting duplicate records |
| 4 | Teaching-error chains terminate at "create an account"; README/onramps lead with `login` |
| 5 | `figs inbox` is fully remote — even in-flight jobs (local data in `runs.jsonl`) are fetched from the server; no local answer channel exists |
| 6 | Auth: custom `x-figs-token` header; one endpoint-blind global token |

Root cause: the CLI was grown app-outward (login → workspace → push) instead of files-outward
(init → work → optionally publish).

---

## 2. North star: the git mental model

Agents know git natively; map onto it and the learning curve vanishes:

| git | figs | Property |
|---|---|---|
| `git init` | `figs init` | purely local, **zero flags**, zero prerequisites, instant value |
| `git remote add origin` | `figs link` *(new)* | connecting is a separate, later, optional act — the ONLY place remote config exists |
| `git commit` | `report` / `checkpoint` / `ask` / `answer` / `resolve` | recording works offline, always |
| `git push` | `figs push` | the one explicit outward act — spine + artifacts + answers |
| `git pull` | *(inside `figs inbox`)* | the only down-sync, internal and soft — one correct session-start command, no separate ritual |
| `git status` | `figs status` | local truth first, remote state when available |
| GitHub | the hosted app | the multiplayer layer is where the closed product earns its keep |

**Three layers, in these words everywhere:**
1. **The protocol** — the `.figs/` files. Tool-independent.
2. **The local CLI** — correctness + convenience over the files (stamping, folding,
   validation, the session ritual). Needs only a filesystem. **The complete product.**
3. **The connected layer** — publishing, the org chart, multiplayer answers. Strictly additive.

The honest pitch: **local = the full loop, self-reported · linked = the same loop, attributed
and multiplayer.** (README leads the linked pitch with *multiplayer + fleet view* — "verified
answers" is a thin delta for a solo user; the team is the customer.)

---

## 3. The state model (keystone #1)

Two orthogonal facts, both explicit, no heuristics:

- **local vs linked** — does `config.json` have a `workspaceId`? Local-mode config is
  **`{ agentId }` only** — zero remote concepts in an unlinked repo (the endpoint is a
  *connection* property and is written by `link`, not `init`).
- **authenticated** — does this machine have a token (`~/.figs/credentials.json` / `FIGS_TOKEN`)?

**The rule: the config declares intent; the CLI errors only when declared intent can't be met.**

### Exit codes (uniform, documented in help + README)

| Code | Meaning | Agent's correct reaction |
|---|---|---|
| `0` | recorded (and published, if linked) | continue |
| `1` | **nothing was written** — bad input, unmeetable intent, broken state | fix the input |
| `2` | **recorded locally; publish failed** (network, server, or linked-but-no-token) | `figs push` later — **never re-run the verb** (re-running mints duplicates) |

| State | Writing verbs | Push |
|---|---|---|
| local | write, **exit 0** | not attempted; one calm line: `local mode — figs link to publish` |
| linked + `--no-push` | write, **exit 0** | deliberately deferred |
| linked, no token | write, **exit 2** | `not logged in — figs login, then figs push` |
| linked, push fails | write, **exit 2** | record safe locally; `figs push` retries |
| linked, push ok | write, exit 0 | pushed |

`checkpoint`'s loud "this checkpoint is NOT protecting the job yet" warning fires only when
linked (in local mode the file *is* the protection).

---

## 4. The topology rule (keystone #2 — replaces the old sync rulebook)

**Supported write topology: one agent = one repo = one machine.** Decided over the
alternative (machinery to reconcile multi-machine views) because it makes the
worst-of-the-worst failure — *machine B sees machine A's in-flight job as "hanging" and
redoes finished work* — **structurally impossible: runs and asks never sync down, so another
machine's work is never visible in your inbox to wrongly pick up.** You can't double-start
what you can't see. The fleet-wide view across machines is exactly what the app is for.

- **Agent ledgers (`runs.jsonl`, `asks.jsonl`): local is the source of truth, one-way UP.**
  The server is an aggregation mirror for humans, never an authority over the agent's files.
  Nothing ever writes these files but this repo's own verbs.
- **Answers (`answers.jsonl`): the one two-way file — and the one where conflict is
  mathematically impossible.** Events are immutable, ids minted once by whoever creates the
  event; up (push) and down (inbox sync) both reduce to *append if id absent*. Any order, any
  repetition, same result.
- **Concurrent sessions on the same machine are fine** (same files, append-only writes,
  fold-by-id; see crash tolerance §7).
- **Multi-machine is unsupported-but-not-forbidden:** commit the outbox and manage the merge
  yourself — at your own risk, documented honestly. Belt-and-braces server rule (one `if`):
  **a push never regresses a closed/settled record back to open/in-flight** — no longer
  load-bearing, kept to protect the at-your-own-risk crowd.

**Two edges, priced in and documented honestly:**
- **Fresh clone / machine replacement:** the journal is gitignored → a new machine starts a
  fresh journal. The app retains all history for humans; the local inbox simply starts empty.
  The docs say it plainly: *"your journal lives on this machine; the app is the durable
  record your humans see."*
- **Orphan answers:** an answer can sync down for an ask id not in this journal (pre-clone
  ask). Inbox still **shows** it (events carry the ask id) with a note — *"ask not in this
  copy's journal; full context in the app"* — and `figs resolve <id>` still works (a close
  fold on a bare id is legal; the server folds it onto the full record). The ask record
  itself is never written down.

---

## 5. The verb surface (15 verbs; the sweep's cuts applied)

| Verb | Local mode | Linked |
|---|---|---|
| `init` | **zero flags.** Scaffolds `.figs/` (config `{agentId}`, charter template, CONTRACT, GUIDE, gitignore, empty ledgers). Never touches the network — structurally cannot need auth. Idempotent; never clobbers. Output states the instant value + both next paths | same (init is always local) |
| `link` *(new)* | — | THE connector: bare = list your workspaces (needs token; **absorbs the deleted `workspaces` verb**); `--workspace <slug\|uuid>` + optional `--endpoint <url>` writes `endpoint` + `workspaceId` into config. **Verifies the workspace when a token is present; otherwise warns "unverified until first push."** Unlinking = delete the fields (documented; no verb) |
| `report` / `checkpoint` | write + validate, exit 0 | + auto-push (exit table §3) |
| `ask` | same; in local mode the closing line teaches: *"when your human answers (in chat), record it: `figs answer <id> --chosen '…' --by '<who>'`"* | same, plus "or they answer in the app" |
| `answer` *(new)* | **agent-run** — transcribes the human's out-of-band answer verbatim (humans never type commands). `--chosen` (verbatim-checked) · `--text` · `--approve\|--request-changes\|--reject` · `--by` (required) · `--no-push`. Stamps `source: "chat"` itself (no flag). Ask must exist locally, else die. Taught rule: *record your human's words — never answer your own ask* | same; auto-push carries it to the app's thread |
| `resolve` | **pure close, fully local.** Auto-cites the newest event for that ask, CLI-stamped (`resolution.answer`) — **no `--chosen`, no `--by`, no `--answer-id`** (all cut; see §6). Keeps `--note` · `--run <run-id>` · `--withdrawn` · `--rejected` · `--no-push`. No event on file: die with the teaching menu — *answered in chat? → `figs answer` first · retracted? → `--withdrawn` · declined? → `--rejected` · cleared on its own? → proceed with `--note` (recorded `via: "self"`)* | same + auto-push |
| `inbox` | pure local read: in-flight jobs (`runs.jsonl`), open asks (`asks.jsonl`), threads (`answers.jsonl`) — grouped per ask, time-ordered, **no win-logic: complete transparent truth, the agent judges**. `inbox <ask-id>` = full detail + artifact restore | + the soft down-sync first (§7); `--no-sync` to skip |
| `doctor` | **full conformance offline, exit 0** ("server validation skipped" note). Validates everything: charter placeholders, runs/asks/answers shapes, event ids, `resolution.run`/`run` refs, `--chosen`-vs-options. The spec's account-free reference validator | + server validate as a second opinion |
| `push` | clear error: `not linked — figs link` (exit 1) | spine + artifacts + **answer events the server lacks**; version floor check lives here |
| `status` | mode, files, journal honesty line ("records live on this machine") | + account, workspace |
| `login` / `logout` | inherently connected; device flow unchanged; `login` when already logged in says so before replacing | — |
| `version` | **prints locally, no network**; `--check` opts into the update check | same |
| `help` | grouped **local / connected**; exit codes documented; `answer` described as "record your human's answer" | same |

**Cut in the final sweep** (each made the model stronger): the `workspaces` verb (= bare
`link`'s empty-input behavior) · `init --workspace` and `init --endpoint` (init must be
incapable of needing the network; endpoint is a connection property → `link`) ·
`resolve --chosen/--by` (replaced by `answer`; if kept as fallback, agents' priors would skip
`answer` forever and the ledger would stay empty) · `resolve --answer-id` (see §6) · the
`--source` flag (field stays; flag was a spoofing surface).

**Considered and kept:** `report`/`checkpoint` as two verbs (the split IS the lifecycle
teaching) · `--no-push` (batching) · `ask --stdin` (long prose vs shell quoting) ·
`--to manager|builder` · the three verdict flags on `answer` (self-teaching) · `--trigger`
(what set the sitting in motion → `session.trigger`) · `--unit` (which charter unit the work
concerns) · `--period` (which time slice, e.g. `2025-11`).

### When there's no `.figs/` here: peek, never use

No walk-up — **the fleet topology forbids it** (an openfigs fleet has the recruiter's `.figs`
at the root and each employee's own `.figs` in its folder; walk-up would let an
un-initialized subagent silently report as its parent: identity bleed). Instead the error
peeks upward and informs: *"no `.figs/` here, but found one at `../..` (agent: Recruiter) —
if you ARE that agent, cd there; if you're a different agent, run `figs init` at YOUR root."*
The CLI never adopts a parent's identity; the smart agent gets the facts. GUIDE teaches:
open agents at their own root; delegating means entering the agent's root.

---

## 6. Ids: names vs plumbing (keystone #3)

Two id classes with opposite designs:

- **Names** — job ids, ask ids, unit ids. **Agent-authored, meaningful, stable**
  (`recon-acme-2026-11`); the runs list reads as a job list *because* agents name jobs.
- **Plumbing** — event ids, the agent UUID, workspace UUIDs. **Machine-minted,
  machine-cited. No command accepts one — enforcement by absence of surface.** `answer`
  mints event ids; `resolve` auto-cites from disk; `init` mints the agent UUID; `push`
  attaches it. **Contract rule: no new flag may ever accept an event id or UUID.** (Lives in
  `CLAUDE.md` + `CONTRIBUTING.md`.)

Why `--answer-id` died: the citation (`resolution.answer`) stays — it powers `via: "figs"`,
the app's answer→close→job rendering — but the *override flag* defended only the
"acted on a non-latest answer" edge, and when a later answer *contradicts* the one acted on,
the right move is never "close anyway with a careful citation" — it's to address the
contradiction. So: **resolve auto-cites the newest event for that ask, 100% CLI-stamped;
nuance goes in `--note`.** Single citation (the decisive event); the full thread is in the
record anyway. If multi-citation is ever needed, the spec's `artifact`/`artifacts`
singular-shorthand pattern extends additively.

### Reference checks (every typed id, every command)

*Creatable ids announce; reference ids are checked; closes die, links warn.*

- **Creatable** (`report --id`, `checkpoint --id`, `ask --id`) — can't validate (new ids and
  folds are both legitimate), so every write **announces which happened**: `new job opened:
  <id>` vs `folded onto existing job <id>`. A typo meant as a continuation prints "new job"
  and the agent catches itself.
- **Reference** — checked against the journal (complete under the topology rule):
  `resolve <ask-id>` / `answer <ask-id>` → must exist, else **die** ("not in this journal —
  `figs inbox` shows your open asks") · `--run <run-id>` → unknown id **warns loudly**
  ("typo? this link will dangle" — warn not die: a dangling link is damage-limited, a blocked
  ask is not) · `--unit` → checked against the charter, warn · `--chosen` → verbatim-checked
  with did-you-mean (shipped; the prototype for the pattern) · `inbox <ask-id>` → clear
  not-found (shipped).

### Flag-naming rule

Flags mirror the spec field they set (`--run` sets `run`, `--unit` sets `unit`); help text
always shows the id placeholder (`--run <run-id>`). No exceptions remain (the one candidate,
resolve's citation flag, was cut rather than renamed).

---

## 7. The data plane in detail

### `answers.jsonl` — the human-utterance ledger

Separate file, not folds into `asks.jsonl`, for a load-bearing reason: **the two files have
different algebra.** Asks are *records that fold* (field-merge by id, latest wins); answers
are *events that accumulate* (answer → changes-requested → approved must all survive).
Folding events into a folding file forces two merge rules into one file — complexity every
implementer inherits.

Event shape (spec v2 §6.3):
`{ "id": "evt-…", "ask": "<ask-id>", "kind": "answer" | "verdict", "by": "<who>", "ts": "…", "source": "app" | "chat", "chosen"?: "<option verbatim>", "text"?: "…", "verdict"?: "approved" | "changes-requested" | "rejected" }`

- **`source` = *where*, not who** (always a human): `"app"` = answered in Figs
  (server-minted) · `"chat"` = told to the agent in its session, transcribed (CLI-stamped; no
  flag). Extensible additively (`slack`, `email`) when integrations exist.
- **The trust rule (normative, spec v2):** readers derive the verified grade from **mint
  origin** — an event the server minted is attested; an event pushed up from a machine is
  transcription, whatever its fields say. `source` is display metadata, never trust input.
- Events are immutable; a correction is a **new** event (humans correct themselves by
  answering again).
- **Multiple answers per ask are normal** (clarifications, corrections, changes-requested →
  approved). The protocol's job is infra + transparency: inbox shows the whole thread per
  ask, time-ordered — **no win-logic; the agent judges.**

### Direction purity

- **Up = `figs push`** (and every writing verb's auto-push): spine, referenced artifacts,
  and answer events the server lacks (dedupe by id; server stores as relayed/transcribed).
- **Down = `figs inbox`'s soft sync, answers only**: ~5s budget; on failure or an incomplete
  response, **loud** ("showing local state — couldn't reach {endpoint}" / "sync incomplete")
  and degrade to the local view. Never silent — a stale inbox claiming "nothing needs you" is
  the product's worst failure mode. The server must return the complete open surface or flag
  truncation (spec v2 §8). No cursors until scale demands.
- Nothing else touches the network. `resolve` and `answer` are fully local; scripts wanting
  machine-readable sync use `inbox --json`.

### The full loop, one ritual, both modes

ask → *(answer arrives — app or chat)* → synced down if app / `figs answer` if chat → act →
real work reported under its own job id (`--trigger 'inbox: answer on <ask-id>'`) →
`figs resolve <ask-id> --run <job-id>`. Back-and-forth works by construction: revisions fold
on the same ask id; events accumulate; the thread interleaves by `ts`. Rejected stays sticky.

### Interconnections — ids and time, never pointers between same kinds

**Chains emerge from ids + time; no record points at its own kind.** The graph is bipartite
with the **job as the hub**: `ask.run` (the job an ask was born from) · `resolution.run` (the
job an answer caused — *new field*, mirror of `ask.run`; how a manager sees what happened
between answer and close: the job's row carries its whole checkpoint trail, since checkpoints
are folds on the job id) · `event.ask` (the thread anchor) · `resolution.answer` (the cited
decisive event, CLI-stamped) · `session.trigger` (the prose breadcrumb back). **Explicitly
refused: `ask.parent`/`supersedes`** — follow-up needs chain through the job; the zero-work
follow-up names the prior ask in `found` (convention). Additive later if dogfooding demands.

### Crash tolerance (the journal must survive the agent dying)

Append isn't atomic — a process killed mid-write leaves a half line, which today bricks every
verb until hand-repaired. Fix: **tolerate exactly one malformed final line** — shout ("last
line of runs.jsonl is broken — likely a crash mid-write; skipped; re-report that record") and
keep working; die loudly on malformed *interior* lines. Plus a re-check-before-append guard
for concurrent same-machine sessions.

### Files and verbs

Verbs cover the *streams* (report/checkpoint → runs · ask/resolve → asks · answer → answers).
`agent.json` deliberately has **no verb**: it's a *document* (the charter, prose-rich) —
agents edit files natively; `init` scaffolds the template, `doctor` refuses placeholders.
Hand-writing any file stays *legal* (files are the protocol) — never *necessary*.

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
   prod + local dev side by side. **Migration:** key the old single token to the endpoint in
   the nearest `config.json` when present, else the default; normalize origins (scheme, host,
   port; no trailing slash).
3. **`figs_…` token prefix** (app-side mint) — self-identifying, greppable, secret-scanning
   ready.
4. `figs link` is the auth-adjacent verb: verifies workspace access when a token exists;
   warns "unverified until first push" otherwise.

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
- **The full handoff loop** — structured asks; answers recorded verbatim (`figs answer`);
  closes that cite their evidence; the whole conversation greppable on disk.
- **Validation that teaches** — `doctor` + validate-on-write + reference checks, offline.
- **A session ritual** — inbox → checkpoint → report → resolve. The shape of a trustworthy
  employee, enforced by tooling.
- **A costless exit ramp** — `figs link` later and everything recorded since day one
  publishes. Nothing is lost by starting local.

Honesty lines that keep the claim trustworthy: the journal is **machine-local** (a fresh
clone starts fresh; the app is the durable record humans see) · local records are
self-reported (the verified grade is what linking adds).

---

## 10. Output + craft

- **`--json` envelope, defined before coding:** `{ ok, data, warnings: [] }` on every read
  verb (status, inbox, doctor, version); warnings mirrored to stderr; `inbox --json` includes
  sync status so a degraded sync is machine-detectable.
- stdout = data, stderr = warnings/teaching (sweep the stragglers).
- Exit codes per §3, documented in `figs help` and README.
- Ship `GUIDE.md` in the npm package (`files[]`) for air-gapped agents.
- README quickstart flips: 30-second **no-signup** local quickstart first; linking as the
  upgrade, pitched **multiplayer/fleet first**.
- The scaffolded `.figs/.gitignore` comment explains the machine-local journal choice.
- **The no-account audit is a committed test script**, not a checklist: runs every verb with
  credentials absent + endpoint unroutable, asserts the §3/§5 tables. Release blocks on it.
  Test matrix additionally covers: linked/no-token, network-off, duplicate event ids,
  truncated sync, crashed-tail recovery, peek-don't-use.

---

## 11. Spec changes — `figs-spec` v2

Two-way flow + sync is **not** additive to a spec whose v1 says "one-way; two-way reserved
for a future version" — claiming v1 would make the governance look unserious (review
finding, adopted). **v2 it is**, shipped with CLI 1.0.0:

- §1 principles: add **Account-optional** (protocol + local tooling fully usable with no
  account or network; a reader is strictly additive) and the **topology rule** (§4: one
  agent = one repo = one machine is the supported write topology; ledgers up-only; answers
  the sole two-way file).
- §3 `config.json`: `workspaceId` *and* `endpoint` optional — absent = local mode; written
  together by `link`.
- §6.2 `Resolution`: add `run` (the job the answer caused); `answer` remains the cited
  event id, now CLI-stamped.
- §6.3 *(new)*: `answers.jsonl` — file, event shape, `source`, immutability, mint-once ids,
  **the trust rule** (verified grade = mint origin; `source` is display only).
- §8 wire: `Authorization: Bearer`; push payload gains `"answers": […]`; the down-sync GET
  (answers only, complete-or-flag-truncation); the server regression guard (never walk a
  closed/settled record backwards on push).
- §9 validation: **local validation is normative** for conformance; server validation
  optional.
- Reserved: thread-event kinds `note`/`directive` stay reserved; provenance/signing stays
  reserved; cursors/pagination named-deferred.

---

## 12. Rollout

1. **State model + surface**: optional `workspaceId`/`endpoint`, `requireFigs` →
   agentId-only, zero-flag `init`, new `link` (absorbs `workspaces`), exit codes 0/1/2,
   peek-don't-use error, `version` offline, announce new-vs-fold, reference checks.
2. **`doctor` offline + validation completeness** (incl. the new files/fields) + the
   `--json` envelope everywhere.
3. **The data plane** (one step — the pieces only work together): `answers.jsonl` +
   `figs answer` + inbox local read + answers-only soft down-sync + resolve as pure local
   close (auto-cite) + push carrying answers + crash tolerance. App work in the same step:
   ingest accepts `answers`, the down-sync GET (complete-or-flag), the regression guard,
   threads render `source`.
4. **Auth**: Bearer (+ app dual-accept), per-endpoint credentials + migration, `figs_`
   prefix, `link` verification.
5. **The audit script + test matrix** (release gate live from here on).
6. **Docs flip**: README (local-first quickstart, exit codes, multiplayer pitch), GUIDE,
   llms.txt, help regrouping; SPEC v2 lands.
7. **Cross-repo**: `create-openfigs` outro → `figs init` first, login later · `openfigs`
   template GUIDE wording · HQ `docs/architecture.md` updated at ship (including one quiet
   line that a conforming server is substitutable — known consequence, chosen knowingly, not
   a public claim) · **delete this file**.

---

## 13. Deferred (post-1.0, named so nothing repurposes them)

- A public bare-sync verb (`pull`) — additive if scripts/cron ever need sync-without-display.
- Sync cursors/pagination — when an agent's open surface stops fitting one response.
- Multi-event citation (`resolution.answers[]`) — via the `artifact`/`artifacts` shorthand
  pattern, if ever needed.
- `source` values beyond `app`/`chat` — arrive with real integrations.
- Token scopes (push-only runner tokens) · ask→ask links (only if dogfooding shows bare
  follow-up chains are common) · relayed-answer display polish app-side.

## 14. Assumptions

- 0 users → one breaking wave: **CLI 1.0.0 + spec v2**, no compatibility shims beyond the
  app's brief `x-figs-token` dual-accept and the credentials-file migration.
- App contract changes are scoped to: Bearer dual-accept, ingest `answers`, the down-sync
  GET, the regression guard, `figs_` token mint, thread rendering by `source`.
- The Meridian demo fleet + dogfood agents are linked already; optional fields are a
  relaxation — unaffected.
- Local-mode value is a goal in itself, not merely a funnel tactic; docs are written from
  that posture.
