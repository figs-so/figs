# CLAUDE.md — figs (the `.figs` protocol + CLI)

This repo is the **open, MIT-licensed heart of Figs**: `SPEC.md` (the `.figs` protocol) and
`figs.mjs` (the reference CLI, one zero-dependency Node file). The hosted app
(app.figs.so) is a separate, closed repo. Tests: `node --test`. Releasing: see
`CONTRIBUTING.md`. Local dev against the app: `FIGS_ENDPOINT=http://localhost:3000 node figs.mjs <cmd>`.

## The local-first contract (NEVER break this)

The CLI must be a complete product **with zero account and zero network**. The hosted app makes
it *better* (verified answers, multiplayer, org chart) — never *possible*. Every change to
`figs.mjs` or `SPEC.md` is audited against these rules:

1. **Every verb except `login`/`logout`/`workspaces`/`link`/`push`/`pull` (and `inbox`'s
   soft pull when linked) must complete offline, with no account, exit 0.** The data plane is
   push/pull only; local data never requires a server round-trip (e.g. in-flight jobs live in
   `runs.jsonl` — derive them there).
2. **A missing token or workspace is a *state*, not an error.** Error only when the repo's
   *declared intent* can't be met: `config.json` without `workspaceId` = deliberate local
   mode (calm note, exit 0); with `workspaceId` = the repo intends to publish (a failed push
   is a real exit-1 error).
3. **No teaching-error chain may terminate at "create an account"** for a local-mode user.
   Every error's suggested next command must itself work without an account, or the message
   must show both paths.
4. **`figs doctor` is the spec's conformance validator — it must run account-free.** Server
   validation is an additive second opinion, never the gate.
5. **Files are the protocol; verbs are sugar.** Hand-authoring `.figs/` stays first-class;
   anything a verb writes must be writable by hand and validate identically.
6. **No network on the hot path of a local verb.** Version checks and remote merges live on
   connected verbs only, and degrade silently.

**Release gate — the no-account audit:** before each release, run every verb in a fresh dir
with no `~/.figs/credentials.json`, no `FIGS_TOKEN`, and network off. Each must match the
state-model table in `REDESIGN.md` §3 (after the redesign ships: in `README.md`). A verb that
exits non-zero in local mode without an unmeetable declared intent is a release blocker.

## Known gaps (delete each line as it's fixed — full design in `REDESIGN.md`)

- [ ] `figs init` requires an account (no local-mode init; `workspaceId` mandatory everywhere).
- [ ] `figs doctor` dies "not logged in" after local checks pass.
- [ ] Writing verbs exit 1 when not logged in (no local-mode exit-0 path without `--no-push`).
- [ ] Error chains end at "create an account"; README/onramps lead with `login`.
- [ ] `figs inbox` is fully remote — even in-flight jobs (local data) are fetched from the server; no local answer channel.
- [ ] Auth: custom `x-figs-token` header (→ `Authorization: Bearer`); single endpoint-blind token in `~/.figs/credentials.json` (→ keyed by endpoint origin).

## Working rules

- **Zero dependencies, one file, small verb surface** — enrich existing verbs before adding
  new ones (see `CONTRIBUTING.md`).
- **SPEC.md is canonical and versioned** — additive/optional keeps v1; breaking bumps the
  integer and `MIN_CLI` in the app.
- **Errors teach**: every `die()` says what to do next (and obeys contract rule 3).
- Agents are the primary users: non-interactive, `--json` on reads, stdout = data,
  stderr = warnings, deterministic output.
- `CLAUDE.md` is canonical; `AGENTS.md` is a symlink to it — never edit the symlink.
