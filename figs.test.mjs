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
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs"
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
          authorization: req.headers["authorization"],
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

test("help init documents the local, zero-flag scaffold", async () => {
  const r = await run(["help", "init"])
  assert.equal(r.code, 0)
  assert.match(r.out, /no account needed|purely local/i)
})

test("help link documents connecting a workspace", async () => {
  const r = await run(["help", "link"])
  assert.equal(r.code, 0)
  assert.match(r.out, /workspace/)
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

// ---------- init (purely local, zero flags) -------------------------------

test("init scaffolds .figs/ with no account and no network", async () => {
  const repo = newRepo()
  const r = await run(["init"], { cwd: repo }) // no token, no flags
  assert.equal(r.code, 0, r.out)
  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.match(cfg.agentId, /^[0-9a-f-]{36}$/)
  assert.equal(cfg.workspaceId, undefined, "local config carries no workspaceId")
  assert.equal(cfg.endpoint, undefined, "local config carries no endpoint")
  for (const f of ["agent.json", "CONTRACT.md", "GUIDE.md", ".gitignore", "runs.jsonl", "asks.jsonl", "messages.jsonl"]) {
    assert.ok(existsSync(join(repo, ".figs", f)), `missing .figs/${f}`)
  }
})

test("init rejects flags — it is purely local", async () => {
  const r = await run(["init", "--workspace", UUID], { cwd: newRepo() })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /unknown flag/)
})

test("re-init keeps the identity, never clobbers the charter, and preserves a link", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["link", "--workspace", UUID], { cwd: repo }) // logged out → unverified but linked
  const cfg1 = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  const charter = JSON.stringify({ name: "Authored", mandate: "real content" })
  writeFileSync(join(repo, ".figs/agent.json"), charter)

  const r = await run(["init"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const cfg2 = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg2.agentId, cfg1.agentId, "re-init must reuse the agentId")
  assert.equal(cfg2.workspaceId, UUID, "re-init must NOT unlink")
  assert.equal(readFileSync(join(repo, ".figs/agent.json"), "utf8"), charter)
})

// ---------- link (the connector) ------------------------------------------

test("link --workspace <uuid> writes the destination without login (unverified)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["link", "--workspace", UUID], { cwd: repo }) // no token
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /unverified until your first/)
  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg.workspaceId, UUID)
  assert.match(cfg.agentId, /^[0-9a-f-]{36}$/, "link preserves identity")
})

test("link with no flag auto-selects the only workspace", async () => {
  mock.workspaces = [{ id: UUID, slug: "acme", name: "Acme", role: "owner" }]
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["link"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /linking to acme \(Acme\)/)
  const cfg = JSON.parse(readFileSync(join(repo, ".figs/config.json"), "utf8"))
  assert.equal(cfg.workspaceId, UUID)
})

test("link with several workspaces lists them and exits 1", async () => {
  mock.workspaces = [
    { id: UUID, slug: "acme", name: "Acme", role: "owner" },
    { id: UUID.replace("1111", "9999"), slug: "globex", name: "Globex", role: "member" },
  ]
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["link"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /which workspace\?/)
  assert.match(r.out, /--workspace acme/)
  assert.match(r.out, /--workspace globex/)
})

test("link with zero workspaces says to create one and exits 1", async () => {
  mock.workspaces = []
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["link"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /no workspaces yet/)
})

test("link --workspace <slug> needs login", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["link", "--workspace", "acme"], { cwd: repo }) // no token
  assert.equal(r.code, 1)
  assert.match(r.out, /needs `figs login`|workspace UUID/)
})

test("link before init points you to init first", async () => {
  const r = await run(["link", "--workspace", UUID], { cwd: newRepo() })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /figs init/)
})

// ---------- doctor (offline, account-free conformance) ---------------------

test("doctor refuses a charter that still has template placeholders", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["doctor"], { cwd: repo }) // no token, not linked — still validates locally
  assert.equal(r.code, 1)
  assert.match(r.out, /template placeholders/)
})

test("doctor passes offline with no account once the charter is filled", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  writeFileSync(
    join(repo, ".figs/agent.json"),
    JSON.stringify({ name: "TestAgent", mandate: "tests the CLI" }),
  )
  const r = await run(["doctor"], { cwd: repo }) // no token, not linked
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /passes local conformance/)
  assert.match(r.out, /server validation skipped/)
})

// ---------- push ------------------------------------------------------------

