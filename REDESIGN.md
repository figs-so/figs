# REDESIGN — the local-first CLI

> **Working doc** (2026-06-12). The design for making `figs` a 100/100 open-source CLI:
> **fully usable with zero account, strictly better with one.** Delete this file once shipped —
> its content lands in `README.md`, `GUIDE.md`, `SPEC.md`, and `figs.mjs` itself.
> Status: **design agreed, not yet implemented.** We have 0 users — breaking changes are free
> and we should spend that freedom now.

---

## 1. The diagnosis

**The spec says local-first; the CLI's front door is remote-first.** `SPEC.md` §1 lists
*Local-first* as the second design principle, and the README calls `.figs` an open protocol
anyone can implement. But the reference CLI contradicts both at the entry point:

| # | Gap | Where |
|---|-----|-------|
| 1 | **`figs init` requires an account.** No token + no `--workspace` → dies with "run `figs login` first". Workspaces are minted server-side, so a no-account user cannot init at all — and `requireFigs()` demands `workspaceId`, so report/checkpoint/ask/resolve are all transitively account-gated. | `figs.mjs` `resolveWorkspaceId`, `requireFigs` |
| 2 | **`figs doctor` dies without login** after all local checks pass — yet README calls it "the conformance check for hand-authored or non-CLI setups". An open standard whose validator needs an account isn't open. | `figs.mjs` `doctor()` |
| 3 | **Writing verbs exit 1 without a token.** The record is safely written locally, then the auto-push fails and the verb exits non-zero. To an agent, exit 1 = the report failed. There is no notion of a deliberate local mode. | `autoPush()` |
| 4 | **Teaching errors form a circle that ends at "create an account."** `requireFigs` → "run `figs init`" → "run `figs login`" → sign up. No documented no-account path anywhere (README quickstart leads with `login`; `create-openfigs` prints `figs login && figs init`). | help/README/onramps |
| 5 | **`figs inbox` is remote-only — including the parts that are local data.** Unfinished (in-flight) jobs are *fetched from the server* even though `runs.jsonl` on disk is the source. And there is no local answer channel at all. | `inboxCmd`, `fetchInbox` |
| 6 | **Auth is 90% right but has two non-standard edges:** a custom `x-figs-token` header instead of `Authorization: Bearer`, and one global token that is endpoint-blind (switch `FIGS_ENDPOINT` to localhost and the CLI sends your prod token there). | `request()`, `saveToken()` |

Root cause: the CLI was grown from the hosted app outward (login → workspace → push), instead
of from the files outward (init → work → optionally publish). The fix is a re-foundation, not
six patches.

---

## 2. North star: the git mental model

**Map the CLI onto git.** Agents know git natively — adopting its shape means zero learning
curve for the primary audience, and git is the canonical proof that local-first + hosted-better
works as a product (git → GitHub):

| git | figs | Property |
|---|---|---|
| `git init` | `figs init` | purely local, zero prerequisites, instant value |
| `git remote add origin` | `figs link` *(new)* | connecting is a separate, later, optional act |
| `git commit` | `figs report` / `checkpoint` / `ask` / `resolve` | recording works offline, always |
| `git push` | `figs push` | the one explicit outward act — now carries answers too |
| `git pull` | *(inside `figs inbox`)* | sync is internal, soft, and happens where the data is used — agents get one correct session-start command, no separate ritual |
| `git status` | `figs status` | local truth first, remote state when available |
| GitHub PRs/reviews | the app's inbox + answers | the multiplayer layer is where the hosted product earns its keep |

**Three layers, documented everywhere in these words:**

1. **The protocol** — the `.figs/` files. Tool-independent; anything can read/write them.
2. **The local CLI** — correctness + convenience over the files: id/ts stamping, fold-by-id,
   validation with teaching errors, the session ritual (inbox → checkpoint → report). Needs
   nothing but a filesystem. **This is the product a no-account user gets, whole.**
3. **The connected layer** — an account + a workspace: publishing, the org chart, and
   *verified, attributed* human answers. Strictly additive.

The honest sales line that falls out: **local = the full loop, self-reported · linked = the
same loop, verified and multiplayer.** Auth buys attribution, not functionality.

---

## 3. The state model (the keystone)

Two orthogonal bits, both explicit, no heuristics:

