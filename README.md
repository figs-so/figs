# Figs

**Your AI employees do the work. Figs shows you what they did — and tells you when they need you.**

Figs is the open protocol — and the place — for how AI employees report to and hand off work to humans.
Every agent you run (Claude Code, Codex, Cursor) publishes what it owns, what it's done, and what it
needs from a person — into one shared view your whole team can see.

> **The open standard for how AI employees report to humans.** The `.figs` format is that standard (this
> repo). The hosted app at **[app.figs.so](https://app.figs.so)** is where you read it.

[![CLI on npm](https://img.shields.io/npm/v/%40figs-so%2Fcli?label=%40figs-so%2Fcli)](https://www.npmjs.com/package/@figs-so/cli)
&nbsp;·&nbsp; License: **MIT** (this repo — protocol + CLI) &nbsp;·&nbsp; The app: **hosted** (closed source)

---

## Why

You started with one agent. You watched its console. Now you're running five — soon thirty — and you
**can't keep thirty terminals in your head.** You don't actually know what your agents are doing, what
they've shipped, or which one is stuck waiting on you.

Figs treats each agent as what it's becoming: an **employee.** Not a log stream, not a trace — a worker
with a mandate that does its job and *reports back.* You stop reading consoles and codebases to find out
what happened; you read Figs. And when an agent hits something only a human can decide, it doesn't fail
silently — it **hands off** to you.

We don't reinvent the agent. Your agent is already Claude Code / Codex / Cursor, and it's only getting
better. Figs is the human-facing layer on top: the one place a whole team can see the fleet.

## Quickstart (30 seconds, no signup)

Run this from your agent's repo (or have the agent run it) — **no account needed:**

```bash
npx @figs-so/cli@latest init        # scaffold .figs/ here — purely local, mints a stable agent id
# fill in .figs/agent.json — its name, mandate, what it owns (figs doctor checks it)
```

That's the whole setup. Your agent now has, on plain local files: an identity, a **crash-recoverable
work journal** (`figs checkpoint` / `figs report` under stable job ids — the next session picks up what
the last one left in flight), structured handoffs (`figs ask` → `figs answer` → `figs close`), and
offline validation (`figs doctor`). It works with zero account, forever.

**See it with your team — when you want to:**

```bash
npx @figs-so/cli@latest login       # one-time browser approve (the agent never sees a token)
npx @figs-so/cli@latest link        # connect this .figs/ to a workspace
npx @figs-so/cli@latest push        # publish → your fleet shows up at app.figs.so
```

Linking loses nothing — `push` publishes everything recorded since day one.

## How it works

- **Local-first, account-optional.** Your agent writes a small **`.figs/`** folder and works entirely
  offline. Linking to the hosted app is a separate, optional step; a reader is a **mirror for humans**,
  never an authority over your files.
- **Agent ledgers up, replies down.** The agent's runs/asks publish one-way *up*; a human's replies
  (answers/verdicts) come *back* through one file (`messages.jsonl`) — the agent acts on them and closes
  the ask, citing the reply.
- **Two content modes, no display language:** *structured state* (the charter + runs/asks/replies) and
  *attachments* (files shown inline or offered for download). No DSL to learn.
- **Identity is the agent's own.** It generates a UUID once; that UUID *is* its identity. Many people can
  run the same agent (it's a repo) and their pushes aggregate.
- **You read it on Figs.** The hosted app turns pushes into an org chart of your AI employees, a glance
  view per agent, and a **needs-you inbox** — the handoffs flagged for a human, multiplayer across the team.

The full `.figs` contract is specified in **[`SPEC.md`](./SPEC.md)** (`figs-spec v2`). Anyone can
implement it — that's the point of an open protocol.

### The local-first contract

**The CLI is a complete product with zero account.** `figs init` alone gives an agent identity, a
crash-recoverable work journal, structured asks + the answer/close loop, and offline validation — all
in plain files on this machine. Linking adds the hosted layer: publishing, the org chart, and
**verified, multiplayer** replies (your whole team, attributed). **Linked is better, never required.**

### The CLI

`@figs-so/cli` (command `figs`) is zero-dependency, Node ≥ 18, and built to be run *by the agent*:
non-interactive, `--json` on read commands, and errors that say what to do next.

**Invoke it with `npx @figs-so/cli@latest <cmd>`** — no install needed; the `figs <cmd>` forms below
are shorthand for exactly that (always current, no version drift). Prefer a real local command?
`npm i -g @figs-so/cli`, then `figs <cmd>` directly.

**Local (no account needed):**

| Command | What |
|---|---|
| **`figs init`** | scaffold `.figs/` here — purely local, mints a stable agent id; zero flags, never touches the network |
| **`figs checkpoint --id <job> --note '…'`** | save a job's progress mid-flight — the **first checkpoint opens the job** (`state: in-flight`), so a crash leaves a recoverable stub the next session finds in the inbox |
| **`figs report --result '…'`** | settle a job — **one job, one stable `--id`** (re-reporting folds onto its row); `--attach` files; auto-pushes when linked |
| **`figs ask <type> --title '…'`** | raise a self-contained ask (`question` · `sign-off`) — options/details/attachments |
| **`figs answer <ask-id> --by '…'`** | record your human's out-of-band reply, verbatim (you run this, not them) — `--chosen`/`--text`, or `--approve`/`--request-changes`/`--reject` |
| **`figs inbox [<ask-id>]`** | start every session here — open asks + their replies + your unfinished jobs, each with the next command (`<ask-id>` → `figs show`) |
| **`figs show <id>`** | magnify one ask (its reply thread) or job (its checkpoint trail) + attachments |
| **`figs close <ask-id>`** | close an ask — derives the outcome from the reply on file and cites it; `--run <job>` links the work, `--withdrawn` for the un-ask |
| `figs doctor` | validate `.figs/` against the spec — runs **account-free** |
| `figs status [--json]` · `figs version` · `figs help [<cmd>]` | local/linked + agent state · version · usage |

**Connected (one-time login + a workspace):**

| Command | What |
|---|---|
| `figs login` / `logout` | device-flow browser approve / remove the local token (per endpoint) |
| `figs link [--workspace <slug\|uuid>]` | connect `.figs/` to a workspace so `figs push` can publish |
| `figs push` | publish the spine + attachments + replies; the writing verbs call it automatically when linked |

Exit codes: `0` recorded · `1` nothing written (fix the input) · `2` recorded locally, publish failed
(run `figs push`, never re-run the verb). Override the endpoint with `FIGS_ENDPOINT`.

## What Figs is — and is NOT

**Is:** the human-facing reporting + handoff layer for your fleet. The neutral, multiplayer place
that makes a fleet of agents *legible* to a whole team.

**Is NOT:**
- ❌ **An agent / framework / orchestrator** — we wrap the dominant ones; we don't compete with them.
- ❌ **Observability / a trace viewer** — the frame is an *employee reporting to humans*, not telemetry
  for engineers.
- ❌ **A control plane / orchestrator** — the loop is report + hand off + *answer back* (the human's
  reply flows to the agent, which acts and closes the ask). Figs carries the decision; it doesn't drive
  the agent's execution.

> **Honest status:** Figs is **early** and in active dogfooding. Today's value is *visibility/legibility*
> at fleet scale — not a tamper-proof audit trail (agent state is self-reported). We're building in the
> open; expect rough edges and tell us where it breaks.

## Run it

- **Hosted:** [app.figs.so](https://app.figs.so) — sign in, create a workspace, push. The app is a hosted
  product; the CLI + protocol in this repo are MIT and run anywhere.

## Licensing

- **This repo — the `.figs` protocol + the CLI: [MIT](./LICENSE).** Use it, embed it, build on it, emit
  `.figs` from anything. Zero friction is the point.
- **The hosted app at [app.figs.so](https://app.figs.so) is a commercial product** (closed source). Your
  data isn't locked in, though — it's `.figs`, an open format you can read or export anytime.

## The Figs ecosystem

Figs is one stack in three pieces — **build → report → govern**. Land on any repo; here's the whole picture:

| Layer | Repo | License | Role |
|---|---|---|---|
| 🏗️ Build | **[OpenFigs](https://github.com/figs-so/openfigs)** | MIT | build trustworthy back-office AI employees — conventions + skeleton, runtime-agnostic |
| 📤 Report | **[`.figs` + CLI](https://github.com/figs-so/figs)** | MIT | the open standard an agent reports its state in — **← you're here** |
| 👁️ Govern | **[Figs app](https://app.figs.so)** | hosted | the org chart + handoff inbox humans read |

## Links

- 🌐 Landing: **[figs.so](https://figs.so)**
- 🖥️ App: **[app.figs.so](https://app.figs.so)**
- 📦 CLI: **[@figs-so/cli](https://www.npmjs.com/package/@figs-so/cli)**
- 📄 Protocol: **[`SPEC.md`](./SPEC.md)**
