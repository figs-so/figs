# CLAUDE.md — figs (the `.figs` protocol + CLI)

This repo is the **open, MIT-licensed heart of Figs**: `SPEC.md` (the `.figs` protocol) and
`figs.mjs` (the reference CLI, one zero-dependency Node file). The hosted app
(app.figs.so) is a separate, closed repo. Tests: `node --test`. Releasing: see
`CONTRIBUTING.md`. Local dev against the app: `FIGS_ENDPOINT=http://localhost:3000 node figs.mjs <cmd>`.

## The local-first contract (NEVER break this)

The CLI must be a complete product **with zero account and zero network**. The hosted app makes
it *better* (verified answers, multiplayer, org chart) — never *possible*. Every change to
`figs.mjs` or `SPEC.md` is audited against these rules:

1. **Every verb except `login`/`logout`/`link`/`push` must complete offline, with no
   account, exit 0.** The only network touch elsewhere is `inbox`'s soft, messages-only
   down-sync when linked — loud on failure or truncation, never silent. `show` is a pure
   local read (no artifact download; a missing reference points to the app). Local data
   never requires a server round-trip (in-flight jobs live in `runs.jsonl` — derive them
   there).
2. **A missing token or workspace is a *state*, not an error — and exit codes carry exactly
   three meanings:** `0` recorded (and published if linked) · `1` nothing was written (fix
   the input) · `2` recorded locally, publish failed (`figs push` retries — **never re-run
   the verb**; every exit-2 path prints the canonical stderr line saying so). Local mode
   writes exit 0; linked writes that can't publish exit 2; bare `push` exits 1 on structural
   errors, 2 on network.
3. **No teaching-error chain may terminate at "create an account"** for a local-mode user.
   Every error's suggested next command must itself work without an account, or the message
   must show both paths.
4. **`figs doctor` is the spec's conformance validator — it must run account-free.** Server
   validation is an additive second opinion, never the gate.
5. **Files are the protocol; verbs are sugar.** Hand-authoring `.figs/` stays first-class;
   anything a verb writes must be writable by hand and validate identically.
6. **No network on the hot path of a local verb.** Version checks and remote merges live on
   connected verbs only, and degrade silently.
7. **No flag may ever accept a message id or the agent UUID.** Two id classes: *names*
   (job/ask/unit ids — agent-authored, meaningful) and *record-level plumbing* (message ids,
   the agent UUID — machine-minted, machine-cited). Plumbing never crosses an agent's
   keyboard; enforcement is absence of surface. *The one named exception:*
   `link --workspace <uuid>` — the workspace id is connection configuration, set once by the
   connector verb. Creatable name-ids announce new-vs-fold on every write; reference ids are
   checked against the journal (closes die, links warn).
8. **The topology rule: one agent = one repo = one machine.** Agent ledgers (runs/asks) sync
   UP only — never down; `messages.jsonl` (human messages) is the sole two-way file
   (immutable, dedupe by id). Never add a feature that shows another machine's in-flight work
   in a local inbox.

**Release gate — the no-account audit:** before each release, run every verb in a fresh dir
with no `~/.figs/credentials.json`, no `FIGS_TOKEN`, and network off. Each must match the
state-model table in `REDESIGN.md` §3 (after the redesign ships: in `README.md`). A verb that
exits non-zero in local mode without an unmeetable declared intent is a release blocker.

## Known gaps (delete each line as it's fixed — full design in `REDESIGN.md`)

**CLI dev is functionally complete on `redesign/v1` (106 tests green).** Done + committed:
steps 1, 2 (`--json` envelope), 3 (core + attachments + **the linked down-sync**, reviewed
against the app's shipped `GET /api/messages` contract), 4 (auth), help-regroup, **SPEC v2**,
**README flip**. The whole loop — local AND linked — works end to end. Remaining is docs + ship:

- [ ] **`GUIDE.md` deep rewrite + `llms.txt`** (deferred to the end by Wayne) — the long agent guide still describes the old model. (`llms.txt` is app-served — app thread.)
- [ ] **Ship**: cross-repo onramps (`create-openfigs` → `figs init` first; `openfigs` template GUIDE), HQ `docs/architecture.md`, bump `package.json` to 1.0.0, merge `redesign/v1`, publish (needs Wayne's OK — outward).

## Working rules

- **Zero dependencies, one file, small verb surface** — enrich existing verbs before adding
  new ones (see `CONTRIBUTING.md`).
- **SPEC.md is canonical and versioned** — additive/optional keeps v1; breaking bumps the
  integer and `MIN_CLI` in the app.
- **Errors teach**: every `die()` says what to do next (and obeys contract rule 3).
- Agents are the primary users: non-interactive, `--json` on reads, stdout = data,
  stderr = warnings, deterministic output.
- `CLAUDE.md` is canonical; `AGENTS.md` is a symlink to it — never edit the symlink.