async function pushableRepo() {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["link", "--workspace", UUID], { cwd: repo }) // logged out → unverified, but linked
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
    `{"id":"a1","ts":"2026-06-10T00:00:00Z","type":"question","to":"manager","title":"Pick a path","options":["A","B"]}\n` +
      `{"id":"a1","status":"resolved","resolution":{"chosen":"A","via":"human","by":"Sarah"}}\n` + // folds onto a1
      `{"id":"a2","ts":"2026-06-10T01:00:00Z","type":"question","to":"builder","title":"Creds expired","status":"withdrawn","resolution":"creds rotated themselves"}\n`,
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
/** Assert resolution.ts is a real machine stamp; return the rest for deepEqual. */
const unstampResolution = (resolution) => {
  const { ts, ...rest } = resolution
  assert.match(
    ts ?? "",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    "resolve stamps resolution.ts (the close's machine clock)",
  )
  return rest
}

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

test("report on a linked repo with no token records locally and exits 2", async () => {
  const repo = await pushableRepo() // linked
  const r = await run(["report", "--result", "kept"], { cwd: repo }) // no token → can't publish
  assert.equal(r.code, 2, r.out) // 2 = recorded locally, publish failed (retry push)
  assert.match(r.out, /not logged in/)
  assert.match(r.out, /recorded locally — do NOT re-run/)
  assert.equal(lastLine(repo, "runs.jsonl").result, "kept")
})

test("report --attach copies files, links attachments[] (always an array), uploads each", async () => {
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
  assert.deepEqual(runRec.attachments, ["a.html", "b.md"])
  assert.equal(runRec.artifact, undefined, "no legacy singular field")
  assert.equal(runRec.artifacts, undefined, "no legacy plural field")
  assert.ok(existsSync(join(repo, ".figs/artifacts/a.html")))
  assert.deepEqual(mock.uploads.map((u) => u.name).sort(), ["a.html", "b.md"])
})

