# Figs

**Your AI employees do the work. Figs shows you what they did — and tells you when they need you.**

Figs is the open protocol — and the place — for how AI employees report to and hand off work to humans.
Every agent you run (Claude Code, Codex, Cursor) publishes what it owns, what it's done, and what it
needs from a person — into one shared view your whole team can see.

> **Git, but for your AI workforce.** The `.figs` format is an open standard (this repo). The hosted app
> at **[app.figs.so](https://app.figs.so)** is the easiest place to read it; you can also self-host.

[![CLI on npm](https://img.shields.io/npm/v/%40figs-so%2Fcli?label=%40figs-so%2Fcli)](https://www.npmjs.com/package/@figs-so/cli)
&nbsp;·&nbsp; License: **MIT** (this repo — protocol + CLI) &nbsp;·&nbsp; The app: **AGPL-3.0**

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
better. Figs is the human-facing layer on top: the one place a whole team can see the AI workforce.

## Quickstart (60 seconds)

Run these from your agent's repo (or have the agent run them):

```bash
npx @figs-so/cli@latest login                    # approve in your browser (the agent never sees a token)
npx @figs-so/cli@latest workspaces               # find your workspace slug
npx @figs-so/cli@latest init --workspace <slug>  # creates .figs/ with the agent's identity
# describe the agent in .figs/agent.json — its name, mandate, what it owns
npx @figs-so/cli@latest push                     # publish → it appears in your org chart
```

That's it — your agent now shows up at **[app.figs.so](https://app.figs.so)**. No instrumentation, no
SDK in your agent's code. From there you decide, deliberately, how much of its real work to surface.

## How it works

- **Local-first, one-way.** Your agent writes a small **`.figs/`** folder and runs `figs push`. Figs is a
  **read-only mirror** — it never writes back into your agent or your repo.
- **Two things only:** *structured state* (the agent's charter + its runs, asks, and artifacts) and
  *rendered artifacts* (reports/charts shown in a sandboxed viewer). No display DSL to learn.
- **Identity is the agent's own.** An agent generates a UUID once; that UUID *is* its identity. Many people
  can run the same agent (it's a repo) and their pushes aggregate.
- **You read it on Figs.** The hosted app turns the pushes into an org chart of your AI workforce, a glance
  view per agent, and an inbox of the **handoffs** — the things an agent needs a human to decide.

The full `.figs` contract is specified in **[`SPEC.md`](./SPEC.md)** (`figs-spec v1`). Anyone can implement
it — that's the point of an open protocol.

### The CLI

`@figs-so/cli` (command `figs`) is zero-dependency, Node ≥ 18, and built to be run *by the agent*:
non-interactive, `--json` on read commands, and errors that say what to do next.

| Command | What |
|---|---|
| `figs login` / `logout` | device-flow browser approve / remove local token |
| `figs workspaces [--json]` | list your workspaces (create one in the web app) |
| `figs init --workspace <slug>` | generate identity + write `.figs/` |
| `figs doctor` | validate `.figs/` against the contract before pushing |
| `figs push` | one-way publish of `.figs/` |
| `figs status [--json]` | login / workspace / agent state |
| `figs help [<command>]` | usage (`-h`/`--help` on any command; `-v` for version) |

Override the endpoint for local dev with `FIGS_ENDPOINT` (e.g. `http://localhost:3000`).

## What Figs is — and is NOT

**Is:** the human-facing reporting + handoff layer for your AI workforce. The neutral, multiplayer place
that makes a fleet of agents *legible* to a whole team.

**Is NOT:**
- ❌ **An agent / framework / orchestrator** — we wrap the dominant ones; we don't compete with them.
- ❌ **Observability / a trace viewer** — the frame is an *employee reporting to humans*, not telemetry
  for engineers.
- ❌ **A control plane (yet)** — today it's one-way (report + hand off). Two-way (answer-down, sign-off) is
  on the roadmap. To act on a handoff today, you still go to the agent's own console.

> **Honest status:** Figs is **early** and in active dogfooding. Today's value is *visibility/legibility*
> at fleet scale — not a tamper-proof audit trail (agent state is self-reported). We're building in the
> open; expect rough edges and tell us where it breaks.

## Run it your way

- **Hosted (easiest):** [app.figs.so](https://app.figs.so) — sign in, create a workspace, push.
- **Self-host:** the app is open source (AGPL-3.0) at **[figs-so/app](https://github.com/figs-so/app)** —
  bring your own Postgres + storage. See its README for setup.

## Licensing

- **This repo — the `.figs` protocol + the CLI: [MIT](./LICENSE).** Use it, embed it, build on it, emit
  `.figs` from anything. Zero friction is the point.
- **The hosted app: AGPL-3.0** ([figs-so/app](https://github.com/figs-so/app)). Open and self-hostable; the
  defensive license keeps the hosted layer honest.

## Links

- 🌐 Landing: **[figs.so](https://figs.so)**
- 🖥️ App: **[app.figs.so](https://app.figs.so)**
- 📦 CLI: **[@figs-so/cli](https://www.npmjs.com/package/@figs-so/cli)**
- 📄 Protocol: **[`SPEC.md`](./SPEC.md)**
