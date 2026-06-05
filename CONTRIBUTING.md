# Contributing to Figs

Thanks for your interest. This repo is the open **`.figs` protocol** (`SPEC.md`) and the **`figs` CLI** —
how AI agents report their state to humans. It's **MIT-licensed**. (The hosted app lives separately at
[figs-so/app](https://github.com/figs-so/app), AGPL-3.0.)

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
- Keep `SPEC.md` minimal and explicitly versioned.
- Match the surrounding style; be kind in reviews and issues.

## License

By contributing, you agree that your contributions are licensed under the **MIT License**.