test("report --attach uses attachments[] even for a single file (no singular special case)", async () => {
  const repo = await pushableRepo()
  writeFileSync(join(repo, "one.html"), "<p>1</p>")
  const r = await run(["report", "--result", "one", "--attach", join(repo, "one.html"), "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  const runRec = lastLine(repo, "runs.jsonl")
  assert.deepEqual(runRec.attachments, ["one.html"])
  assert.equal(runRec.artifact, undefined)
})

test("report --attach accepts download-only types (xlsx) for the recon chain", async () => {
  const repo = await pushableRepo()
  writeFileSync(join(repo, "invoices.xlsx"), "PK fake xlsx")
  const r = await run(["report", "--result", "data in", "--attach", join(repo, "invoices.xlsx"), "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(lastLine(repo, "runs.jsonl").attachments, ["invoices.xlsx"])
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
  const guessy = await run(["ask", "question", "--title", "x", "--run", "last"], {
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
      "--on-approve", "Send the 10 reminder emails",
      "--on-approve", "Mark the invoices chased in the ledger",
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
  assert.deepEqual(ask.onApprove, [
    "Send the 10 reminder emails",
    "Mark the invoices chased in the ledger",
  ])
  assert.deepEqual(ask.details, [{ l: "Total overdue", v: "$4,820" }])
  assert.deepEqual(ask.attachments, ["previews.html"], "unified attachments[] (filename is the label)")
  assert.equal(ask.refs, undefined, "no legacy refs field")
  assert.ok(mock.lastIngest.body.asks.find((a) => a.id === ask.id), "ask reached ingest")
  assert.doesNotMatch(r.out, /sign-off reviews best with attachments/, "no tip when attached")
  assert.doesNotMatch(r.out, /state what approval sets in motion/, "no tip when stated")
})

test("ask --on-approve outside sign-off teaches the approval contract", async () => {
  const repo = await pushableRepo()
  const r = await run(
    ["ask", "question", "--title", "Pick a rule", "--on-approve", "apply it"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 1)
  assert.match(r.out, /sign-off only/)
  assert.match(r.out, /chosen option carries the next step/)
})

test("ask sign-off without --on-approve tips the consequences", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "sign-off", "--title", "Approve thing", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /state what approval sets in motion/, "consequences tip expected")
})

test("doctor flags hand-written onApprove on a non-sign-off ask", async () => {
  const repo = await pushableRepo()
  appendFileSync(
    join(repo, ".figs", "asks.jsonl"),
    JSON.stringify({ id: "a-bad", type: "question", title: "note", onApprove: ["do x"] }) + "\n",
  )
  const r = await run(["doctor"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /onApprove: sign-off only/)
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
  const r = await run(["ask", "question"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /needs --title/)
})

test("ask --stdin takes a JSON object; flags still stamp and validate", async () => {
  const repo = await pushableRepo()
  const body = {
    type: "question",
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
  assert.equal(ask.type, "question")
  assert.equal(ask.found, body.found)
  assert.ok(ask.id && ask.ts, "CLI stamps id + ts onto stdin asks")
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

// ---------- checkpoint / run state (lifecycle, verb-stamped) ---------------

test("checkpoint opens a job in-flight — stamped ts, trigger in session, pushed", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  const r = await run(
    [
      "checkpoint", "--id", "recon-acme-2026-06",
      "--note", "Statements pulled — matching now",
      "--trigger", "monthly close cron",
    ],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /✓ checkpoint recorded/)
  assert.match(r.out, /new job opened: recon-acme-2026-06 \(in flight\)/)
  assert.match(r.out, /figs report --id recon-acme-2026-06/, "teaches the settling verb")
  const rec = lastLine(repo, "runs.jsonl")
  assert.equal(rec.id, "recon-acme-2026-06")
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/)
  assert.equal(rec.result, "Statements pulled — matching now")
  assert.equal(rec.state, "in-flight")
  assert.deepEqual(rec.session, { trigger: "monthly close cron" }, "trigger only — nothing inferred")
  // a checkpoint isn't a checkpoint until it's pushed — the verb pushes itself
  const pushed = mock.lastIngest.body.runs.find((x) => x.id === "recon-acme-2026-06")
  assert.equal(pushed.state, "in-flight")
})

test("checkpoint requires --id and --note, teaching each fix", async () => {
  const repo = await pushableRepo()
  const noId = await run(["checkpoint", "--note", "working"], { cwd: repo, token: "t" })
  assert.equal(noId.code, 1)
  assert.match(noId.out, /needs --id/)
  const noNote = await run(["checkpoint", "--id", "job-1"], { cwd: repo, token: "t" })
  assert.equal(noNote.code, 1)
  assert.match(noNote.out, /needs --note/)
})

test("a linked checkpoint whose push fails says loudly it protects nothing yet", async () => {
  const repo = await pushableRepo() // linked
  // no token → the auto-push fails; the local save alone must not read as success
  const r = await run(["checkpoint", "--id", "job-crash", "--note", "underway"], { cwd: repo })
  assert.equal(r.code, 2, r.out) // 2 = recorded locally, publish failed
  assert.match(r.out, /NOT protecting the job remotely yet/)
  assert.match(r.out, /figs push/)
  assert.equal(lastLine(repo, "runs.jsonl").id, "job-crash", "still saved locally")
})

test("a second checkpoint folds onto the job — no re-open line", async () => {
  const repo = await pushableRepo()
  await run(["checkpoint", "--id", "job-2", "--note", "step 1", "--no-push"], { cwd: repo, token: "t" })
  const r = await run(["checkpoint", "--id", "job-2", "--note", "step 2", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.ok(!r.out.includes("new job opened"), "only the FIRST checkpoint opens the job")
  assert.equal(lastLine(repo, "runs.jsonl").result, "step 2")
})

test("report settles the job a checkpoint opened (and is born settled without one)", async () => {
  const repo = await pushableRepo()
  await run(["checkpoint", "--id", "job-3", "--note", "underway", "--no-push"], { cwd: repo, token: "t" })
  const settle = await run(["report", "--id", "job-3", "--result", "done", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(settle.code, 0, settle.out)
  assert.equal(lastLine(repo, "runs.jsonl").state, "settled")
  // single-shot path: a plain report is a job born settled
  await run(["report", "--id", "job-4", "--result", "one sitting", "--no-push"], { cwd: repo, token: "t" })
  assert.equal(lastLine(repo, "runs.jsonl").state, "settled")
})

test("report --trigger lands in session.trigger and invents nothing else", async () => {
  const repo = await pushableRepo()
  const r = await run(
    ["report", "--id", "job-5", "--result", "done", "--trigger", "Wayne, in chat", "--no-push"],
    { cwd: repo, token: "t" },
  )
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(lastLine(repo, "runs.jsonl").session, { trigger: "Wayne, in chat" })
})

test("settling a job with an open ask citing it teaches, never blocks", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/asks.jsonl"),
    `{"id":"bridge-q","ts":"2026-06-12T10:00:00Z","type":"question","status":"open","title":"Bridge rule?","run":"recon-x"}\n` +
      `{"id":"done-q","ts":"2026-06-12T10:00:00Z","type":"sign-off","status":"resolved","title":"Old one","run":"recon-x"}\n`,
  )
  const r = await run(["report", "--id", "recon-x", "--result", "done", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /✓ run recorded/, "teaching must not block the write")
  assert.match(r.out, /1 open ask cites this job \(bridge-q\)/)
  assert.match(r.out, /tail sign-off is fine/)
  assert.match(r.out, /figs checkpoint --id recon-x --status warn/)
  // a job nothing cites stays quiet
  const quiet = await run(["report", "--id", "other-job", "--result", "ok", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.ok(!quiet.out.includes("open ask"), `no note expected: ${quiet.out}`)
})

test("push refuses a hand-written run with a bogus state (lifecycle is enum'd)", async () => {
  const repo = await pushableRepo()
  writeFileSync(
    join(repo, ".figs/runs.jsonl"),
    `{"id":"bad-state","ts":"2026-06-10T00:00:00Z","result":"x","state":"open"}\n`,
  )
  const r = await run(["push"], { cwd: repo, token: "t" })
  assert.equal(r.code, 1)
  assert.match(r.out, /state: "open" isn't valid/)
})

test("ask blocked teaches that it isn't an ask type (use a question)", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "blocked", "--title", "Stuck on creds", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /"blocked" isn't an ask type/)
  assert.match(r.out, /RUN's status/)
})

test("ask needs-decision teaches the rename to question", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "needs-decision", "--title", "Pick a path", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /"needs-decision" was renamed to "question"/)
})

test("ask fyi teaches it was retired (a note is a report)", async () => {
  const repo = await pushableRepo()
  const r = await run(["ask", "fyi", "--title", "FYI: contract updated", "--no-push"], {
    cwd: repo,
    token: "t",
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /"fyi" was retired/)
})

test("readJsonl tolerates a crash-torn final line but dies on interior corruption", async () => {
  // A process killed mid-append leaves a half-written LAST line — the journal
  // must survive that. Interior corruption is real damage and must still fail.
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  writeFileSync(
    join(repo, ".figs/runs.jsonl"),
    `{"id":"r1","ts":"2026-06-13T00:00:00Z","result":"ok","state":"settled"}\n` +
      `{"id":"r2","ts":"2026-06-13T01:00:00Z","result":"hal`, // torn final line (crash)
  )
  const ok = await run(["report", "--id", "r3", "--result", "next"], { cwd: repo })
  assert.equal(ok.code, 0, ok.out)
  assert.match(ok.out, /last line of .figs\/runs.jsonl is broken/)

  const repo2 = newRepo()
  await run(["init"], { cwd: repo2 })
  writeFileSync(
    join(repo2, ".figs/runs.jsonl"),
    `{"id":"r1","ts":"2026-06-13T00:00:00Z","result":"tor` + `\n` + // torn INTERIOR line
      `{"id":"r2","ts":"2026-06-13T01:00:00Z","result":"ok","state":"settled"}\n`,
  )
  const bad = await run(["report", "--id", "r3", "--result", "next"], { cwd: repo2 })
  assert.notEqual(bad.code, 0)
  assert.match(bad.out, /malformed JSON in .figs\/runs.jsonl line 1/)
})

// ============================================================================
// Redesign — step 1: the state model + surface (local-first, exit codes,
// link, peek-don't-use, announce, reference checks, the no-account audit).
// ============================================================================

const OFFLINE = { env: { FIGS_ENDPOINT: "http://127.0.0.1:1" } } // refused fast — nothing should reach it

test("report in local mode records and exits 0, never calling the server", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  mock.lastIngest = null
  const r = await run(["report", "--id", "j1", "--result", "done"], { cwd: repo }) // no token, not linked
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /local mode — `figs link` to publish/)
  assert.equal(mock.lastIngest, null, "local mode must not call the server")
  assert.equal(lastLine(repo, "runs.jsonl").result, "done")
})

test("report announces new-vs-fold for an explicit --id", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const a = await run(["report", "--id", "recon", "--result", "first"], { cwd: repo })
  assert.match(a.out, /new job opened: recon/)
  const b = await run(["report", "--id", "recon", "--result", "second"], { cwd: repo })
  assert.match(b.out, /folded onto existing job recon/)
})

test("report with no --id prints no new-vs-fold line (auto-id is always new)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["report", "--result", "x"], { cwd: repo })
  assert.ok(!/new job opened|folded onto/.test(r.out), r.out)
})

test("ask announces new-vs-fold for an explicit --id (a revision folds)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const a = await run(["ask", "question", "--id", "q1", "--title", "first"], { cwd: repo })
  assert.match(a.out, /new ask opened: q1/)
  const b = await run(["ask", "question", "--id", "q1", "--title", "revised"], { cwd: repo })
  assert.match(b.out, /folded onto existing ask q1/)
})

test("checkpoint reopening a settled job warns (legal, but nudge a new id)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["report", "--id", "j", "--result", "done"], { cwd: repo }) // settles
  const r = await run(["checkpoint", "--id", "j", "--note", "more work"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /reopening a settled job/)
})

test("--run warns on a dangling link but never blocks", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["ask", "question", "--title", "t", "--run", "nope"], { cwd: repo })
  assert.equal(r.code, 0, r.out) // warn, not die
  assert.match(r.out, /--run "nope" isn't a job in this journal/)
})

test("--unit warns when it isn't a charter unit (once units exist)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  writeFileSync(
    join(repo, ".figs/agent.json"),
    JSON.stringify({ name: "A", mandate: "m", units: [{ id: "acme", name: "Acme" }] }),
  )
  const r = await run(["report", "--id", "j", "--result", "x", "--unit", "acmee"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /--unit "acmee" isn't one of your charter units/)
})

test("version prints offline (no --check ⇒ no network)", async () => {
  const r = await run(["version"], OFFLINE)
  assert.equal(r.code, 0)
  assert.ok(r.out.includes(VERSION), r.out)
})

test("a verb in a subdir with no .figs peeks at the parent but never adopts it", async () => {
  const root = newRepo()
  await run(["init"], { cwd: root })
  writeFileSync(join(root, ".figs/agent.json"), JSON.stringify({ name: "Recruiter", mandate: "m" }))
  const sub = join(root, "packages", "sub")
  mkdirSync(sub, { recursive: true })
  const r = await run(["report", "--result", "x"], { cwd: sub })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /found one at/)
  assert.match(r.out, /Recruiter/)
  assert.match(r.out, /figs init/)
})

test("status reports local mode before linking, linked after", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const a = await run(["status", "--json"], { cwd: repo })
  assert.equal(JSON.parse(a.out).mode, "local")
  await run(["link", "--workspace", UUID], { cwd: repo })
  const b = await run(["status", "--json"], { cwd: repo })
  assert.equal(JSON.parse(b.out).mode, "linked")
})

// The no-account audit — the release gate in one test. Every local verb must
// work offline with no credentials and match the §3 exit-code table.
test("no-account audit: the local surface works offline with no credentials", async () => {
  const repo = newRepo()
  assert.equal((await run(["init"], { cwd: repo, ...OFFLINE })).code, 0, "init")
  writeFileSync(join(repo, ".figs/agent.json"), JSON.stringify({ name: "Aud", mandate: "audit" }))
  const cases = [
    [["status"], 0],
    [["status", "--json"], 0],
    [["version"], 0],
    [["doctor"], 0],
    [["report", "--id", "j", "--result", "ok"], 0],
    [["checkpoint", "--id", "j2", "--note", "wip"], 0],
    [["ask", "question", "--title", "q"], 0],
    [["push"], 1], // not linked → structural error (fix: figs link)
  ]
  for (const [args, code] of cases) {
    const r = await run([...args], { cwd: repo, ...OFFLINE })
    assert.equal(r.code, code, `${args.join(" ")} → exit ${r.code}\n${r.out}`)
  }
})

// ============================================================================
// Redesign — step 3: the data plane (messages.jsonl, answer, close matrix,
// inbox local read, show). The ask → answer → close loop, fully local.
// ============================================================================

// ---------- figs answer — transcribe the human's reply ----------------------

test("answer records a question's answer to messages.jsonl (source chat, minted id)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "bridge", "--title", "Bridge rule?", "--option", "Strip prefix"], { cwd: repo })
  const r = await run(["answer", "bridge", "--chosen", "Strip prefix", "--by", "Sarah"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const m = lastLine(repo, "messages.jsonl")
  assert.equal(m.kind, "answer")
  assert.equal(m.ask, "bridge")
  assert.equal(m.by, "Sarah")
  assert.equal(m.chosen, "Strip prefix")
  assert.equal(m.source, "chat")
  assert.match(m.id, /^msg-/)
  assert.ok(m.ts, "CLI stamps the ts")
})

test("answer requires --by (the human's name, not the agent's)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  const r = await run(["answer", "q", "--text", "do it"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /needs --by/)
})

test("answer dies if the ask isn't in this journal", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["answer", "ghost", "--text", "x", "--by", "Wayne"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /isn't in this journal/)
})

test("answer --chosen is verbatim-checked against the ask's options", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?", "--option", "Strip prefix"], { cwd: repo })
  const r = await run(["answer", "q", "--chosen", "strip prefix", "--by", "W"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /did you mean "Strip prefix"/)
})

test("answer --approve records a verdict message", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "sign-off", "--id", "s", "--title", "ok?"], { cwd: repo })
  const r = await run(["answer", "s", "--approve", "--by", "Wayne"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const m = lastLine(repo, "messages.jsonl")
  assert.equal(m.kind, "verdict")
  assert.equal(m.verdict, "approved")
})

// ---------- figs close — derives the close from the reply -------------------

test("close derives 'resolved' from an answer and cites it", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "bridge", "--title", "?", "--option", "Strip prefix"], { cwd: repo })
  await run(["answer", "bridge", "--chosen", "Strip prefix", "--by", "Sarah"], { cwd: repo })
  const msgId = lastLine(repo, "messages.jsonl").id
  const r = await run(["close", "bridge"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "resolved")
  assert.equal(fold.resolution.via, "figs")
  assert.equal(fold.resolution.answer, msgId, "cites the message it acted on")
  assert.equal(fold.resolution.by, "Sarah")
  assert.equal(fold.resolution.chosen, "Strip prefix")
})

test("close --run links the job the reply set in motion", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  await run(["answer", "q", "--text", "go", "--by", "W"], { cwd: repo })
  await run(["report", "--id", "do-it", "--result", "done"], { cwd: repo })
  const r = await run(["close", "q", "--run", "do-it"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.equal(lastLine(repo, "asks.jsonl").resolution.run, "do-it")
})

test("close derives 'rejected' from a reject verdict", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "sign-off", "--id", "s", "--title", "ok?"], { cwd: repo })
  await run(["answer", "s", "--reject", "--by", "Wayne"], { cwd: repo })
  const r = await run(["close", "s"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.equal(lastLine(repo, "asks.jsonl").status, "rejected")
})

test("close refuses when changes were requested (revise, don't close)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "sign-off", "--id", "s", "--title", "ok?"], { cwd: repo })
  await run(["answer", "s", "--request-changes", "--by", "Wayne"], { cwd: repo })
  const r = await run(["close", "s"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /changes were requested/)
})

test("close with no reply refuses with the teaching menu", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  const r = await run(["close", "q"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /no reply on file/)
  assert.match(r.out, /figs answer q/)
  assert.match(r.out, /--withdrawn/)
})

test("close --withdrawn ends an ask with no reply (the agent's own act)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  const r = await run(["close", "q", "--withdrawn"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.equal(lastLine(repo, "asks.jsonl").status, "withdrawn")
})

test("close --note with no reply records a self-cleared resolve (via self)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  const r = await run(["close", "q", "--note", "creds rotated themselves"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const fold = lastLine(repo, "asks.jsonl")
  assert.equal(fold.status, "resolved")
  assert.equal(fold.resolution.via, "self")
  assert.equal(fold.resolution.note, "creds rotated themselves")
})

