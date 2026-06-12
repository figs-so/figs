# Contributing to Figs

Thanks for your interest. This repo is the open **`.figs` protocol** (`SPEC.md`) and the **`figs` CLI** —
how AI agents report their state to humans. It's **MIT-licensed**. (The hosted app at
[app.figs.so](https://app.figs.so) is a separate, closed-source commercial product.)

Figs is early and built in the open — issues, ideas, and PRs are welcome.

## Ways to contribute

- **Report a bug or propose an idea** — open an issue.
- **The spec (`SPEC.md`, `figs-spec v1`)** — the `.figs` format is versioned. Please open an issue to
  discuss *before* a PR. Additive/optional fields keep the version number; a breaking change needs a major
  bump and a strong rationale. We keep the spec deliberately **minimal** — new surface needs to earn its place.
- **The CLI (`figs.mjs`)** — a single, **zero-dependency** Node file (Node ≥ 18).

## Running the CLI locally

```bash
node figs.mjs help
FIGS_ENDPOINT=http://localhost:3000 node figs.mjs <command>   # point at a local app
```

The baked default endpoint is `https://app.figs.so`.

## Guidelines

- Keep the CLI **zero-dependency** and the command surface **small** — we enrich the existing verbs rather
  than adding new ones.
- **Local-first is a contract, not a preference** — every verb except `login`/`logout`/`link`/`push`
  must work offline with no account (the full contract lives in `CLAUDE.md`; releases are gated on
  the no-account audit).
- **No flag may ever accept an event id or the agent UUID.** Job/ask/unit ids are *names* —
  agent-authored and meaningful. Event ids and the agent UUID are *record-level plumbing* —
  machine-minted and machine-cited; no command exposes an input for them, and PRs must not add
  one. (The one named exception: `link --workspace <uuid>` — connection configuration, not
  record plumbing.)
- Keep `SPEC.md` minimal and explicitly versioned.
- Match the surrounding style; be kind in reviews and issues.

## Releasing (`@figs-so/cli`)

Publishing is automated by `.github/workflows/publish.yml` — maintainers don't run `npm publish` by hand.

1. Bump `"version"` in **`package.json`** (the single source of truth — `figs.mjs` reads it at runtime).
   Use semver: additive = patch/minor, breaking `.figs` contract = major.
2. Commit, then tag and push: `git tag vX.Y.Z && git push --tags` (the tag must match `package.json`).
3. Publish a **GitHub Release** for that tag → the workflow verifies tag == version and runs `npm publish`.
4. On a breaking contract change, also bump `MIN_CLI` in the app's `/api/version` route
   ([figs-so/app](https://github.com/figs-so/app)); bump `LATEST_CLI` there each release so the
   "update available" nudge stays current.

Auth is npm **Trusted Publishing** (OIDC) — no token/secret. It's configured once at
npmjs.com → `@figs-so/cli` → Trusted Publisher (GitHub Actions · org `figs-so` · repo `figs` · workflow
`publish.yml`). Provenance is attached automatically.

## License

By contributing, you agree that your contributions are licensed under the **MIT License**.
