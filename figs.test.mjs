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
function run(args, { cwd, token, env: extra } = {}) {
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
      `{"id":"a2","ts":"2026-06-10T01:00:00Z","type":"blocked","to":"builder","title":"Creds expired","status":"withdrawn","resolution":"creds rotated themselves"}\n`,
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