test("close teaches the migration when the old resolve flags are used", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?", "--option", "A"], { cwd: repo })
  for (const [flag, hint] of [
    ["--chosen", /figs answer/],
    ["--rejected", /figs answer .* --reject/],
    ["--answer-id", /auto-cites/],
  ]) {
    const r = await run(["close", "q", flag, "A"], { cwd: repo })
    assert.equal(r.code, 1, `${flag} should be rejected`)
    assert.match(r.out, hint)
  }
})

// ---------- figs inbox + show (pure local reads) ----------------------------

test("inbox is a pure local read — works offline with no account", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "Pick one", "--option", "A"], { cwd: repo })
  await run(["answer", "q", "--chosen", "A", "--by", "Sarah"], { cwd: repo })
  mock.lastIngest = null
  const r = await run(["inbox"], { cwd: repo, ...OFFLINE })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 answered/)
  assert.match(r.out, /q · question — Pick one/)
  assert.match(r.out, /answered by Sarah/)
  assert.match(r.out, /figs close q/)
})

test("inbox groups waiting asks and unfinished jobs", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "waiting", "--title", "no reply yet"], { cwd: repo })
  await run(["checkpoint", "--id", "job1", "--note", "halfway"], { cwd: repo })
  const r = await run(["inbox"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /waiting on your human/)
  assert.match(r.out, /job1 — halfway/)
  assert.match(r.out, /1 job in flight/)
})