- **local vs linked** — does `config.json` have a `workspaceId`? Absent = **local mode**
  (deliberate, first-class). Present = **linked** (this repo intends to publish).
- **authenticated** — does this machine have a token (`~/.figs/credentials.json` / `FIGS_TOKEN`)?

**The rule that fixes every exit-code question:** *the config declares intent; the CLI errors
only when declared intent can't be met.*

| State | Writing verbs | Push behavior |
|---|---|---|
| local | write, validate, **exit 0** | not attempted — one calm line: `local mode — figs link to publish` |
| linked, no token | write, **exit 1** | attempted contract unmet: `not logged in — run figs login` |
| linked, push fails (network/4xx) | write, **exit 1** | record is safe locally; `fix and run figs push` |
| linked, push ok | write, exit 0 | pushed |

A missing token in local mode is a *state*, not an error. A missing token in linked mode is a
real error, because the repo said it publishes. `checkpoint`'s loud "NOT protecting the job"
warning fires only when linked (in local mode the local file *is* the protection).

---

## 4. Verb-by-verb target

| Verb | Today (no account) | Target — local | Target — linked |
|---|---|---|---|
| `init` | **dies** | scaffolds fully, mints `agentId`, exit 0 | `--workspace` flag = init + link sugar |
| `link` *(new)* | — | bare: lists workspaces (needs token); `--workspace <slug\|uuid>` sets it | same; slug resolution needs token, UUID doesn't |
| `report` / `checkpoint` / `ask` / `answer` / `resolve` | write then **exit 1** (`answer` doesn't exist) | write, exit 0, no push attempt | write + push; failure exit 1 |
| `inbox` | **dies** | pure local read: in-flight jobs + open asks + `answers.jsonl` threads | soft down-sync first, then the same local read (§5); `inbox <ask-id>` restores artifacts |
| `doctor` | local checks then **dies** | full conformance offline, exit 0 (`server validation skipped` note) | + server validate as a bonus layer |
| `status` | works | works — shows `mode: local` and what linking adds | works |
| `push` | fails "not logged in" | fails clearly: `not linked — run figs link` | requires token (correct today) |
| `login` / `logout` / `workspaces` | inherently connected — correct | unchanged | unchanged |

Per-verb notes:

- **`init`** never touches the network. Output must state the instant value (§7) *and* both
  next paths: "you're fully operational locally · `figs link` when you want it on app.figs.so".
  `--workspace` stays as the one-command happy path for already-logged-in users.
- **`link`** absorbs everything `init` currently does with workspaces (slug resolution,
  single-workspace default, list-and-choose). Unlinking = delete the field from `config.json`;
  no verb needed (keep the surface small).
- **`doctor`** becomes the spec's reference validator: local validation is normative and
  account-free; server validation is an additive second opinion. Relax its config requirement
  to `agentId`-only. Give it a unified `--json` (local + server issues, one shape).
- **`requireFigs()`** relaxes to `agentId`-only; only `push`/`link` care about `workspaceId`.

---

## 5. The data plane — answers, sync, and a local-first inbox

*(v3 of this section. v1 was display-merge — two read paths merged at print time. v2
introduced a `pull` verb. v3 drops the verb: sync is an internal act of `inbox`/`resolve`,
answers are a first-class pushed ledger, and `resolve` becomes a pure close.)*

### The model: one transport up, one sync down, no new ritual

The two-ledger split makes sync **trivially conflict-free**: events are immutable records
with ids minted **once, by whoever creates the event, never re-minted** — so both directions
reduce to dedupe-by-id. The remote data plane is:

- **`figs push`** — up, the one transport (unchanged shape, one addition): the agent's spine,
  referenced artifacts, **and `answers.jsonl`** — locally-recorded answer events the server
  doesn't have yet (it stores them keyed by event id; idempotent). The app's thread stays
  complete even when answers arrive out-of-band.
- **Down-sync** — *not a verb*: an internal, soft, timeout-bounded act that `figs inbox` (and
  `figs resolve`) run first when linked, scoped to **this agent's identity**:
  - **Human events** → appended to `.figs/answers.jsonl` if the event id is absent locally.
  - **The agent's own records raised on other machines** → appended home **only if the id is
    entirely absent locally** (see the rulebook below — this condition is load-bearing).
  - **Artifacts: never on a bare sync.** `figs inbox <ask-id>` restores that ask's full
    handoff package — thread + hash-verified artifacts (today's behavior, kept; **the parked
    `fetch` idea dies before birth**). Bare sync stays cheap JSON — roughly the same payload
    today's `figs inbox` already fetches and throws away; we just stop discarding it.
- Everything else is local. `login`/`logout`/`link`/`workspaces` are the control plane.
  **You push your work up; your inbox brings their answers down. The rest never needs a server.**

### The sync rulebook (every case, written down)

| # | Case | Rule |
|---|------|------|
| E1 | Server event id absent locally | append to `answers.jsonl` |
| E2 | Server event id present locally | skip — events are immutable |
| E3 | Locally-recorded event (`figs answer`) | pushed up; server stores by id; later syncs see the same id → E2. No dupes possible |
| E4 | Human answered in the app *and* the agent transcribed a chat answer | two distinct events (two ids, two sources) on one ask — both kept; that's reality (two utterances). `resolve` cites the one acted on |
| E5 | Correcting an answer | never edit/delete an event — a correction is a **new** event (humans correct themselves by answering again) |
| R1 | Ask/run record exists only on server (raised on another machine) | sync appends the whole folded record home |
| R2 | Ask/run record id exists locally **in any state** | **never re-append from the server.** Local wins; the server reconciles on next push (idempotent upsert). This is the rule that prevents a stale server copy from resurrecting a locally-closed ask via fold-ordering |
| A1 | Referenced artifact absent locally | fetched on `inbox <ask-id>`, hash-verified |
| A2 | Artifact present, identical bytes | skip (already shipped behavior) |
| A3 | Artifact present, different bytes | leave untouched + warn (already shipped behavior) |
| — | Ordering | ids are identity; `ts` is display order only. Threads render agent folds + human events interleaved by `ts` |

### `answers.jsonl` — why a separate file, not folds into `asks.jsonl`

Considered folding answers into `asks.jsonl` and rejected it, for a sharper reason than tidiness:

- **The two files have different algebra.** `asks.jsonl` holds *records that fold* —
  field-level merge by id, latest wins; the close is one fold line. Answers are *events that
  accumulate* — an ask can carry answer → changes-requested → approved, and every one must
  survive. Folding events into a folding file forces an `events[]` array with append-merge
  semantics — two merge rules in one file, complexity every implementer inherits.
- **A split by content, not by author.** `asks.jsonl` holds the agent's claims;
  `answers.jsonl` holds **human utterances** — sometimes minted by the app (authenticated),
  sometimes transcribed by the agent (`figs answer`, below). Since the agent writes both
  files locally, provenance lives in the event itself: the **`source`** field.
- Cost acknowledged: one more file for implementers. Mitigated: it's optional, readers ignore
  unknown files, and a pure-reporting implementation never touches it.

Event shape (lifted from SPEC's Reserved section, plus `source`):
`{ "id": "evt-…", "ask": "<ask-id>", "kind": "answer" | "verdict", "by": "<who>", "ts": "…", "source": "app" | "chat" | …, "chosen"?: "<option verbatim>", "text"?: "…", "verdict"?: "approved" | "changes-requested" | "rejected" }`

**`source` is *where*, not *who*** — the answerer is always a human; `source` records the
channel the answer arrived through: `"app"` = answered in Figs (server-minted, authenticated,
the verified grade) · `"chat"` = told to the agent directly in its working session and
transcribed by it (self-reported grade). Extensible additively (`slack`, `email`, …) without
spec breakage. Minted once with the event, travels with it forever — push and sync never
rewrite it.

### `figs answer` — the agent records its human's answer

**Run by the agent, like every other verb** — humans don't type commands. You answer in chat
("approved, but only the 15 ready ones"); the agent transcribes that, verbatim, into the
record:

`figs answer <ask-id>` — `--chosen '<option verbatim>'` (checked against the ask's options,
same discipline as resolve) · `--text '…'` · `--approve | --request-changes | --reject` for
sign-offs · `--by '<who answered>'` (required — attribution is the point) ·
`--source` (defaults to `"chat"`).

It is **just another writing verb**: append to `answers.jsonl`, validate, auto-push — the
same transport as report/ask/resolve. No special endpoint, no linked-mode special case
(the earlier one-landing-zone POST design is dead; answers ride `figs push` like everything
else, per the sync rulebook E3).

Why record before resolving, instead of letting resolve carry it (today's flow)? **The answer
becomes durable the moment it's given.** If the session dies between your answer and the
finished work, the next session's inbox finds the answer on disk — you never repeat yourself.

The one taught rule (in the verb's help and llms.txt): **record your human's words — never
answer your own ask.** Locally unenforceable (filesystem-trust, like everything local);
linked, relayed events are visibly agent-pushed and `source`-marked.

### `figs resolve` — now a pure close

Resolve sheds its hidden second job. Today it both closes the ask *and* fetches/records the
answer evidence (a soft network re-fetch inside the verb). Now the evidence always already
exists as an event in `answers.jsonl` — pulled down by sync, or transcribed by `figs answer`
— and the ask-link exists the moment the event does (`ask: <id>` is in the event). So:

- **Resolve means:** *"I acted on what was answered (or withdrew/acknowledged); this ask is
  done."* One fold line: status + resolution.
- It **cites the latest event from disk automatically** (`resolution.answer: <event-id>`,
  `chosen`/`by` copied from the cited event for the folded record's readability;
  `--answer <event-id>` to disambiguate when several exist). No `--chosen` retyping, no
  network on the close path.
- `--note` stays (the agent's one-line account, citing the job id of work done);
  `--withdrawn` / `--rejected` stay (the no-answer closes). `via` is derived: cited
  `source: "app"` event → `"figs"`; cited transcribed event → `"human"`; no event → `"self"`
  or none, as today.

**The full loop, both modes, one ritual:** ask → *(answer arrives — app or chat)* → record if
chat (`figs answer`) / synced if app → act, report real work under its own job id →
`figs resolve <ask-id>`. **Back-and-forth works by construction:** a changes-requested
verdict → the agent revises and re-raises on the *same ask id* (a fold) → a new answer event →
… Agent folds accumulate on the ask; human events accumulate in `answers.jsonl`; the thread
is both, interleaved by `ts`. Rejected stays sticky/terminal as spec'd.

### `figs inbox` — local read + soft sync

Inbox's read path is **100% local files**: in-flight jobs from `runs.jsonl`, open asks from
`asks.jsonl`, threads from `answers.jsonl`. Local and linked mode share one implementation.

**When linked, inbox runs the soft down-sync first** (timeout-bounded; on failure it degrades
to the local view with a "showing local state — couldn't reach {endpoint}" warning). This is
deliberate: the inbox's one job is "what needs me *now*?", and answers arrive precisely while
the agent is away — a silently stale inbox saying "nothing needs you" is the worst failure
mode the product can have, worse than a network touch. Agents get one session-start command
that is simply correct. (`--no-sync` for the purists; there is no separate sync verb to
ritualize or overuse.)

**Education, in the tool not the docs:** in local mode, `figs ask`'s closing line becomes
*"when your human answers (in chat), record it: `figs answer <id> --chosen '…' --by '<who>'`"*
(today it says "answer in the app"). Inbox's next-move lines update the same way.

**Honesty grade, stated plainly in docs:** `source: "chat"` events are transcription —
the same self-reported grade as everything local. `source: "app"` events are authenticated,
permission-gated, attributed by mechanism. *That delta is the pitch for linking — articulated,
not enforced by crippling local mode.*

**Spec impact:** additive, but `answers.jsonl` is now **wire format, not just local
convention**: §6.3 defines the file + event shape (+`source`); §8's push payload gains
`"answers": […]`; §8 also specs the down-sync contract (a GET for this agent's events +
absent records; per-ask artifact restore) — delivery agent-pulled, exactly as Reserved
already promises. No cursors/pagination until scale demands — sync moves the agent's open
surface whole and dedupes by id; it's small by construction.

---

## 6. Auth — review and redesign

**What's right (keep, it's ahead of most CLIs):** device flow where the agent never sees the
token · pasted-token fallback for headless · `0600`/`0700` perms enforced on every save ·
`FIGS_TOKEN` env override for CI · logout that names the server-side revocation step · the
clean split *auth = the user, identity = the agent*.

**Change:**

1. **`Authorization: Bearer <token>`** replaces the custom `x-figs-token` header. Standard;
   proxies, WAFs, log scrubbers, and secret scanners all understand it. App accepts both until
   the next `MIN_CLI` bump, then drops the custom header.
2. **Credentials keyed by endpoint origin.** `~/.figs/credentials.json` becomes
   `{ "https://app.figs.so": { "token": "…" }, "http://localhost:3000": { "token": "…" } }`.
   Fixes the real bug (prod token sent to whatever `FIGS_ENDPOINT` points at) and allows
   prod + local dev sessions side by side. Precedents: npm per-registry, `gh` hosts file,
   docker config. Migration: on first read of the old single-token shape, rewrite keyed to the
   default endpoint.
3. **Token prefix `figs_…`** (app-side mint): self-identifying in logs, greppable, and
   eligible for GitHub secret-scanning partnership later.
4. **`figs login` when already logged in** should say so ("logged in as X — continuing will
   replace this machine's token") instead of silently starting a new flow.

**Deliberately NOT doing (over-engineering at this stage):** OAuth refresh tokens / expiry
(long-lived revocable PATs are fine and simpler for agents) · OS keychain (files work headless;
that's our world) · multi-profile/account switching (per-endpoint covers the real case) ·
token scopes (park "push-only token for runner boxes" as reserved).

---

## 7. What local mode gives an agent instantly (say this everywhere)

One `figs init`, zero account, and the agent has:

- **An identity** — a stable UUID + a charter (`agent.json`): who it is, machine-readable.
- **A work journal** — jobs under stable ids, fold-by-id progress, in-flight/settled
  lifecycle. **Crash-recoverable memory across sessions:** the next session runs `figs inbox`
  and finds what its past self left in flight. This is the killer local feature — agents die
  constantly; the journal survives.
- **A handoff record** — structured asks (options, details, attachments) + the resolve
  discipline (cite what you acted on, verbatim). With `figs answer`: the full ask→answer→act
  loop, asynchronous, on plain files.
- **Validation that teaches** — `doctor` + validate-on-write, offline.
- **A session ritual** — inbox to start, checkpoint as you go, report to settle. The shape of
  a trustworthy employee, enforced by tooling.
- **A costless exit ramp** — `figs link` later and *everything recorded since day one*
  publishes (push sends the whole folded outbox). Nothing is lost by starting local. Say this
  sentence verbatim in README/GUIDE — it's what makes "account optional" credible.

It's a structured memory + reporting layer in greppable plain files. That's lots of value at
zero cost — which is exactly what makes the funnel honest.

---

## 8. The 100/100 polish list (hygiene, alongside the redesign)

- `--json` on every read verb with one consistent envelope (`doctor` gets a unified one).
- Exit-code semantics documented in README + `figs help`: `0` = recorded/valid · `1` = error
  or declared intent unmet.
- `figs help` groups commands by layer — **local** vs **connected** — teaching the model in
  the help text itself. `figs answer` marked "run by your human".
- stdout = data, stderr = warnings (mostly true today; sweep the stragglers).
- Ship `GUIDE.md` in the npm package (`files[]`) so air-gapped agents have the full guide.
- README quickstart flips: 30-second **no-signup** local quickstart first, then "see it in the
  app" as the upgrade. (Better top-of-funnel too: "works before you sign up" is the strongest
  devtool pitch there is.)
- Scaffolded `.figs/.gitignore` comment explains the local-mode choice (see open question 3).

---

## 9. Spec changes (`SPEC.md`, all within v1)

- §1: add the principle by name — **Account-optional.** The protocol and the local tooling are
  fully usable with no account or network; a reader/remote is strictly additive.
- §3: `workspaceId` → **optional**. Absent = local mode (not yet linked). Required only to push.
- §6.3 *(new)*: `answers.jsonl` — the human-utterance ledger; event shape lifted from
  Reserved + the `source` field (*where* the answer arrived: `app` · `chat` · extensible).
  Events are immutable, ids minted once. **Pushed** (it's wire format).
- §8: wire auth = `Authorization: Bearer`; push payload gains `"answers": […]`; add the
  **down-sync contract** beside push — a GET for this agent's events + locally-absent
  records (and per-ask artifact restore), delivery agent-pulled as Reserved already promises.
  The sync rulebook (§5) is normative: append-if-absent by id, local always wins.
- §9: local validation is normative for conformance; server validation is optional.

All additive/relaxing → stays `figs-spec v1`.

---

## 10. Rollout order

1. **The state model** — optional `workspaceId`, `requireFigs` relaxation, `init`/`link`
   split, state-aware push + exit codes. *(This alone makes the headline claim true.)*
2. **`doctor` offline** + unified `--json`.
3. **The data plane**: `answers.jsonl` + the soft down-sync inside inbox/resolve + inbox
   rebuilt as a local read + `figs answer` + resolve-as-pure-close + push carrying answers;
   SPEC §6.3 + §8. *(One step — the pieces only make sense together.)* App work in the same
   step: ingest accepts `answers`, threads render relayed events by `source`.
4. **Auth**: Bearer header, per-endpoint credentials (+ app dual-accept).
5. **Docs flip**: README quickstart, GUIDE, llms.txt, help regrouping, exit-code docs.
6. **Cross-repo follow-ups**: `create-openfigs` outro → `figs init` first, login later ·
   `openfigs` template GUIDE wording · app: Bearer dual-accept, `figs_` token prefix,
   llms.txt update.

Every step updates the **no-account audit** in `CLAUDE.md` (the release gate).

---

## 11. Open questions (with recommendations)

1. **`link` vs `connect` vs `remote` naming.** → **`link`** (Vercel/Supabase/Railway
   precedent; agents have seen it; "remote" overloads git vocabulary without being git).
2. **Ship the answer channel now or keep it reserved?** → **Ship in this redesign** (step 3).
   We're at 0 users; it completes the local story, the event shape is already locked in
   Reserved, and it's the difference between "local works" and "local is whole".
   2b. ~~`pull` vs `fetch` vs `sync` naming~~ → **SETTLED: no sync verb at all.** Sync is an
   internal act of `inbox`/`resolve`; `inbox <ask-id>` is the artifact door. The parked
   `fetch` command is never built. (A public `pull` can be added later, purely additively,
   if scripts/cron need bare sync.)
   2c. ~~Auto-pull or explicit?~~ → **SETTLED by 2b:** the soft sync runs inside inbox —
   one correct session-start command; `--no-sync` to skip. A stale inbox claiming "nothing
   needs you" is the product's worst failure mode, so freshness wins over purity.
3. **Local mode: commit the outbox or keep it gitignored?** In linked mode the outbox is
   transient (remote is durable); in local mode the files ARE the record, surviving only on
   that machine. → **Keep gitignored by default** (privacy-safe: runs/asks can carry sensitive
   scope; committing should be a deliberate human act). Document the trade-off in the
   scaffolded `.gitignore` comment so the choice is visible.
4. ~~Should linked `figs answer` POST to the API?~~ → **SETTLED: neither — answers ride
   `figs push`** like every other writing verb (one transport, no new endpoint, ids minted
   once so sync-back dedupes). Decided 2026-06-12: locally-recorded answers DO push up, so
   the app's thread stays complete even for out-of-band answers.
5. **Keep `--no-push`?** → **Yes** — batching is orthogonal to mode (linked agents legitimately
   batch mid-job and push once).
6. **Dual-accept window for the old `x-figs-token` header?** → **Yes, briefly** — 0.8.0 is on
   npm and `npx @latest` doesn't protect pinned installs; drop it at the next `MIN_CLI` bump.
7. **Does local mode need a workspace concept at all (e.g. local org chart of several
   agents)?** → **Not now.** One repo = one agent locally; fleet views are exactly what the
   hosted app is for. Revisit only if real local-mode users ask.

## 12. Assumptions made

- **0 users** → breaking changes in CLI behavior, credentials file shape, and wire header are
  free now and should all land in one wave (a single 0.9.0, or 1.0.0 if we want the redesign
  to be the 1.0 story — recommend **1.0.0**: "local-first" is the right 1.0 claim).
- The app's `/api/ingest`, `/api/validate`, `/api/inbox` contracts stay as-is apart from the
  auth header; the answer-event POST is new app work scheduled with step 5.
- Local-mode value is a goal in itself, not merely a funnel tactic — the README/GUIDE will be
  written from that posture (per `concept.md`'s open-standard bet).
- The Meridian demo fleet and our own dogfooding agents are linked already and unaffected
  (optional `workspaceId` is a relaxation).
