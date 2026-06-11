/**
 * CLI contract tests — drive `figs.mjs` as a subprocess (it's a script, not a
 * module) against an in-process mock server. Zero-dependency: node:test.
 *
 * Isolation per test: a fresh HOME (so ~/.figs/credentials.json and the
 * version-check cache never leak between tests or from the real machine) and a
 * fresh cwd for anything that touches .figs/. FIGS_ENDPOINT points at the mock;
 * FIGS_TOKEN stands in for a login.
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = join(dirname(fileURLToPath(import.meta.url)), "figs.mjs")
const VERSION = JSON.parse(
  readFileSync(join(dirname(CLI), "package.json"), "utf8"),
).version

// ---------- mock server -------------------------------------------------
// Mutable per-test state; tests set what /api/workspaces returns and read
// back what /api/ingest received.
const mock = {
  workspaces: [],
  versionMin: "0.0.1",
  lastIngest: null,
  uploads: [],
  /** GET /api/inbox response — tests set asks; reset to empty per test. */
  inbox: { ok: true, truncated: false, asks: [] },
  /** name → { content, hash } served by GET /api/artifacts/raw. */
  rawArtifacts: new Map(),
}
let server, base

before(async () => {
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" })
        res.end(JSON.stringify(obj))
      }
      if (req.url === "/api/version") {
        return send(200, { cli: { min: mock.versionMin } })
      }
      if (req.url === "/api/workspaces") {
        return send(200, { workspaces: mock.workspaces })
      }
      if (req.url === "/api/ingest") {
        mock.lastIngest = {
          token: req.headers["x-figs-token"],
          body: JSON.parse(body),
        }
        return send(200, { ok: true })
      }
      if (req.url === "/api/artifacts/upload") {
        mock.uploads.push(JSON.parse(body))
        return send(200, { ok: true })
      }
      if (req.url.startsWith("/api/inbox")) {
        return send(200, mock.inbox)
      }
      if (req.url.startsWith("/api/artifacts/raw")) {
        const name = new URL(req.url, "http://x").searchParams.get("name")
        const art = mock.rawArtifacts.get(name)
        if (!art) return send(404, { error: "not found" })
        res.writeHead(200, {
          "content-type": "text/html",
          "x-figs-sha256": art.hash,
        })
        return res.end(art.content)
      }
      send(404, { error: `no mock for ${req.url}` })
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

// ---------- harness ------------------------------------------------------
// Async on purpose: the mock server lives in THIS process, so the runner must
// not block the event loop while the child talks to it (spawnSync would).
function run(args, { cwd, token, env: extra, input } = {}) {
  const home = mkdtempSync(join(tmpdir(), "figs-home-"))
  const env = {
    ...process.env,
    HOME: home,
    FIGS_ENDPOINT: base,
    ...extra,
  }
  delete env.FIGS_TOKEN
  if (token) env.FIGS_TOKEN = token
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd ?? mkdtempSync(join(tmpdir(), "figs-cwd-")),
      env,
    })
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
    let out = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (out += c))
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000)
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(killer)
      rmSync(home, { recursive: true, force: true })
      resolve({ code, out })
    })
  })
}

const newRepo = () => mkdtempSync(join(tmpdir(), "figs-repo-"))
const UUID = "11111111-2222-4333-8444-555555555555"

// ---------- help / version / argument handling ---------------------------

test("help prints usage and exits 0", async () => {
  const r = await run(["help"])
  assert.equal(r.code, 0)
  assert.match(r.out, /Usage: figs <command>/)
})

test("help init documents the auto-select behavior", async () => {
  const r = await run(["help", "init"])
  assert.equal(r.code, 0)
  assert.match(r.out, /uses your only workspace/)
})

test("version matches package.json", async () => {
  const r = await run(["version"])
  assert.equal(r.code, 0)
  assert.ok(r.out.includes(VERSION), `expected ${VERSION} in: ${r.out}`)
})

test("unknown command exits non-zero", async () => {
  const r = await run(["frobnicate"])
  assert.notEqual(r.code, 0)
})