test("inbox --json emits a structured, machine-readable view", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  await run(["answer", "q", "--text", "yes", "--by", "W"], { cwd: repo })
  const r = await run(["inbox", "--json"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  const data = JSON.parse(r.out)
  assert.equal(data.asks.length, 1)
  assert.equal(data.asks[0].replies.length, 1)
  assert.ok(data.sync, "carries a sync field for degraded-sync detection")
})

test("inbox is empty-friendly", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["inbox"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /inbox empty/)
})

test("show <ask-id> magnifies the ask + its thread (pure local)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "bridge", "--title", "Bridge rule?", "--option", "Strip prefix", "--found", "180 rows"], { cwd: repo })
  await run(["answer", "bridge", "--chosen", "Strip prefix", "--by", "Sarah"], { cwd: repo })
  const r = await run(["show", "bridge"], { cwd: repo, ...OFFLINE })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Bridge rule\?/)
  assert.match(r.out, /180 rows/)
  assert.match(r.out, /THE THREAD/)
  assert.match(r.out, /answered by Sarah/)
})

test("show <job-id> magnifies the job + its checkpoint trail", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["checkpoint", "--id", "recon", "--note", "pulled statements"], { cwd: repo })
  await run(["report", "--id", "recon", "--result", "88% matched"], { cwd: repo })
  const r = await run(["show", "recon"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /job recon/)
  assert.match(r.out, /Trail/)
  assert.match(r.out, /pulled statements/)
  assert.match(r.out, /88% matched/)
})

