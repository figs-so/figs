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
| `git push` | `figs push` | the only verb that *requires* the remote |
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
| `report` / `checkpoint` / `ask` / `resolve` | write then **exit 1** | write, exit 0, no push attempt | write + push; failure exit 1 |
| `inbox` | **dies** | local derivation: in-flight jobs + open asks (+ local answers, §5) | + thread events merged from the server |
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

## 5. Inbox — local-first redesign (the careful one)

`figs inbox` is the session-start ritual: **"what needs me?"** It has three sources; today all
three are conflated into one server call. Split them:

1. **Unfinished jobs** (in-flight runs) — *pure local data.* Derive from folded `runs.jsonl`
   (`state: "in-flight"`). Works offline forever. When linked, the server merge can *add*
   cross-machine in-flight jobs from other runners — additive, never required.
2. **Own open asks** — *pure local data.* Folded `asks.jsonl`, `status: "open"`. In local mode
   this is the "waiting on your human" list — still useful: the agent re-surfaces what it's
   blocked on so the human can answer in chat.
3. **Human events** (answers/verdicts) — the answer channel. Today server-only. This is where
   local needs a real design:

### The local answer channel — `figs answer` + `answers.jsonl`

The loop already closes locally *informally*: human answers in chat, agent runs
`figs resolve --chosen … --by …` (`via: "human"`, self-reported). What's missing is the
**asynchronous, structured** form — human answers while the agent is dead; next session finds it.

**Design:**

- **New file `.figs/answers.jsonl`** — the *local human ledger*. Append-only events:
  `{ "id": "evt-…", "ask": "<ask-id>", "kind": "answer" | "verdict", "by": "<who>", "ts": "…", "chosen"?: "<option verbatim>", "text"?: "…", "verdict"?: "approved" | "changes-requested" | "rejected" }`
  — the **same event shape SPEC.md already reserves** for server-side answer-down. One shape,
  two homes. Keeps the spec's two-ledger split intact: agents write `asks.jsonl`, humans write
  `answers.jsonl`, the ledgers cross-reference by ask id. Nobody writes into the other's file.
- **New verb `figs answer <ask-id>`** — the only *human-run* verb (help marks it so):
  `--chosen '<option verbatim>'` (checked, like resolve) · `--text '…'` ·
  `--approve | --request-changes | --reject` for sign-offs · `--by` (defaults to `$USER`).
  - **Local mode:** appends to `answers.jsonl`.
  - **Linked mode:** posts a real answer event to the API using the machine token — auth *is*
    the user, so the terminal-human answering is exactly who the token attributes. Same verb,
    same muscle memory, better grade of record.
- **`figs inbox`** merges: local files always; server events when linked. `figs resolve` cites
  the event id it acted on in both cases (`via: "figs"` mechanism-attribution already works
  this way — extend the soft fetch to also read `answers.jsonl`).
- **Honesty grade, stated plainly in docs:** local answers are filesystem-trust (anyone with
  the repo could write them) — the same self-reported grade as everything local. Linked
  answers are authenticated and permission-gated. *That delta is the product's pitch for
  linking, articulated instead of enforced by crippling local.*

**Spec impact:** additive. SPEC.md §2's rule "readers must ignore files this spec doesn't
name" means `answers.jsonl` can ship as a CLI convention immediately and be spec'd as §6.3 in
the same v1 (new optional file + the event shape, lifted verbatim from Reserved). `push` does
**not** publish `answers.jsonl` (the server has its own human ledger; local answers are
local). Inbox display treats both ledgers as one thread.

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
- §6.3 *(new)*: `answers.jsonl` — the local human ledger; event shape lifted from Reserved
  (answer/verdict). Never pushed. Readers ignore it (it's agent-side input, not published state).
- §8: wire auth = `Authorization: Bearer`.
- §9: local validation is normative for conformance; server validation is optional.

All additive/relaxing → stays `figs-spec v1`.

---

## 10. Rollout order

1. **The state model** — optional `workspaceId`, `requireFigs` relaxation, `init`/`link`
   split, state-aware push + exit codes. *(This alone makes the headline claim true.)*
2. **`doctor` offline** + unified `--json`.
3. **`inbox` local derivation** (jobs + open asks from disk; server merge when linked).
4. **Auth**: Bearer header, per-endpoint credentials (+ app dual-accept).
5. **The answer channel**: `figs answer` + `answers.jsonl` + SPEC §6.3.
6. **Docs flip**: README quickstart, GUIDE, llms.txt, help regrouping, exit-code docs.
7. **Cross-repo follow-ups**: `create-openfigs` outro → `figs init` first, login later ·
   `openfigs` template GUIDE wording · app: Bearer dual-accept, `figs_` token prefix,
   llms.txt update, eventually answer-event POST endpoint for linked `figs answer`.

Every step updates the **no-account audit** in `CLAUDE.md` (the release gate).

---

## 11. Open questions (with recommendations)

1. **`link` vs `connect` vs `remote` naming.** → **`link`** (Vercel/Supabase/Railway
   precedent; agents have seen it; "remote" overloads git vocabulary without being git).
2. **Ship the answer channel now or keep it reserved?** → **Ship in this redesign** (step 5).
   We're at 0 users; it completes the local story, the event shape is already locked in
   Reserved, and it's the difference between "local works" and "local is whole". Risk is spec
   surface — mitigated by it being an unpushed, ignorable file.
3. **Local mode: commit the outbox or keep it gitignored?** In linked mode the outbox is
   transient (remote is durable); in local mode the files ARE the record, surviving only on
   that machine. → **Keep gitignored by default** (privacy-safe: runs/asks can carry sensitive
   scope; committing should be a deliberate human act). Document the trade-off in the
   scaffolded `.gitignore` comment so the choice is visible.
4. **Should linked `figs answer` post to the API or refuse ("answer in the app")?** → **Post
   via the API.** Same verb everywhere; the token attributes the human correctly; refusing
   would make the CLI worse when connected, violating "remote better".
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