test("unknown flag exits non-zero (no silent no-op)", async () => {
  const r = await run(["logout", "--frobnicate"])
  assert.notEqual(r.code, 0)
})

// ---------- init ----------------------------------------------------------

test("init --workspace <uuid> scaffolds .figs/ without auth", async () => {
  const repo = newRepo()
  const r = await run(["init", "--workspace", UUID], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg.workspaceId, UUID)
  assert.match(cfg.agentId, /^[0-9a-f-]{36}$/)
  for (const f of ["agent.json", "CONTRACT.md", "GUIDE.md", ".gitignore", "runs.jsonl", "asks.jsonl"]) {
    assert.ok(existsSync(join(repo, ".figs", f)), `missing .figs/${f}`)
  }
})

test("re-init keeps the agent identity and never clobbers the charter", async () => {
  const repo = newRepo()
  await run(["init", "--workspace", UUID], { cwd: repo })
  const cfg1 = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  const charter = JSON.stringify({ name: "Authored", mandate: "real content" })
  writeFileSync(join(repo, ".figs/agent.json"), charter)

  const r = await run(["init", "--workspace", UUID], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const cfg2 = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg2.agentId, cfg1.agentId, "re-init must reuse the agentId")
  assert.equal(readFileSync(join(repo, ".figs/agent.json"), "utf8"), charter)
})

test("init with no --workspace auto-selects the only workspace", async () => {
  mock.workspaces = [{ id: UUID, slug: "acme", name: "Acme", role: "owner" }]
  const repo = newRepo()
  const r = await run(["init"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /using workspace acme \(Acme\)/)
  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg.workspaceId, UUID)
})