test("show on an unknown id dies cleanly", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  const r = await run(["show", "nope"], { cwd: repo })
  assert.equal(r.code, 1)
  assert.match(r.out, /isn't a run or an ask/)
})

test("inbox <id> routes to show (back-compat alias)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "Routed?"], { cwd: repo })
  const r = await run(["inbox", "q"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Routed\?/)
  assert.match(r.out, /THE THREAD|No reply yet/)
})

// ---------- push carries messages -------------------------------------------

test("push sends messages alongside the spine", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo() // linked
  await run(["ask", "question", "--id", "q", "--title", "?", "--no-push"], { cwd: repo, token: "t" })
  await run(["answer", "q", "--text", "yes", "--by", "Wayne", "--no-push"], { cwd: repo, token: "t" })
  const r = await run(["push"], { cwd: repo, token: "t" })
  assert.equal(r.code, 0, r.out)
  assert.ok(Array.isArray(mock.lastIngest.body.messages), "ingest body carries messages[]")
  assert.equal(mock.lastIngest.body.messages.at(-1).text, "yes")
  assert.match(r.out, /messages/)
})

test("close --attach pins proof of what was done to the close moment", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  await run(["ask", "question", "--id", "q", "--title", "?"], { cwd: repo })
  await run(["answer", "q", "--text", "send it", "--by", "Wayne"], { cwd: repo })
  writeFileSync(join(repo, "sent.html"), "<p>sent</p>")
  const r = await run(["close", "q", "--attach", join(repo, "sent.html")], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(lastLine(repo, "asks.jsonl").attachments, ["sent.html"])
})

test("show aggregates attachments across an ask's moments (folding never hides one)", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  writeFileSync(join(repo, "v1.html"), "<p>v1</p>")
  writeFileSync(join(repo, "proof.html"), "<p>done</p>")
  await run(["ask", "sign-off", "--id", "s", "--title", "ok?", "--attach", join(repo, "v1.html")], { cwd: repo })
  await run(["answer", "s", "--approve", "--by", "Wayne"], { cwd: repo })
  await run(["close", "s", "--attach", join(repo, "proof.html")], { cwd: repo })
  const r = await run(["show", "s"], { cwd: repo })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /v1\.html/, "the raise attachment survives")
  assert.match(r.out, /proof\.html/, "the close attachment shows too")
})

test("attach rejects an unsupported type, accepts the expanded download-only set", async () => {
  const repo = newRepo()
  await run(["init"], { cwd: repo })
  writeFileSync(join(repo, "bad.exe"), "MZ")
  const bad = await run(["report", "--result", "x", "--attach", join(repo, "bad.exe")], { cwd: repo })
  assert.equal(bad.code, 1)
  assert.match(bad.out, /unsupported type/)
  writeFileSync(join(repo, "data.csv"), "a,b\n1,2")
  const ok = await run(["report", "--result", "y", "--attach", join(repo, "data.csv")], { cwd: repo })
  assert.equal(ok.code, 0, ok.out)
})