test("init with several workspaces lists them and exits 1", async () => {
  mock.workspaces = [
    { id: UUID, slug: "acme", name: "Acme", role: "owner" },
    { id: UUID.replace("1111", "9999"), slug: "globex", name: "Globex", role: "member" },
  ]
  const r = await run(["init"], { cwd: newRepo(), token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /which workspace\?/)
  assert.match(r.out, /--workspace acme/)
  assert.match(r.out, /--workspace globex/)
})

test("init with zero workspaces says to create one and exits 1", async () => {
  mock.workspaces = []
  const r = await run(["init"], { cwd: newRepo(), token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /no workspaces yet/)
})

// ---------- doctor (offline checks) ----------------------------------------

test("doctor refuses a charter that still has template placeholders", async () => {
  const repo = newRepo()
  await run(["init", "--workspace", UUID], { cwd: repo })
  const r = await run(["doctor"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /template placeholders/)
})

// ---------- push ------------------------------------------------------------

async function pushableRepo() {
  const repo = newRepo()
  await run(["init", "--workspace", UUID], { cwd: repo })
  writeFileSync(
    join(repo, ".figs/agent.json"),
    JSON.stringify({ name: "TestAgent", mandate: "tests the CLI" }),
  )
  writeFileSync(
    join(repo, ".figs/runs.jsonl"),
    `{"id":"r1","ts":"2026-06-10T00:00:00Z","result":"ok"}\n` +
      `{"id":"r1","ts":"2026-06-10T01:00:00Z","result":"updated"}\n`, // same id → folds to 1
  )
  return repo
}

test("push without a token fails fast", async () => {
  const r = await run(["push"], { cwd: await pushableRepo() })
  assert.equal(r.code, 1)
  assert.match(r.out, /not logged in/)
})

test("push sends the spine to /api/ingest, folded by id", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  const r = await run(["push"], { cwd: repo, token: "tok-123" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /✓ pushed TestAgent — 1 runs, 0 asks/)
  assert.match(r.out, new RegExp(`view at .*/w/${UUID}`))

  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  const { token, body } = mock.lastIngest
  assert.equal(token, "tok-123")
  assert.equal(body.workspaceId, UUID)
  assert.equal(body.agent.id, cfg.agentId, "push must attach the config agentId")
  assert.equal(body.agent.name, "TestAgent")
  assert.equal(body.runs.length, 1, "runs must fold by id")
  assert.equal(body.runs[0].result, "updated", "fold keeps the latest line")
})

test("push passes asks through verbatim — to, withdrawn, structured resolution", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a1","ts":"2026-06-10T00:00:00Z","type":"needs-decision","to":"manager","title":"Pick a path","options":["A","B"]}\n` +
      `{"id":"a1","status":"resolved","resolution":{"chosen":"A","via":"human","by":"Sarah"}}\n` + // folds onto a1
      `{"id":"a2","ts":"2026-06-10T01:00:00Z","type":"needs-decision","to":"builder","title":"Creds expired","status":"withdrawn","resolution":"creds rotated themselves"}\n`,
  )
  const r = await run(["push"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)

  const byId = Object.fromEntries(mock.lastIngest.body.asks.map((a) => [a.id, a]))
  // a1: the closing line folded onto the open ask, fields intact.
  assert.equal(byId.a1.to, "manager")
  assert.equal(byId.a1.status, "resolved")
  assert.deepEqual(byId.a1.options, ["A", "B"])
  assert.deepEqual(byId.a1.resolution, { chosen: "A", via: "human", by: "Sarah" })
  // a2: withdrawn + bare-string resolution pass through untouched (server normalizes).
  assert.equal(byId.a2.to, "builder")
  assert.equal(byId.a2.status, "withdrawn")
  assert.equal(byId.a2.resolution, "creds rotated themselves")
})

test("push hard-fails below the server's CLI floor", async () => {
  mock.versionMin = "999.0.0"
  try {
    const r = await run(["push"], { cwd: await pushableRepo(), token: "t" })
    assert.equal(r.code, 1)
    assert.match(r.out, /below the minimum 999\.0\.0/)
  } finally {
    mock.versionMin = "0.0.1"
  }
})

// ---------- the writing verbs: report / ask / resolve -----------------------

import { realpathSync, mkdirSync } from "node:fs"

const readLines = (repo, name) =>
  readFileSync(join(repo, ".figs", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const lastLine = (repo, name) => readLines(repo, name).at(-1)

test("report writes a stamped run line and pushes it", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  const r = await run(
    ["report", "--result", "88% matched · 31 flagged", "--unit", "acme", "--status", "warn"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /✓ run recorded/)
  const runRec = lastLine(repo, "runs.jsonl")
  assert.match(runRec.id, /^r-/, "id is CLI-generated")
  assert.match(runRec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/)
  assert.equal(runRec.result, "88% matched · 31 flagged")
  assert.equal(runRec.unit, "acme")
  assert.equal(runRec.status, "warn")
  // and the same record reached ingest (auto-push IS push)
  const pushed = mock.lastIngest.body.runs.find((x) => x.id === runRec.id)
  assert.ok(pushed, "run must be in the pushed spine")
})

test("report --id is honored for deliberate stable ids", async () => {
  const repo = await pushableRepo()
  const r = await run(["report", "--result", "ok", "--id", "acme-2026-06", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.equal(lastLine(repo, "runs.jsonl").id, "acme-2026-06")
})

test("report without --result teaches the fix", async () => {
  const repo = await pushableRepo()
  const r = await run(["report"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /needs --result/)
})

test("report --status with a near-miss suggests the valid value", async () => {
  const repo = await pushableRepo()
  const r = await run(["report", "--result", "x", "--status", "OK"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /did you mean "ok"\?/)
  // nothing was written
  assert.equal(readLines(repo, "runs.jsonl").find((x) => x.result === "x"), undefined)
})

test("report --no-push saves locally and skips the network", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  const r = await run(["report", "--result", "local only", "--no-push"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /saved locally \(--no-push\)/)
  assert.equal(mock.lastIngest, null, "no ingest call expected")
})

test("report with a failing push still saves locally and says so", async () => {
  const repo = await pushableRepo()
  const r = await run(["report", "--result", "kept"], { cwd: repo }) // no token → push fails
  assert.equal(r.code, 1)
  assert.match(r.out, /not logged in/)
  assert.match(r.out, /saved locally/)
  assert.equal(lastLine(repo, "runs.jsonl").result, "kept")
})

test("report multi-attach copies files, links artifacts[], uploads each", async () => {
  mock.uploads = []
  const repo = await pushableRepo()
  writeFileSync(join(repo, "a.html"), "<h1>a</h1>")
  writeFileSync(join(repo, "b.md"), "# b")
  const r = await run(
    ["report", "--result", "two files", "--attach", join(repo, "a.html"), "--attach", join(repo, "b.md")],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  const runRec = lastLine(repo, "runs.jsonl")
  assert.deepEqual(runRec.artifacts, ["a.html", "b.md"])
  assert.equal(runRec.artifact, undefined, "plural form only when >1")
  assert.ok(existsSync(join(repo, ".figs/artifacts/a.html")))
  assert.deepEqual(mock.uploads.map((u) => u.name).sort(), ["a.html", "b.md"])
})

test("report single attach uses the singular artifact field", async () => {
  const repo = await pushableRepo()
  writeFileSync(join(repo, "one.html"), "<p>1</p>")
  const r = await run(["report", "--result", "one", "--attach", join(repo, "one.html"), "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  const runRec = lastLine(repo, "runs.jsonl")
  assert.equal(runRec.artifact, "one.html")
  assert.equal(runRec.artifacts, undefined)
})

test("attach refuses to overwrite an artifact with different content (immutable)", async () => {
  const repo = await pushableRepo()
  mkdirSync(join(repo, ".figs/artifacts"), { recursive: true })
  writeFileSync(join(repo, ".figs/artifacts/report.html"), "<p>original</p>")
  writeFileSync(join(repo, "report.html"), "<p>changed</p>")
  const r = await run(["report", "--result", "x", "--attach", join(repo, "report.html")], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /immutable/)
  assert.match(r.out, /report-v2\.html/)
  assert.equal(
    readFileSync(join(repo, ".figs/artifacts/report.html"), "utf8"),
    "<p>original</p>",
    "original bytes untouched",
  )
})

test("ask raises a self-contained ask linked to its run by explicit id", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  writeFileSync(join(repo, "previews.html"), "<p>emails</p>")
  await run(["report", "--result", "drafted", "--id", "recon-1", "--no-push"], { cwd: repo, token: "t" })
  // "last" is deliberately unsupported — concurrent sessions report in parallel.
  const guessy = await run(["ask", "fyi", "--title", "x", "--run", "last"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(guessy.code, 1)
  assert.match(guessy.out, /explicit run id/)
  const r = await run(
    [
      "ask", "sign-off",
      "--title", "Send 10 payment reminders",
      "--need", "Approve sending exactly these emails",
      "--option", "Send all 10", "--option", "Hold the two large ones",
      "--detail", "Total overdue=$4,820",
      "--attach", join(repo, "previews.html"),
      "--to", "manager",
      "--run", "recon-1",
    ],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  const ask = lastLine(repo, "asks.jsonl")
  assert.match(ask.id, /^ask-/)
  assert.equal(ask.type, "sign-off")
  assert.equal(ask.status, "open")
  assert.equal(ask.run, "recon-1")
  assert.deepEqual(ask.options, ["Send all 10", "Hold the two large ones"])
  assert.deepEqual(ask.details, [{ l: "Total overdue", v: "$4,820" }])
  assert.deepEqual(ask.refs, [{ label: "previews.html", artifact: "previews.html" }])
  assert.ok(mock.lastIngest.body.asks.find((a) => a.id === ask.id), "ask reached ingest")
  assert.doesNotMatch(r.out, /sign-off reviews best with attachments/, "no tip when attached")
})

test("ask sign-off without attachments prints the execution-brief tip", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "sign-off", "--title", "Approve thing", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /exact content to approve/, "tip expected")
})

test("ask with a bogus type suggests the valid one", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "signoff", "--title", "x"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /did you mean "sign-off"\?/)
})

test("ask without a title teaches the fix", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "fyi"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /needs --title/)
})

test("ask --stdin takes a JSON object; flags still stamp and validate", async () => {
  const repo = await pushableRepo()
  const body = {
    type: "needs-decision",
    title: "No bridge rule for prefixed invoice numbers",
    found: "~180 rows can't be matched safely; a long explanation lives here.",
    need: "Confirm the bridge rule.",
    options: ["Strip the alpha prefix", "Treat as out-of-scope"],
  }
  const r = await run(["ask", "--stdin", "--no-push"], {
    cwd: repo,
    token: "t",
    input: JSON.stringify(body),
  })
  assert.equal(r.code, 0, r.out)
  const ask = lastLine(repo, "asks.jsonl")
  assert.equal(ask.type, "needs-decision")
  assert.equal(ask.found, body.found)
  assert.ok(ask.id && ask.ts, "CLI stamps id + ts onto stdin asks")
})

test("resolve enforces verbatim --chosen with a did-you-mean", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-bridge","ts":"2026-06-10T00:00:00Z","type":"needs-decision","title":"Bridge rule","options":["Strip the alpha prefix","Treat as out-of-scope"]}\n`,
  )
  const bad = await run(["resolve", "a-bridge", "--chosen", "strip the alpha prefix"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(bad.code, 1)
  assert.match(bad.out, /did you mean "Strip the alpha prefix"\?/)

  const good = await run(
    ["resolve", "a-bridge", "--chosen", "Strip the alpha prefix", "--by", "Sarah", "--no-push"],
    { cwd: repo, token: "t" },
  )
  assert.equal(good.code, 0, good.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "resolved")
  assert.deepEqual(fold.resolution, { chosen: "Strip the alpha prefix", by: "Sarah", via: "human" })
})

test("resolve --withdrawn excludes --chosen and writes a withdrawn fold", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-old","ts":"2026-06-10T00:00:00Z","type":"needs-decision","title":"Stuck"}\n`,
  )
  const conflict = await run(["resolve", "a-old", "--withdrawn", "--chosen", "x"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(conflict.code, 1)
  assert.match(conflict.out, /can't combine with --withdrawn/)

  const r = await run(["resolve", "a-old", "--withdrawn", "--note", "no longer needed", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "withdrawn")
  assert.equal(fold.resolution.via, undefined, "withdrawn never claims a via")
})

test("resolve warns (but writes) when the ask isn't local", async () => {
  const repo = await pushableRepo()
  const r = await run(["resolve", "ghost-ask", "--note", "done", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /isn't in the local asks\.jsonl/)
  assert.equal(lastLine(repo, "asks.jsonl").id, "ghost-ask")
})

test("report doesn't close asks — a close is not a job (resolve is the one closing verb)", async () => {
  const repo = await pushableRepo()
  const r = await run(
    ["report", "--result", "sent 10/10", "--resolves", "send-ok"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown flag "--resolves"/)
})

test("push refuses a malformed hand-written line with a teaching error", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"bad1","ts":"2026-06-10T00:00:00Z","type":"signoff","title":"Typo type"}\n`,
  )
  const r = await run(["push"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /did you mean "sign-off"\?/)
})

test("report never stamps an inferred session block (a trace must be true or absent)", async () => {
  // Auto-capture was removed in 0.5.0: inferring the session from "the newest
  // transcript on this machine" stamped the WRONG runtime/model in nested and
  // headless runs — a fabricated audit line. Even with a perfectly matching
  // transcript on disk, `report` must not invent a trace.
  mock.lastIngest = null
  const repo = await pushableRepo()
  // a fake HOME holding a transcript for exactly this cwd — the old capture's happy path
  const home = mkdtempSync(join(tmpdir(), "figs-sess-home-"))
  const dashed = realpathSync(repo).replace(/[\/:]/g, "-")
  const projDir = join(home, ".claude", "projects", dashed)
  mkdirSync(projDir, { recursive: true })
  writeFileSync(
    join(projDir, "3fffcd97-d4f5-4b77-8243-8f450d7c9614.jsonl"),
    `{"timestamp":"2026-06-11T01:00:00Z","type":"user"}\n` +
      `{"timestamp":"2026-06-11T01:00:05Z","type":"assistant","message":{"model":"claude-fable-5","usage":{"input_tokens":100,"output_tokens":50}}}\n`,
  )
  const r = await run(["report", "--result", "traced"], {
    cwd: repo,
    token: "t",
    env: { HOME: home },
  })
  assert.equal(r.code, 0, r.out)
  const rec = mock.lastIngest.body.runs.find((x) => x.result === "traced")
  assert.equal(rec.session, undefined, "no session block — the CLI must not infer one")
  rmSync(home, { recursive: true, force: true })
})

test("report warns when the shell ate a $ (orphaned thousands group), but still writes", async () => {
  // "$4,474.63" inside double quotes reaches the CLI as ",474.63" — the agent's
  // shell expanded $4 before argv. The CLI can't recover the digit, but the
  // orphaned comma-group is a signature legit prose doesn't have: warn + teach,
  // never block (a re-run on the same id folds the fix onto the record).
  const repo = await pushableRepo()
  const r = await run(["report", "--result", "filed 15 charges (,474.63) total"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ate a `\$`/)
  assert.match(r.out, /✓ run recorded/, "warn must not block the write")
})

test("report does not cry wolf on intact $ amounts and normal numbers", async () => {
  const repo = await pushableRepo()
  const r = await run(
    ["report", "--result", "filed 15 charges ($4,474.63); 10,000 rows matched at p = .05"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes("ate a"), `false positive: ${r.out}`)
})

test("resolve --rejected records the human's no (terminal close, via human)", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-no","ts":"2026-06-11T00:00:00Z","type":"sign-off","title":"Send the emails"}\n`,
  )
  const conflict = await run(["resolve", "a-no", "--rejected", "--withdrawn"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(conflict.code, 1)
  assert.match(conflict.out, /different closes/)

  const r = await run(
    ["resolve", "a-no", "--rejected", "--by", "Sarah", "--note", "not this quarter", "--no-push"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "rejected")
  assert.deepEqual(fold.resolution, { by: "Sarah", note: "not this quarter", via: "human" })
})

// ---------- figs inbox + the verified close (auto-cite) ---------------------

import { createHash } from "node:crypto"

const sha = (s) => createHash("sha256").update(s).digest("hex")
const resetInbox = () => {
  mock.inbox = { ok: true, truncated: false, asks: [] }
  mock.rawArtifacts = new Map()
}

const inboxAsk = (over = {}) => ({
  id: "ask-1",
  type: "sign-off",
  status: "open",
  to: "manager",
  title: "Send 10 payment reminders",
  need: "Approve exactly these",
  options: null,
  details: [{ l: "Before executing", v: "SMTP creds · drafts <7d old" }],
  refs: null,
  ts: new Date(Date.now() - 7200000).toISOString(),
  updatedAt: new Date(Date.now() - 7200000).toISOString(),
  events: [],
  ...over,
})
const approval = {
  id: "ev-approve-1",
  kind: "verdict",
  verdict: "approved",
  chosen: null,
  text: "go ahead, BCC me on the big ones",
  byName: "Sarah",
  asRole: "manager",
  createdAt: new Date(Date.now() - 3600000).toISOString(),
}

test("inbox lists sections with the exact next command per state", async () => {
  resetInbox()
  const repo = await pushableRepo()
  mock.inbox.asks = [
    inboxAsk({ id: "ask-ok", events: [approval] }),
    inboxAsk({
      id: "ask-no",
      type: "needs-decision",
      status: "rejected",
      title: "Old question",
      events: [
        { ...approval, id: "ev-rej", verdict: "rejected", text: "not needed anymore" },
      ],
    }),
    inboxAsk({ id: "ask-quiet", type: "needs-decision", title: "Stuck on creds", events: [] }),
  ]
  const r = await run(["inbox"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 answered · 1 rejected to acknowledge · 1 waiting on your human/)
  assert.match(r.out, /approved by Sarah \(manager\)/)
  assert.match(r.out, /"go ahead, BCC me on the big ones"/, "the human's words, verbatim")
  assert.match(r.out, /nothing left to do → figs resolve ask-ok/)
  assert.match(r.out, /real work → do the job, figs report it under its own --id/)
  assert.match(r.out, /figs resolve ask-no --rejected/)
  assert.match(r.out, /Stuck on creds \(raised /)
})

test("inbox renders a qualified verdict — verdict + chosen + note in one event", async () => {
  // Sign-off options are answer paths: the human's verdict can cite one
  // verbatim. One composed event carries all three; the inbox prints them
  // together and the next-command suggests closing with that exact path.
  resetInbox()
  const repo = await pushableRepo()
  mock.inbox.asks = [
    inboxAsk({
      id: "ask-q",
      options: ["Approved — file the 15", "Hold — wait for Capital Grille"],
      events: [
        {
          ...approval,
          id: "ev-q-1",
          chosen: "Approved — file the 15",
          text: "good catch on the duplicate",
        },
      ],
    }),
  ]
  const r = await run(["inbox"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /approved by Sarah \(manager\)/)
  assert.match(r.out, /→ "Approved — file the 15" · "good catch on the duplicate"/)
  assert.match(r.out, /figs resolve ask-q --chosen 'Approved — file the 15'/)
})

test("ask blocked teaches the merge into needs-decision", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "blocked", "--title", "Stuck on creds", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /"blocked" was folded into needs-decision/)
  assert.match(r.out, /RUN's status/)
})

test("inbox is empty-friendly and honest about truncation", async () => {
  resetInbox()
  const repo = await pushableRepo()
  const empty = await run(["inbox"], { cwd: repo, token: "t" })
  assert.equal(empty.code, 0)
  assert.match(empty.out, /inbox empty/)
  mock.inbox.truncated = true
  mock.inbox.asks = [inboxAsk({ id: "a", events: [approval] })]
  const r = await run(["inbox"], { cwd: repo, token: "t" })
  assert.match(r.out, /more exist/)
})

test("inbox <id> prints the handoff package and restores refs (hash-verified)", async () => {
  resetInbox()
  const repo = await pushableRepo()
  mock.rawArtifacts.set("previews.html", {
    content: "<p>emails</p>",
    hash: sha("<p>emails</p>"),
  })
  mock.inbox.asks = [
    inboxAsk({
      id: "ask-pkg",
      events: [approval],
      refs: [{ label: "previews.html", artifact: "previews.html" }],
    }),
  ]
  const r = await run(["inbox", "ask-pkg"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /THE THREAD/)
  assert.match(r.out, /Before executing: SMTP creds/)
  assert.match(r.out, /previews\.html \(fetched, hash ok\)/)
  assert.equal(
    readFileSync(join(repo, ".figs/artifacts/previews.html"), "utf8"),
    "<p>emails</p>",
  )
  assert.match(r.out, /verify any prerequisites[\s\S]*figs resolve ask-pkg/)
})

test("inbox <id> never clobbers a local artifact with different bytes", async () => {
  resetInbox()
  const repo = await pushableRepo()
  mkdirSync(join(repo, ".figs/artifacts"), { recursive: true })
  writeFileSync(join(repo, ".figs/artifacts/previews.html"), "<p>local work</p>")
  mock.rawArtifacts.set("previews.html", {
    content: "<p>server copy</p>",
    hash: sha("<p>server copy</p>"),
  })
  mock.inbox.asks = [
    inboxAsk({
      id: "ask-pkg2",
      events: [approval],
      refs: [{ label: "previews.html", artifact: "previews.html" }],
    }),
  ]
  const r = await run(["inbox", "ask-pkg2"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /exists locally with different content — left untouched/)
  assert.equal(
    readFileSync(join(repo, ".figs/artifacts/previews.html"), "utf8"),
    "<p>local work</p>",
  )
})

test("resolve auto-cites the answer event it acted on (via figs, verified)", async () => {
  resetInbox()
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-cite","ts":"2026-06-11T00:00:00Z","type":"needs-decision","title":"Bridge rule","options":["Strip the alpha prefix","Out of scope"]}\n`,
  )
  mock.inbox.asks = [
    inboxAsk({
      id: "a-cite",
      type: "needs-decision",
      title: "Bridge rule",
      options: ["Strip the alpha prefix", "Out of scope"],
      events: [
        {
          id: "ev-ans-7",
          kind: "answer",
          verdict: null,
          chosen: "Strip the alpha prefix",
          text: null,
          byName: "Sarah",
          asRole: "manager",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  ]
  const r = await run(
    ["resolve", "a-cite", "--chosen", "Strip the alpha prefix", "--no-push"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.deepEqual(fold.resolution, {
    chosen: "Strip the alpha prefix",
    via: "figs",
    answer: "ev-ans-7",
    by: "Sarah",
  })
})

test("resolve auto-cites a qualified verdict by its chosen path", async () => {
  // A verdict event may carry `chosen` (sign-off answer paths). The chosen-match
  // search must find it — the cite is by text, not by event kind.
  resetInbox()
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-qv","ts":"2026-06-11T00:00:00Z","type":"sign-off","title":"File May","options":["Approved — file the 15","Hold"]}\n`,
  )
  mock.inbox.asks = [
    inboxAsk({
      id: "a-qv",
      title: "File May",
      options: ["Approved — file the 15", "Hold"],
      events: [
        { ...approval, id: "ev-old", chosen: null, text: "looking…", verdict: null, kind: "answer" },
        { ...approval, id: "ev-qv-2", chosen: "Approved — file the 15", text: null },
      ],
    }),
  ]
  const r = await run(
    ["resolve", "a-qv", "--chosen", "Approved — file the 15", "--no-push"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.deepEqual(fold.resolution, {
    chosen: "Approved — file the 15",
    via: "figs",
    answer: "ev-qv-2",
    by: "Sarah",
  })
})

test("resolve self-fetches an ask raised elsewhere, then folds the close onto it", async () => {
  resetInbox()
  const repo = await pushableRepo()
  mock.inbox.asks = [
    inboxAsk({
      id: "a-remote",
      type: "needs-decision",
      title: "Creds expired",
      events: [
        {
          id: "ev-fix",
          kind: "answer",
          verdict: null,
          chosen: null,
          text: "rotated — try again",
          byName: "Sarah",
          asRole: "builder",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  ]
  const r = await run(["resolve", "a-remote", "--note", "unblocked", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /fetched "a-remote" from Figs/)
  const lines = readLines(repo, "asks.jsonl")
  const record = lines.find((l) => l.title === "Creds expired")
  assert.ok(record, "the full record came home before the fold")
  assert.equal(record.events, undefined, "server-only fields stripped")
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "resolved")
  assert.equal(fold.resolution.via, "figs")
  assert.equal(fold.resolution.answer, "ev-fix")
})

test("resolve cites the approval it acted on (post-job close)", async () => {
  resetInbox()
  mock.lastIngest = null
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-go","ts":"2026-06-11T00:00:00Z","type":"sign-off","title":"Send 10 reminders"}\n`,
  )
  mock.inbox.asks = [inboxAsk({ id: "a-go", events: [approval] })]
  const r = await run(["resolve", "a-go", "--note", "job reminders-2026-06"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  const askFold = mock.lastIngest.body.asks.find((a) => a.id === "a-go")
  assert.equal(askFold.status, "resolved")
  assert.equal(askFold.resolution.via, "figs")
  assert.equal(askFold.resolution.answer, "ev-approve-1")
  assert.equal(askFold.resolution.by, "Sarah")
  assert.equal(askFold.resolution.note, "job reminders-2026-06")
})

test("resolve falls back to via human when the inbox has nothing (offline path)", async () => {
  resetInbox()
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"a-ob","ts":"2026-06-11T00:00:00Z","type":"needs-decision","title":"Stuck"}\n`,
  )
  const r = await run(["resolve", "a-ob", "--by", "Sarah", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.deepEqual(fold.resolution, { by: "Sarah", via: "human" })
})