// ============================================================================
// Redesign — step 4: auth (Bearer header, per-endpoint credentials)
// ============================================================================

test("push sends Authorization: Bearer (and the legacy header through the transition)", async () => {
  mock.lastIngest = null
  const repo = await pushableRepo()
  const r = await run(["push"], { cwd: repo, token: "tok-xyz" })
  assert.equal(r.code, 0, r.out)
  assert.equal(mock.lastIngest.authorization, "Bearer tok-xyz")
  assert.equal(mock.lastIngest.token, "tok-xyz", "legacy x-figs-token still sent for dual-accept")
})

test("credentials are keyed by endpoint origin (a prod token never goes to a dev endpoint)", async () => {
  // Log in to two different endpoints from the same HOME; each keeps its own token.
  const home = mkdtempSync(join(tmpdir(), "figs-home-"))
  const A = "https://app.figs.so"
  const B = "http://127.0.0.1:9999"
  await run(["login", "tok-prod"], { env: { HOME: home, FIGS_ENDPOINT: A } })
  await run(["login", "tok-dev"], { env: { HOME: home, FIGS_ENDPOINT: B } })
  const creds = JSON.parse(readFileSync(join(home, ".figs/credentials.json"), "utf8"))
  assert.equal(creds[A].token, "tok-prod")
  assert.equal(creds[B].token, "tok-dev")
  rmSync(home, { recursive: true, force: true })
})

test("the legacy single-token credentials file migrates to the default endpoint", async () => {
  const home = mkdtempSync(join(tmpdir(), "figs-home-"))
  mkdirSync(join(home, ".figs"), { recursive: true })
  writeFileSync(join(home, ".figs/credentials.json"), JSON.stringify({ token: "legacy-tok" }))
  // status against the default endpoint should pick up the migrated token.
  const r = await run(["status", "--json"], { env: { HOME: home, FIGS_ENDPOINT: "https://app.figs.so" } })
  assert.equal(r.code, 0, r.out)
  // It tried to use the token (can't reach prod in the test, but it's "logged in" intent):
  // simplest robust check — logging in elsewhere preserves the migrated default token.
  await run(["login", "new-dev"], { env: { HOME: home, FIGS_ENDPOINT: "http://127.0.0.1:9999" } })
  const creds = JSON.parse(readFileSync(join(home, ".figs/credentials.json"), "utf8"))
  assert.equal(creds["https://app.figs.so"].token, "legacy-tok", "legacy token re-keyed to the default endpoint")
  assert.equal(creds["http://127.0.0.1:9999"].token, "new-dev")
  rmSync(home, { recursive: true, force: true })
})

test("logout removes only the current endpoint's token, keeps the others", async () => {
  const home = mkdtempSync(join(tmpdir(), "figs-home-"))
  await run(["login", "tok-prod"], { env: { HOME: home, FIGS_ENDPOINT: "https://app.figs.so" } })
  await run(["login", "tok-dev"], { env: { HOME: home, FIGS_ENDPOINT: "http://127.0.0.1:9999" } })
  const r = await run(["logout"], { env: { HOME: home, FIGS_ENDPOINT: "http://127.0.0.1:9999" } })
  assert.equal(r.code, 0, r.out)
  const creds = JSON.parse(readFileSync(join(home, ".figs/credentials.json"), "utf8"))
  assert.equal(creds["https://app.figs.so"].token, "tok-prod", "prod token kept")
  assert.equal(creds["http://127.0.0.1:9999"], undefined, "dev token removed")
  rmSync(home, { recursive: true, force: true })
})
