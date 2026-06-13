#!/usr/bin/env node
/**
 * `figs` — the agent-side CLI (v1, zero-dependency).
 *
 * LOCAL (no account, no network — the complete product):
 *   figs init                           scaffold .figs/ here — purely local, mints a stable agent id
 *   figs report --result '…'            settle a job (stamps id/ts, --attach files)
 *   figs checkpoint --id … --note '…'   save a job's progress mid-flight (opens it in-flight)
 *   figs ask <type> --title '…'         raise an ask (self-contained: options/details/attachments)
 *   figs answer <ask-id> --by '…'       record your human's reply to an ask (you run it, not them)
 *   figs inbox [<ask-id>]               what needs you (pure local read)
 *   figs show <id>                      magnify one ask or job (thread/trail + attachments)
 *   figs close <ask-id>                 close an ask (derives the close from the reply, cites it)
 *   figs doctor                         validate .figs/ against the spec — runs account-free
 *   figs status                         local/linked + agent state               [--json]
 *   figs version                        print the CLI version (offline; --check for updates)
 *   figs help [<command>]               usage; `-h`/`--help` on any command, `-v` for version
 *
 * CONNECTED (needs a one-time login + a workspace — strictly additive):
 *   figs login [<token>]                device-flow approve (agent never sees the token), or save a pasted one
 *   figs logout                         remove the locally-saved token (~/.figs/credentials.json)
 *   figs link [--workspace <slug|uuid>] connect .figs/ to a workspace so push can publish
 *   figs push                           publish the .figs/ spine + attachments to the endpoint
 *
 * The writing verbs (report/checkpoint/ask/resolve) are sugar over the same
 * files — they stamp ids + real-clock timestamps, validate on write with
 * teaching errors, copy attachments into artifacts/, then (when linked) invoke
 * the same push as `figs push` (auto-push IS push; --no-push to batch).
 * Hand-writing the JSONL + bare `push` remains fully supported — files are the
 * protocol; the verbs are conveniences.
 *
 * Designed to be driven by an agent: non-interactive, clear output, `--json`
 * on read commands, `-h`/`--help`/`help` everywhere, and errors that say what to
 * do next. Bare `figs` prints help; unknown commands AND unknown flags exit
 * non-zero. Exit codes: 0 = recorded · 1 = nothing written (fix the input) ·
 * 2 = recorded locally, publish failed (retry `figs push`, never the verb).
 * Flags accept `--name value` or `--name=value`. Network calls time out (30s).
 *
 * Two facts decide behavior: local-vs-linked (does config.json declare a
 * workspaceId?) and authenticated (is there a token?). The config declares
 * intent; the CLI errors only when declared intent can't be met. Identity is
 * the *agent* — a UUID minted by `init` into the committed, non-secret
 * .figs/config.json ({ agentId } locally; + { endpoint, workspaceId } once
 * `figs link`ed). Auth is the *user* (a token, configured once per machine).
 * Run from the agent's repo root, where `.figs/` lives.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"

// Single source of truth for the version: package.json (shipped alongside this
// file in the published package). One edit keeps `figs version`, the floor
// check, and the npm package in lockstep.
const VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version
// Going-forward default; override with FIGS_ENDPOINT or .figs/config.json endpoint
// (e.g. FIGS_ENDPOINT=http://localhost:3000 for local dev).
const DEFAULT_ENDPOINT = "https://app.figs.so"

const repoDir = join(process.cwd(), ".figs")
const globalDir = join(homedir(), ".figs")
const globalCreds = join(globalDir, "credentials.json")
const cmd = process.argv[2] ?? "help"
const JSON_OUT = process.argv.includes("--json")
const WANTS_HELP = process.argv.slice(2).some((a) => a === "-h" || a === "--help")

/**
 * Command registry — single source for dispatch, `figs help`, and per-command
 * flag validation. `flags` lists the flags a command accepts (beyond the global
 * `-h`/`--help`); an unrecognized flag is rejected rather than silently ignored.
 */
const COMMANDS = {
  status: {
    args: "[--json]",
    flags: ["--json"],
    desc: "show login / workspace / agent state",
    eg: "figs status --json",
  },
  login: {
    args: "[<token>]",
    flags: [],
    desc: "log in — browser device-flow, or save a pasted token",
    more: [
      "no arg → device flow: opens a browser for a human to approve (you never see the token).",
      "<token> → save a token you already have to ~/.figs/credentials.json.",
    ],
    eg: "figs login",
  },
  logout: { args: "", flags: [], desc: "remove the locally-saved token (~/.figs/credentials.json)" },
  init: {
    args: "",
    flags: [],
    desc: "scaffold .figs/ here — purely local, no account needed (identity + charter/contract/guide)",
    more: [
      "Zero flags, zero network: mints a stable agent id into config.json and scaffolds",
      "the templates. You're fully operational locally from here — record runs/asks/answers,",
      "validate, navigate. `figs link` later when you want it on the hosted app.",
      "Idempotent: re-running keeps your identity AND any link (never unlinks), and never",
      "clobbers an existing agent.json / CONTRACT.md / GUIDE.md / outbox.",
    ],
    eg: "figs init",
  },
  link: {
    args: "[--workspace <slug-or-id>] [--endpoint <url>]",
    flags: ["--workspace", "--endpoint"],
    desc: "connect this .figs/ to a workspace on the hosted app (so `figs push` can publish)",
    more: [
      "Bare: lists your workspaces (needs login); with exactly one, links it outright.",
      "--workspace takes a slug (resolved via the API — needs login) or a raw UUID (no login",
      "needed; get it from the app). --endpoint overrides the destination (default app.figs.so).",
      "Verifies the workspace when you're logged in; a UUID set while logged out is accepted",
      "but unverified until your first `figs push`. Writes endpoint + workspaceId into config.json.",
      "To unlink, delete those two fields from .figs/config.json (your identity + work stay).",
    ],
    eg: "figs link --workspace acme-corp",
  },
  report: {
    args: "--result <text> [options]",
    flags: [
      "--result", "--id", "--unit", "--period", "--status", "--trigger", "--attach", "--no-push",
    ],
    desc: "settle a job — stamps id/ts/state into runs.jsonl (auto-pushes when linked)",
    more: [
      "One run = one JOB — a unit of work your manager would recognize; the runs",
      "list reads as the job list. Give a job a stable, meaningful --id",
      "(recon-acme-2026-11); reporting the same id again folds onto that job's row",
      "(progress evolves: blocked → ok). Sittings/sessions never mint runs —",
      "stopping to wait for a human is not a job.",
      "A report SETTLES the job (state: settled). A job that outlives a sitting",
      "should open with `figs checkpoint` first; a report with no prior checkpoint",
      "is simply a job born settled (the single-sitting case).",
      "--trigger '<what set this sitting in motion>' — state it in a fresh sitting",
      "('monthly close cron', 'Wayne, in chat'); omit when continuing one.",
      "You supply the content; the CLI does the bookkeeping (id, real-clock ts,",
      "validation, artifact copy, push).",
      "Single-quote prose values ('…') — inside double quotes your shell expands $,",
      "so \"($4,474.63)\" reaches figs as \"(,474.63)\": silent corruption.",
      "--attach <file> (repeatable) pins a file to this moment (attachments[]) —",
      "rendered types (html/md/txt/json/images) show inline; data/docs (csv/pdf/xlsx/docx) download.",
      "--no-push writes locally only; `figs push` publishes later.",
      "Closing an ask is `figs close` — a close is not a job; never report one.",
      "Hand-writing runs.jsonl works too — this verb is sugar over the same file.",
    ],
    eg: "figs report --id recon-acme-2026-11 --result '88% matched · 31 flagged' --attach ./acme-2025-11.html",
  },
  checkpoint: {
    args: "--id <job> --note <text> [options]",
    flags: [
      "--id", "--note", "--trigger", "--status", "--unit", "--period", "--attach", "--no-push",
    ],
    desc: "save a job's progress mid-flight — marks it in-flight (auto-pushes when linked)",
    more: [
      "Your first checkpoint OPENS the job (state: in-flight) — make it the first",
      "act of any job that will outlive this sitting: say what triggered it",
      "(--trigger) and what you're setting out to do (--note). If you die mid-job,",
      "the checkpoint is what the next session finds in `figs inbox`; without one,",
      "the job never existed anywhere.",
      "Checkpoint at MANAGER grain — a step a human would recognize ('statements",
      "pulled — matching now'), never per tool call.",
      "--note is the job's current one-line state; it shows on the job's row and",
      "evolves with each fold. --status still carries the outcome look (a stuck",
      "job is --status warn — in-flight and warn are independent).",
      "`figs report --id <same-id>` settles the job when it's done — including",
      "abandoning it (--status warn --result 'abandoned — superseded by …').",
      "A checkpoint isn't a checkpoint until it's pushed — this verb pushes itself.",
    ],
    eg: "figs checkpoint --id recon-acme-2026-11 --note 'Statements pulled — matching now' --trigger 'monthly close cron'",
  },
  ask: {
    args: "<type> --title <text> [options]",
    flags: [
      "--id", "--title", "--need", "--found", "--option", "--on-approve", "--detail",
      "--attach", "--to", "--unit", "--run", "--stdin", "--no-push",
    ],
    desc: "raise an ask — a self-contained line in asks.jsonl (auto-pushes when linked)",
    more: [
      "<type> = the answer contract: question (give me an answer) ·",
      "sign-off (give me a verdict). Two types — the type IS the contract.",
      "Two strangers read every ask — a human deciding, a future session acting;",
      "the record must carry everything both need: --found (what you saw), --need",
      "(what you need), --option (repeatable; short, stable, quotable — answers cite",
      "one verbatim; the option is the label, context goes in --found/--detail),",
      "--detail 'Label=Value' (repeatable), --attach <file> (repeatable; a verdict",
      "blesses what the ask carries — attach the exact content for review + a brief:",
      "what to do once approved and what it requires).",
      "On a sign-off, --option entries are answer paths — the human's verdict can",
      "cite one verbatim ('Approved — file the 15 ready charges') — and",
      "--on-approve '<step>' (repeatable, ordered; sign-off only) states what",
      "approval sets in motion: an approval authorizes exactly the steps you stated.",
      "Flag anything irreversible in the step itself.",
      "--run <run-id> links the run this came out of — explicit id only (other",
      "sessions may report concurrently; `figs report` prints the id it wrote).",
      "--stdin reads a full JSON object instead of flags (long texts; attachments still via --attach).",
      "Single-quote prose values ('…') — double quotes let your shell eat $ amounts.",
    ],
    eg: "figs ask sign-off --title 'Send 10 payment reminders' --attach ./previews.html --on-approve 'Send the 10 reminder emails' --on-approve 'Mark the invoices chased' --run recon-2026-06",
  },
  answer: {
    args: "<ask-id> --by <who> (--chosen <option> | --text <reply> | --approve | --request-changes | --reject)",
    flags: [
      "--by", "--chosen", "--text", "--approve", "--request-changes", "--reject", "--no-push",
    ],
    desc: "record your human's out-of-band reply to an ask, verbatim (you run this, not them)",
    more: [
      "Humans don't type commands. They answer you in chat ('approved — only the 15');",
      "you transcribe that into the record. --by names the HUMAN who said it, not you.",
      "question → --chosen '<option verbatim>' (checked against the ask's options) or",
      "--text '<what they said>'. sign-off → --approve | --request-changes | --reject",
      "(a qualified verdict may also carry --chosen). Transcribe verbatim — never summarize,",
      "never author the reply yourself.",
      "Replies made IN the app sync down automatically (figs inbox) — `figs answer` is only",
      "for replies that exist nowhere but your chat.",
      "Then act, and `figs close <ask-id>` — it cites this reply automatically.",
    ],
    eg: "figs answer acme-bridge --chosen 'Strip the alpha prefix' --by 'Sarah (accounting)'",
  },
  inbox: {
    args: "[<ask-id>] [--json] [--no-sync]",
    flags: ["--json", "--no-sync"],
    desc: "what needs you — your humans' replies on your asks + your unfinished jobs (pure read)",
    more: [
      "Start every session with this. Bare: lists every ask with thread activity —",
      "answers and verdicts verbatim, plus the exact next command for each.",
      "With an ask id: the full handoff package — the ask, the whole thread, and its",
      "attached artifacts.",
      "Scope: THIS agent's open asks + their replies + unfinished jobs (in-flight runs).",
      "When linked, a soft messages-only down-sync runs first (degrades loudly, never blocks;",
      "--no-sync to skip). Reads only — recording a chat reply is figs answer; closing is figs close.",
    ],
    eg: "figs inbox",
  },
  show: {
    args: "<ask-id|job-id> [--json]",
    flags: ["--json"],
    desc: "magnify one ask or job — the folded record + its thread/trail + attachments (pure local)",
    more: [
      "Auto-detects an ask (shows the reply thread) or a job (shows its checkpoint trail).",
      "Reads local files and folds them for you — no raw-JSONL spelunking. No network:",
      "an attachment not on this machine is noted (view it in the app), never downloaded.",
    ],
    eg: "figs show acme-bridge",
  },
  close: {
    args: "<ask-id> [--note <text>] [--run <run-id>] [--attach <file>] [--withdrawn]",
    flags: [
      "--note", "--run", "--attach", "--withdrawn", "--no-push",
      // accepted-but-removed: handled with a teaching error pointing to the new path
      "--chosen", "--by", "--answer-id", "--rejected",
    ],
    desc: "close an ask — derives the close from the reply on file and cites it",
    more: [
      "A pure close: it reads the newest reply for the ask (recorded by `figs answer`",
      "or synced from the app) and derives the outcome — resolved on an answer/approval,",
      "rejected on a reject verdict; it refuses if nothing's answered yet, or if changes",
      "were requested (revise and re-raise on the same id instead).",
      "--run <run-id> links the JOB the reply set in motion (so a reader sees what you did).",
      "--withdrawn = YOU retracted the ask (no reply needed; nobody acted).",
      "After an answer, fork on what it unlocked: nothing new → close right away;",
      "real work → do the job, `figs report` it under its own id, then close --run <that id>.",
    ],
    eg: "figs close acme-bridge --run apply-bridge-2026-06",
  },
  doctor: {
    args: "",
    flags: ["--json"],
    desc: "validate .figs/ against the spec without pushing — the conformance check for hand-authored or non-CLI setups",
  },
  push: {
    args: "",
    flags: ["--rename"],
    desc: "publish .figs/ — spine to /api/ingest, artifacts to /api/artifacts",
    more: [
      "Idempotent (records fold by id). Exits non-zero if an artifact upload is rejected.",
      "The writing verbs (report/ask/resolve) call this automatically — you only need it",
      "after hand-editing files, after --no-push, or to retry a failed auto-push.",
      "--rename: confirm a genuine name change on an already-registered agent (one",
      "time). The server refuses a name that doesn't match the registered one — it's",
      "the fingerprint of a copied folder; if that's what happened, rotate identity",
      "instead with `rm -rf .figs && figs init`, don't --rename.",
    ],
    eg: "figs push",
  },
  version: {
    args: "[--check]",
    flags: ["--check"],
    desc: "print the CLI version (offline); --check also asks the server for updates",
  },
  help: { args: "[<command>]", flags: [], desc: "show this help, or detailed help for one command" },
}

/** Reject unknown flags for a command (don't silently ignore an agent's typo). */
function checkFlags(name) {
  const allowed = new Set([...(COMMANDS[name].flags ?? []), "-h", "--help"])
  for (const tok of process.argv.slice(3)) {
    if (tok.startsWith("-") && tok !== "-" && tok !== "--") {
      const f = tok.split("=")[0]
      if (!allowed.has(f)) {
        die(`unknown flag "${f}" for \`figs ${name}\` — run \`figs ${name} --help\``)
      }
    }
  }
}

function die(msg) {
  console.error(`figs: ${msg}`)
  process.exit(1)
}
function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback
}
/**
 * The one `--json` envelope for read verbs: `{ ok, data, warnings }`. Uniform
 * so an agent parses every read the same way and can branch on `ok` and surface
 * `warnings` (e.g. a degraded sync) without scraping stderr.
 */
function printJson(data, { ok = true, warnings = [] } = {}) {
  console.log(JSON.stringify({ ok, data, warnings }, null, 2))
}
/** Read a flag value — supports both `--name value` and `--name=value`. */
function flag(name) {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return undefined
}
/** All values of a repeatable flag, in order. */
function flagAll(name) {
  const args = process.argv.slice(2)
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1])
    else if (args[i].startsWith(`${name}=`)) out.push(args[i].slice(name.length + 1))
  }
  return out
}
/** Boolean flag — present or not (takes no value). */
function hasFlag(name) {
  return process.argv.slice(2).includes(name)
}
/** First non-flag token after the command (e.g. the ask type, the ask id). */
function positional() {
  const args = process.argv.slice(3)
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      // skip `--name value` pairs (but not `--name=value` or booleans)
      if (!args[i].includes("=") && !BOOLEAN_FLAGS.has(args[i])) i++
      continue
    }
    return args[i]
  }
  return undefined
}
const BOOLEAN_FLAGS = new Set([
  "--no-push", "--stdin", "--withdrawn", "--rejected", "--json", "-h", "--help",
])

/** ISO-8601 with the machine's real UTC offset (never the agent's guess). */
function nowIso() {
  const d = new Date()
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0")
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    (off === 0 ? "Z" : `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`)
  )
}
/** Generated unique id — stable/content-derived ids only via explicit --id. */
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

// ---------- local validation (the spec's common mistakes, caught on write) ----
// The server's schema stays the source of truth; these catch what hand-authors
// and flag typos get wrong, with errors that teach the fix.
// Two types = two answer contracts, and the type IS the contract:
//   question → answer (an option or free text) · sign-off → verdict.
// History (all pre-launch, free to break): "blocked" folded into the type that
// became "question" (a stuck JOB is the run's status, not an ask type);
// "needs-decision" was renamed to "question" (1.0); "fyi" was retired (1.0) — a
// for-the-record note is a settled report, not an ask.
const ASK_TYPES = ["question", "sign-off"]
const RUN_STATUSES = ["ok", "warn", "fail"]
// Lifecycle, orthogonal to status (outcome): checkpoint stamps in-flight,
// report stamps settled. Absent = settled (a plain report is a complete fact).
const RUN_STATES = ["in-flight", "settled"]
const ASK_STATUSES = ["open", "resolved", "withdrawn", "rejected"]
const TO_VALUES = ["manager", "builder"]
// Two render classes. RENDERABLE shows inline in the sandboxed viewer;
// DOWNLOAD_ONLY (data/docs — back-office work products) is offered as a
// download, never rendered (lower risk than HTML rendering — nothing executes).
const RENDERABLE_EXTS = [".html", ".md", ".txt", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
const DOWNLOAD_ONLY_EXTS = [".csv", ".pdf", ".xlsx", ".xls", ".docx"]
const ARTIFACT_EXTS = new Set([...RENDERABLE_EXTS, ...DOWNLOAD_ONLY_EXTS])
const ARTIFACT_MAX = 10 * 1024 * 1024

/** "signoff" → `did you mean "sign-off"?` — normalized nearest match. */
function didYouMean(value, allowed) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "")
  const hit = allowed.find((a) => norm(a) === norm(value))
  return hit ? ` — did you mean "${hit}"?` : ` (valid: ${allowed.join(" · ")})`
}
function checkEnum(issues, obj, field, allowed, label) {
  const v = obj[field]
  if (v !== undefined && !allowed.includes(v)) {
    issues.push(`${label}.${field}: "${v}" isn't valid${didYouMean(v, allowed)}`)
  }
}
/** Validate one folded run record → array of issue strings. */
function validateRun(r) {
  const issues = []
  const label = `run "${r.id ?? "?"}"`
  if (!r.id || typeof r.id !== "string") issues.push(`${label}: missing required "id"`)
  if (!r.ts) issues.push(`${label}: missing required "ts" (ISO-8601 — \`figs report\` stamps it for you)`)
  checkEnum(issues, r, "status", RUN_STATUSES, label)
  checkEnum(issues, r, "state", RUN_STATES, label)
  checkAttachments(issues, r, label)
  return issues
}
/** attachments[] is the unified field (bare file names). The legacy run
 *  `artifact`/`artifacts` and ask `refs` are still READ (attachmentsOf), so we
 *  only type-check them here for back-compat; new writes use attachments[]. */
function checkAttachments(issues, obj, label) {
  if (obj.attachments !== undefined && (!Array.isArray(obj.attachments) || obj.attachments.some((a) => typeof a !== "string"))) {
    issues.push(`${label}.attachments: must be an array of file names`)
  }
  if (obj.artifact !== undefined && typeof obj.artifact !== "string") {
    issues.push(`${label}.artifact: legacy field — use attachments[] (an array of file names)`)
  }
  if (obj.artifacts !== undefined && (!Array.isArray(obj.artifacts) || obj.artifacts.some((a) => typeof a !== "string"))) {
    issues.push(`${label}.artifacts: legacy field — use attachments[] (an array of file names)`)
  }
}
/** Validate one folded ask record → array of issue strings. */
function validateAsk(a) {
  const issues = []
  const label = `ask "${a.id ?? "?"}"`
  if (!a.id || typeof a.id !== "string") issues.push(`${label}: missing required "id"`)
  if (!a.type) {
    issues.push(
      `${label}: missing required "type" — was it raised on another machine? (closing it from here needs the full record; cross-machine fetch is coming)`,
    )
  } else if (a.type === "blocked") {
    issues.push(
      `${label}.type: "blocked" isn't an ask type — a stuck job is the RUN's status (re-report --status onto the same job id); what you need from a human is a "question"`,
    )
  } else if (a.type === "needs-decision") {
    issues.push(
      `${label}.type: "needs-decision" was renamed to "question" (the type is the answer contract: question → answer · sign-off → verdict)`,
    )
  } else if (a.type === "fyi") {
    issues.push(
      `${label}.type: "fyi" was retired — a for-the-record note is a settled report (\`figs report\`), not an ask; if you actually need a human it's a "question" or "sign-off"`,
    )
  } else checkEnum(issues, a, "type", ASK_TYPES, label)
  if (!a.title) issues.push(`${label}: missing required "title"`)
  checkEnum(issues, a, "status", ASK_STATUSES, label)
  checkEnum(issues, a, "to", TO_VALUES, label)
  if (a.options !== undefined && (!Array.isArray(a.options) || a.options.some((o) => typeof o !== "string"))) {
    issues.push(`${label}.options: must be an array of short, quotable strings`)
  }
  if (a.onApprove !== undefined) {
    if (!Array.isArray(a.onApprove) || a.onApprove.some((s) => typeof s !== "string")) {
      issues.push(`${label}.onApprove: must be an array of strings — the ordered steps approval sets in motion`)
    } else if (a.type !== "sign-off") {
      issues.push(
        `${label}.onApprove: sign-off only — it is the approval contract; a ${a.type ?? "non-sign-off ask"} has no approval (the chosen option carries the next step)`,
      )
    }
  }
  if (a.details !== undefined && (!Array.isArray(a.details) || a.details.some((d) => !d || typeof d.l !== "string"))) {
    issues.push(`${label}.details: must be [{ "l": "Label", "v": "Value" }]`)
  }
  if (a.refs !== undefined && (!Array.isArray(a.refs) || a.refs.some((r) => !r || typeof r.label !== "string"))) {
    issues.push(`${label}.refs: legacy field — use attachments[] (an array of file names)`)
  }
  checkAttachments(issues, a, label)
  return issues
}
// ---------- messages.jsonl — the human ledger -------------------------------
// Human replies to asks: answers + verdicts (later: note/directive). Events,
// not records — immutable, ids minted once, they accumulate (no fold). `source`
// is *where* a reply arrived, display only — the verified grade comes from mint
// origin (server-minted = attested; pushed-up = transcription), never `source`.
const MSG_KINDS = ["answer", "verdict"]
const VERDICTS = ["approved", "changes-requested", "rejected"]
const MSG_SOURCES = ["app", "chat"]
/** Validate one message event → array of issue strings. */
function validateMessage(m) {
  const issues = []
  const label = `message "${m.id ?? "?"}"`
  if (!m.id || typeof m.id !== "string") issues.push(`${label}: missing required "id"`)
  if (!m.ask || typeof m.ask !== "string") issues.push(`${label}: missing required "ask" (the ask id this replies to)`)
  if (!m.ts) issues.push(`${label}: missing required "ts"`)
  if (!m.by) issues.push(`${label}: missing required "by" (who said it — the human, not you)`)
  checkEnum(issues, m, "kind", MSG_KINDS, label)
  checkEnum(issues, m, "verdict", VERDICTS, label)
  checkEnum(issues, m, "source", MSG_SOURCES, label)
  if (m.kind === "verdict" && !m.verdict) {
    issues.push(`${label}: a verdict message needs "verdict" (${VERDICTS.join(" / ")})`)
  }
  if (m.kind === "answer" && !m.chosen && !m.text) {
    issues.push(`${label}: an answer needs "chosen" or "text"`)
  }
  return issues
}

/** Validate the whole local outbox (folded records + message events). */
function validateOutbox(runs, asks, messages = []) {
  return [
    ...runs.flatMap(validateRun),
    ...asks.flatMap(validateAsk),
    ...messages.flatMap(validateMessage),
  ]
}
/** Does an ask with this id exist locally — raised here, or known via a message? */
function askExistsLocally(askId) {
  return (
    foldById(readJsonl("asks.jsonl")).some((a) => a.id === askId) ||
    readJsonl("messages.jsonl").some((m) => m.ask === askId)
  )
}
function resolveEndpoint() {
  const cfg = readJson(join(repoDir, "config.json"), {})
  return (process.env.FIGS_ENDPOINT || cfg.endpoint || DEFAULT_ENDPOINT).replace(
    /\/+$/,
    "",
  )
}
// ---------- credentials, keyed by endpoint origin --------------------------
// One token per endpoint origin so a prod token is never sent to a localhost
// dev endpoint (the old single-token file's real bug) and prod + dev can coexist.
// File shape: { "https://app.figs.so": { "token": "…" }, … }. The pre-1.0 shape
// was a bare { "token": "…" } — migrated on read to the default endpoint.
/** Canonical origin (scheme://host:port, no path/trailing slash) of a URL. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return String(url).replace(/\/+$/, "")
  }
}
/** Load the credentials file, migrating the legacy bare-token shape in memory. */
function loadCreds() {
  const raw = readJson(globalCreds, {})
  if (typeof raw.token === "string") {
    // Legacy single token — it was always the default endpoint's.
    return { [originOf(DEFAULT_ENDPOINT)]: { token: raw.token } }
  }
  return raw
}
function getToken() {
  return process.env.FIGS_TOKEN || loadCreds()[originOf(resolveEndpoint())]?.token
}

// ---------- the state model -------------------------------------------------
// Two orthogonal facts: local-vs-linked (does config declare a workspace?) and
// authenticated (is there a token?). The rule: the config declares intent; the
// CLI errors only when declared intent can't be met. A local repo (no
// workspaceId) is a deliberate, first-class state — never an error.

/** Linked = config declares a destination workspace (intent to publish). */
function isLinked() {
  return Boolean(readJson(join(repoDir, "config.json"), {}).workspaceId)
}

// Exit codes: 0 = recorded (and published, if linked) · 1 = nothing written
// (fix the input) · 2 = recorded locally, publish failed (retry `figs push`,
// never re-run the verb). The canonical exit-2 line below is what an agent keys
// on — the number inverts some CLI priors, so the words carry the contract.
const RECORDED_LOCALLY =
  "recorded locally — do NOT re-run this verb; `figs push` retries"

/**
 * When there's no `.figs/` in cwd, peek UPWARD (read-only) for a parent agent's
 * folder so we can tell the agent where it is — but never adopt that identity.
 * The fleet topology forbids walk-up: an openfigs fleet has the recruiter's
 * `.figs/` at the root and each employee's own `.figs/` in its folder; silently
 * using the parent would make a child agent report as the recruiter. Bounded;
 * stops at the filesystem root.
 */
function peekParentFigs() {
  let dir = join(process.cwd(), "..")
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".figs"))) {
      return { dir, name: readJson(join(dir, ".figs", "agent.json"), {})?.name }
    }
    const parent = join(dir, "..")
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return null
}
/** The "no .figs/ here" message — points at a parent if one exists, never uses it. */
function noFigsHint() {
  const p = peekParentFigs()
  if (p) {
    return `no .figs/ here, but found one at ${p.dir}${p.name ? ` (agent: ${p.name})` : ""} — if you ARE that agent, cd there; if you're a different agent, run \`figs init\` at YOUR root`
  }
  return "no .figs/ here — run `figs init` first"
}

/**
 * Auth headers for a token. Standard `Authorization: Bearer` is the contract;
 * we ALSO send the legacy `x-figs-token` through the transition so a 1.0 CLI
 * works against an app that hasn't shipped Bearer yet. Drop `x-figs-token` here
 * once the app requires Bearer (next MIN_CLI bump).
 */
function authHeaders(token) {
  if (!token) return {}
  return { authorization: `Bearer ${token}`, "x-figs-token": token }
}

const REQUEST_TIMEOUT_MS = 30000
const SYNC_TIMEOUT_MS = 5000 // session-start sync degrades fast, never blocks
/** `fetch` with a hard timeout so a hung server never stalls the agent. */
async function fetchT(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}
/** Human reason for a thrown fetch error (timeout vs. network). */
function netReason(e) {
  if (e?.name === "AbortError") return `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
  return e?.cause?.code || e?.code || e?.message || "network error"
}
/** Low-level request — returns { ok, status, data }, never throws/exits. */
async function request(method, path, body, token = getToken()) {
  const base = resolveEndpoint()
  let res
  try {
    res = await fetchT(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    // Unreachable host / DNS / timeout — degrade, don't crash.
    return { ok: false, status: 0, data: { error: `cannot reach ${base} (${netReason(e)})` } }
  }
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  return { ok: res.ok, status: res.status, data }
}
/** Authenticated request that exits with a clear message on failure. */
async function api(method, path, body) {
  if (!getToken()) die("not logged in — run `figs login` (or set FIGS_TOKEN)")
  const r = await request(method, path, body)
  if (!r.ok) die(`${path} failed (${r.status}): ${r.data.error ?? r.data.raw ?? ""}`)
  return r.data
}

/**
 * Compare two semver strings → -1 | 0 | 1, or **null** if either is unparseable.
 * Returning null (rather than guessing) lets the caller skip the check instead of
 * failing closed on a malformed server-provided version — a bad `min` must never
 * lock an agent out of pushing.
 */
function cmpSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10))
  const pb = String(b).split(".").map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return null
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
/**
 * Cached (daily) compatibility check — off the hot path. `hardFail` exits when
 * below the server's compatible `min`. Network failure is ignored (never blocks
 * on a transient outage).
 */
async function checkVersion({ force = false, hardFail = false } = {}) {
  const cachePath = join(globalDir, "version-check.json")
  let info = readJson(cachePath, {})
  const stale = !info.checkedAt || Date.now() - info.checkedAt > 86400000
  if (force || stale) {
    const r = await request("GET", "/api/version")
    if (r.ok) {
      info = { ...r.data, checkedAt: Date.now() }
      try {
        mkdirSync(globalDir, { recursive: true })
        writeFileSync(cachePath, JSON.stringify(info, null, 2) + "\n")
      } catch {
        /* cache best-effort */
      }
    }
  }
  const min = info?.cli?.min
  // cmpSemver returns null on an unparseable version → skip (never fail closed).
  if (min && cmpSemver(VERSION, min) === -1) {
    const msg = `figs CLI ${VERSION} is below the minimum ${min} — upgrade: npx @figs-so/cli@latest`
    if (hardFail) die(msg)
    console.warn(`figs: ! ${msg}`)
  }
}

/** `figs help [cmd]` — top-level usage, or one command's detail. */
function printHelp(name) {
  const pad = 36
  if (name && name !== "-h" && name !== "--help") {
    const c = COMMANDS[name]
    if (!c) {
      console.log(`figs: no such command "${name}"\n`)
      return printHelp()
    }
    console.log(`Usage: figs ${name}${c.args ? " " + c.args : ""}\n`)
    console.log(`  ${c.desc}`)
    if (c.more) for (const line of c.more) console.log(`  ${line}`)
    if (c.eg) console.log(`\n  e.g.  ${c.eg}`)
    return
  }
  console.log("figs — your AI agent's work journal; report it to humans at https://figs.so\n")
  console.log("Usage: figs <command> [options]\n")
  // Grouped by layer so the local-first model is legible in the help itself:
  // LOCAL works with no account; CONNECTED needs a one-time login + a workspace.
  const LOCAL = ["init", "report", "checkpoint", "ask", "answer", "inbox", "show", "close", "doctor", "status", "version", "help"]
  const CONNECTED = ["login", "logout", "link", "push"]
  const printGroup = (title, names) => {
    console.log(title)
    for (const n of names) {
      const c = COMMANDS[n]
      if (c) console.log(`  ${`${n} ${c.args}`.trim().padEnd(pad)} ${c.desc}`)
    }
  }
  printGroup("Local (no account needed):", LOCAL)
  console.log("")
  printGroup("Connected (one-time login + a workspace):", CONNECTED)
  console.log("\nGlobal flags:")
  console.log(`  ${"-h, --help".padEnd(pad)} show help (or \`figs help <command>\`)`)
  console.log(`  ${"-v, --version".padEnd(pad)} print the CLI version`)
  console.log("\nEnvironment:")
  console.log(`  ${"FIGS_ENDPOINT".padEnd(pad)} override the API endpoint (e.g. http://localhost:3000)`)
  console.log(`  ${"FIGS_TOKEN".padEnd(pad)} use this token instead of ~/.figs/credentials.json`)
  console.log(`\nEndpoint: ${resolveEndpoint()}`)
  console.log(`Guide:    ${resolveEndpoint()}/llms.txt`)
}

if (cmd === "help" || cmd === "-h" || cmd === "--help") printHelp(process.argv[3])
else if (cmd === "version" || cmd === "--version" || cmd === "-v" || cmd === "-V") {
  // Offline by default — printing your own version must never need the network
  // (contract: no network on the hot path of a local verb). `--check` opts in.
  console.log(VERSION)
  if (hasFlag("--check")) await checkVersion({ force: true })
} else if (WANTS_HELP) printHelp(cmd)
else if (COMMANDS[cmd]) {
  checkFlags(cmd) // reject unknown flags before running
  if (cmd === "login") await login(process.argv[3])
  else if (cmd === "logout") logout()
  else if (cmd === "status") await status()
  else if (cmd === "init") await init()
  else if (cmd === "link") await link()
  else if (cmd === "report") await reportCmd()
  else if (cmd === "checkpoint") await checkpointCmd()
  else if (cmd === "ask") await askCmd()
  else if (cmd === "answer") await answerCmd()
  else if (cmd === "inbox") await inboxCmd()
  else if (cmd === "show") await showCmd()
  else if (cmd === "close") await closeCmd()
  else if (cmd === "doctor") await doctor()
  else if (cmd === "push") await push()
} else {
  console.error(`figs: unknown command "${cmd}" — run \`figs help\` for usage`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
function saveToken(token) {
  // Key the token under the endpoint origin we're logging into; preserve tokens
  // for other origins (migrating the legacy shape in the process).
  const creds = loadCreds()
  creds[originOf(resolveEndpoint())] = { token }
  // A bearer token must not be group/other-readable: dir 0700, file 0600.
  mkdirSync(globalDir, { recursive: true, mode: 0o700 })
  writeFileSync(globalCreds, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 })
  // Enforce perms even if the dir/file pre-existed with looser modes (mode on
  // write only applies at creation).
  try {
    chmodSync(globalDir, 0o700)
    chmodSync(globalCreds, 0o600)
  } catch {
    /* best-effort — non-POSIX filesystems */
  }
}

// Best-effort: pop the approval page in the user's default browser so they only
// have to click Approve. Silent no-op when it can't (headless / remote / CI) —
// the link is always printed above as the fallback. Detached + unref'd so it
// never blocks or ties the polling loop to the browser process.
function openBrowser(url) {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]]
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => {}) // swallow ENOENT / no opener available
    child.unref()
  } catch {
    /* ignore — the printed link is the fallback */
  }
}

/**
 * `figs login` → device flow: opens the approval page in the user's browser
 * (the printed link is the fallback); the human clicks Approve and the agent
 * never handles the token. `figs login <token>` → save a pasted token (fallback).
 */
async function login(token) {
  if (token) {
    saveToken(token)
    console.log("figs: ✓ token saved to ~/.figs/credentials.json")
    return
  }

  const start = await request("POST", "/api/device/start")
  if (!start.ok) die(`could not start login (${start.status})`)
  const d = start.data
  console.log("figs: opening your browser to approve this CLI — just click Approve there.")
  console.log(`        if it doesn't open, visit: ${d.verification_uri_complete}`)
  console.log(`        (or go to ${d.verification_uri} and enter code: ${d.user_code})`)
  openBrowser(d.verification_uri_complete)
  console.log("figs: waiting for approval…")

  const deadline = Date.now() + (d.expires_in ?? 600) * 1000
  const wait = (d.interval ?? 5) * 1000
  while (Date.now() < deadline) {
    await sleep(wait)
    const r = await request("POST", "/api/device/poll", { device_code: d.device_code })
    const status = r.data?.status
    if (status === "approved" && r.data.token) {
      saveToken(r.data.token)
      console.log("figs: ✓ authorized — token saved to ~/.figs/credentials.json")
      console.log("figs: next — run `figs init` to scaffold .figs/ here")
      return
    }
    if (status === "denied") die("authorization denied")
    if (status === "expired") die("code expired — run `figs login` again")
    if (status === "already_claimed") {
      die("this login was already completed (on another run) — run `figs status` to check; re-run `figs login` if no token was saved")
    }
    if (status === "not_found") die("login code not found — run `figs login` again")
    // pending → keep polling
  }
  die("timed out waiting for approval — run `figs login` again")
}

/**
 * `figs logout` — remove the locally-saved token (`~/.figs/credentials.json`).
 * This only clears *this machine's* copy; the token still exists server-side
 * until you revoke it in Settings. A token supplied via the FIGS_TOKEN env var
 * can't be removed here (unset the env var to fully log out).
 */
function logout() {
  const origin = originOf(resolveEndpoint())
  const creds = loadCreds()
  if (creds[origin]) {
    delete creds[origin]
    try {
      if (Object.keys(creds).length) {
        writeFileSync(globalCreds, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 })
      } else if (existsSync(globalCreds)) {
        rmSync(globalCreds) // nothing left — remove the file entirely
      }
    } catch (e) {
      die(`could not update ${globalCreds}: ${e?.message || e}`)
    }
    console.log(`figs: ✓ logged out of ${origin} (other endpoints' tokens, if any, are kept)`)
  } else {
    console.log(`figs: not logged in to ${origin} — nothing to remove`)
  }
  if (process.env.FIGS_TOKEN) {
    console.warn(
      "figs: ! FIGS_TOKEN is still set in your environment — `unset FIGS_TOKEN` to fully log out",
    )
  }
  console.log(
    `        the token still exists server-side — revoke it at ${resolveEndpoint()}/settings`,
  )
}

/** Show where setup stands — login, workspace, charter. Drives the agent's next step. */
async function status() {
  const token = getToken()
  const cfg = readJson(join(repoDir, "config.json"), null)
  const hasAgent = existsSync(join(repoDir, "agent.json"))
  const hasContract = existsSync(join(repoDir, "CONTRACT.md"))
  const endpoint = resolveEndpoint()

  let loggedIn = false
  let list = null
  let account = null
  let unreachable = false
  if (token) {
    const r = await request("GET", "/api/workspaces", null, token)
    loggedIn = r.ok
    unreachable = r.status === 0
    if (r.ok) {
      list = r.data.workspaces ?? []
      account = r.data.user ?? null // null on a pre-account server
    }
  }

  const linked = Boolean(cfg?.workspaceId)

  if (JSON_OUT) {
    return printJson({
      version: VERSION,
      mode: linked ? "linked" : "local",
      endpoint,
      loggedIn,
      account: account ? { id: account.id, email: account.email, name: account.name } : null,
      workspaces: list?.map((w) => ({ id: w.id, name: w.name, role: w.role })),
      config: cfg ? { agentId: cfg.agentId, workspaceId: cfg.workspaceId ?? null } : null,
      agentJson: hasAgent,
      contractMd: hasContract,
    })
  }

  const row = (k, v) => console.log(`  ${(k + ":").padEnd(12)} ${v}`)
  console.log("figs status")
  row(
    "mode",
    linked
      ? "linked — publishes to the hosted app on push"
      : "local — fully operational offline; `figs link` to publish",
  )
  row(
    "logged in",
    loggedIn
      ? `yes (${list.length} workspace${list.length === 1 ? "" : "s"})`
      : unreachable
        ? `can't reach ${endpoint}`
        : token
          ? "token invalid — run `figs login`"
          : linked
            ? "no — run `figs login`, then `figs push`"
            : "no (not needed for local mode)",
  )
  if (loggedIn) {
    row(
      "account",
      account?.email
        ? `${account.email}${account.name ? ` (${account.name})` : ""}`
        : "—",
    )
  }
  row(
    "workspace",
    linked ? cfg.workspaceId : "none — `figs link` to connect one",
  )
  row("agent.json", hasAgent ? "present (identity)" : "missing — author .figs/agent.json")
  row(
    "contract",
    hasContract
      ? "present (activity) — follow it"
      : "none yet — Activity is optional, agree it with your user",
  )
  row("journal", "records live on this machine (the app is the durable record once linked)")
  row("endpoint", endpoint)
  row("cli", VERSION)
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(s),
  )
}

/**
 * A starter `agent.json` — written by `figs init` only when none exists. The
 * `<…>` values are placeholders the agent fills in by reading its own repo;
 * `figs doctor` refuses to bless a charter that still has them. `name` defaults
 * to the folder name (a sensible first guess), `id` is intentionally absent —
 * the CLI attaches the identity UUID from config.json on push.
 */
function agentJsonStub(name) {
  return (
    JSON.stringify(
      {
        name,
        role: "<one line — what you are>",
        status: "in_dev",
        mandate: "<one sentence — what you are accountable for>",
        org: { department: "<your team / department>" },
        runtime: "<what runs you, e.g. Claude Code>",
        cadence: "<on-demand · weekly · monthly · …>",
        responsibilities: ["<an area of work you own — list a few, or use steps>"],
        properties: [{ k: "<fact>", v: "<value>" }],
      },
      null,
      2,
    ) + "\n"
  )
}

/**
 * A starter CONTRACT — the going-live record, written by `figs init` only when
 * none exists. It's the agent↔user agreement, authored in the going-live
 * conversation (not mechanically). The `<…>` prompts are answered with the user.
 */
function contractStub(name) {
  return `# Contract — ${name} on Figs

The agreement between this employee and its humans: what counts as real work, what gets surfaced,
what's held back. **Author this WITH your user** in the going-live conversation (see the guide) —
not mechanically. Keep it honest and current.

> **Maintain:** edit when the work or the surfacing agreement changes.

## Fit
<are you a good fit? Figs is for recurring work a human wants to stay in the loop on. "Not yet,
because X" is a valid, honest answer.>

## What's a job (what I report)
- **A job is:** <the unit your manager would recognize — e.g. "one monthly reconciliation">
- **I checkpoint:** <the mid-flight steps a human would recognize, for jobs that outlive a sitting>
- **A job settles when:** <the headline result that means done>

## What I never surface
Raw user content — ever. Plus, for this agent: <anything sensitive to its domain>. Use
**de-identified labels** (\`<scope>-01\`), never customer or system names.

## Inbox cadence
<when do I process human replies? dedicated schedule (recommended) · spawned sweep · at session
start. How it's scheduled is a build concern (OpenFigs) + your user's call — record it here.>
`
}

/**
 * Find string values still left as `<…>` template placeholders, with their JSON
 * path. Used by `figs doctor` to block publishing a half-filled charter. Matches
 * a value that is *entirely* a placeholder (e.g. "<one line — what you are>") so
 * real content containing stray angle brackets isn't flagged.
 */
function findPlaceholders(obj) {
  const out = []
  const walk = (v, path) => {
    if (typeof v === "string") {
      if (/^<.*>$/.test(v.trim())) out.push({ path: path || "(root)", value: v })
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`))
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
    }
  }
  walk(obj, "")
  return out
}

/**
 * `figs link` — connect this `.figs/` to a workspace so `figs push` can publish.
 * The ONLY place remote config (endpoint + workspaceId) is written; `init` stays
 * purely local. `--workspace`:
 *  - a UUID → written as-is; verified when logged in, else "unverified until push".
 *  - a slug → resolved via the API (needs login).
 *  - omitted → list the user's workspaces (needs login); with exactly one, link it.
 * Identity (agentId) is preserved untouched.
 */
async function link() {
  if (!existsSync(repoDir)) die(noFigsHint())
  const config = readJson(join(repoDir, "config.json"), {})
  if (!config.agentId) die("config missing agentId — run `figs init` first")
  // Honor --endpoint, then FIGS_ENDPOINT (dev), then any existing config, then
  // the baked default — resolveEndpoint() encodes that precedence.
  const endpoint = (flag("--endpoint") || resolveEndpoint()).replace(/\/+$/, "")
  const wsArg = flag("--workspace")
  const token = getToken()

  let workspaceId
  if (wsArg && isUuid(wsArg)) {
    workspaceId = wsArg
    if (token) {
      // Verify access when we can; a network blip just defers it to first push.
      const r = await request("GET", "/api/workspaces", null, token)
      if (r.ok && !(r.data.workspaces ?? []).some((w) => w.id === wsArg)) {
        die(`workspace ${wsArg} isn't one you can access — run \`figs link\` (no flag) to list yours`)
      }
    } else {
      console.warn("figs: ! linked by UUID while logged out — unverified until your first `figs push`")
    }
  } else if (wsArg) {
    // A slug — only the server can map it to a UUID.
    if (!token) {
      die("resolving a workspace slug needs `figs login` first — or pass the workspace UUID (from the app's settings)")
    }
    const r = await request("GET", "/api/workspaces", null, token)
    if (!r.ok) die(`could not resolve workspace "${wsArg}" (${r.status || "network"}): ${r.data.error ?? r.data.raw ?? ""}`)
    const match = (r.data.workspaces ?? []).find((w) => w.slug === wsArg || w.id === wsArg)
    if (!match) die(`no workspace matching "${wsArg}" — run \`figs link\` (no flag) to list yours`)
    workspaceId = match.id
  } else {
    // Bare `figs link` — list; with exactly one, link it outright.
    if (!token) {
      die("run `figs login` first, then `figs link` to pick a workspace — or `figs link --workspace <uuid>` (no login needed)")
    }
    const r = await request("GET", "/api/workspaces", null, token)
    if (!r.ok) die(`could not list workspaces (${r.status || "network"}): ${r.data.error ?? r.data.raw ?? ""}`)
    const list = r.data.workspaces ?? []
    if (list.length === 0) die(`no workspaces yet — create one at ${endpoint}, then re-run \`figs link\``)
    if (list.length === 1) {
      workspaceId = list[0].id
      console.log(`figs: linking to ${list[0].slug} (${list[0].name})`)
    } else {
      console.log("figs: which workspace? re-run with one:")
      for (const w of list) console.log(`        figs link --workspace ${w.slug}   (${w.name})`)
      process.exit(1)
    }
  }

  // Preserve identity; write the destination. config.json shape when linked:
  // { agentId, endpoint, workspaceId }.
  writeFileSync(
    join(repoDir, "config.json"),
    JSON.stringify({ agentId: config.agentId, endpoint, workspaceId }, null, 2) + "\n",
  )
  console.log(`figs: ✓ linked — workspace ${workspaceId} @ ${endpoint}`)
  console.log("        next: `figs push` publishes everything recorded so far")
}

async function init() {
  // Purely local — `init` never touches the network, so it can never need an
  // account. Idempotent: keep the existing identity AND any link fields (a
  // re-init must NOT unlink), and never clobber an authored charter/contract/
  // guide or the outbox.
  const existing = readJson(join(repoDir, "config.json"), null)
  const agentId = existing?.agentId || randomUUID()
  mkdirSync(repoDir, { recursive: true })
  const config = { agentId }
  if (existing?.endpoint) config.endpoint = existing.endpoint
  if (existing?.workspaceId) config.workspaceId = existing.workspaceId
  writeFileSync(join(repoDir, "config.json"), JSON.stringify(config, null, 2) + "\n")

  const endpoint = resolveEndpoint()
  const created = []
  const ensure = (rel, contents) => {
    const p = join(repoDir, rel)
    if (existsSync(p)) return false
    writeFileSync(p, contents)
    created.push(rel)
    return true
  }
  ensure(
    ".gitignore",
    [
      "# Figs — commit config.json + agent.json + CONTRACT.md.",
      "# The journal below is a machine-local outbox: records live on this machine;",
      "# the hosted app is the durable record once you `figs link` + `figs push`.",
      "runs.jsonl",
      "asks.jsonl",
      "messages.jsonl",
      "artifacts/",
      "credentials.json",
      "",
    ].join("\n"),
  )
  const name = basename(process.cwd())
  const charterCreated = ensure("agent.json", agentJsonStub(name))
  ensure("CONTRACT.md", contractStub(name))
  ensure("runs.jsonl", "")
  ensure("asks.jsonl", "")
  ensure("messages.jsonl", "")
  mkdirSync(join(repoDir, "artifacts"), { recursive: true })

  console.log(`figs: ✓ .figs/ ready — you're operational locally (agentId ${agentId})`)
  if (created.length) console.log(`        scaffolded: ${created.join(", ")}`)
  if (charterCreated) {
    console.log(
      "        next: fill in .figs/agent.json — replace the <…> placeholders (`figs doctor` checks them)",
    )
  } else {
    console.log(
      "        your charter (.figs/agent.json) is already here — `figs doctor` to validate it",
    )
  }
  console.log(
    "        record work: `figs report` / `figs checkpoint` · raise asks: `figs ask` · recover: `figs inbox`",
  )
  console.log(
    `        publish to the hosted app (optional)${existing?.workspaceId ? " — already linked" : ": `figs link`"}, then \`figs push\``,
  )
  console.log(
    `        Anchor Figs in the file you load each session (CLAUDE.md/AGENTS.md/…): paste the figs:begin block from ${endpoint}/llms.txt.`,
  )
  console.log(
    "        Commit config.json + agent.json + CONTRACT.md; never commit credentials.json.",
  )
}

// ====================== the writing verbs ===================================
// report / checkpoint / ask / answer / close — sugar over the same files
// (hand-writing stays first-class). The agent supplies content; the CLI stamps
// id + real-clock ts, validates with teaching errors, copies attachments, then
// (when linked) invokes the same push as `figs push`.
//
// NOTE — no session auto-capture (removed in 0.5.0). The CLI used to infer a
// `session` trace (runtime/model/tokens) from "the newest transcript on this
// machine"; in nested/headless runs that stamped the WRONG runtime+model — a
// fabricated audit line (e.g. gpt-5.5 on a Claude Code run). A trace must be
// true or absent, never false, so inference is gone. The spec's optional
// `session` block remains legal for integrations that can copy provable values
// from the runtime's own records at work-time.

function requireFigs() {
  if (!existsSync(repoDir)) die(noFigsHint())
  const config = readJson(join(repoDir, "config.json"), {})
  // Identity is all a writing verb needs — workspaceId is only required to
  // publish (push/link). A repo without it is in deliberate local mode.
  if (!config.agentId) die("config missing agentId — run `figs init`")
}
function appendJsonl(name, obj) {
  appendFileSync(join(repoDir, name), JSON.stringify(obj) + "\n")
}

// ---------- reference checks (warn, never block) ----------------------------
// A dangling link is damage-limited; a blocked verb is not — so reference
// checks WARN, they don't die. (Closing/answering a nonexistent ask DOES die —
// that lives with those verbs.) Under the topology rule the local journal is
// complete, so these checks are trustworthy.

/** Announce whether a stable --id opened a new record or folded onto one. */
function announceFold(kind, id, isNew, suffix = "") {
  console.log(
    isNew
      ? `figs:   new ${kind} opened: ${id}${suffix}`
      : `figs:   folded onto existing ${kind} ${id}`,
  )
}
/** --unit should name a charter unit; warn on a typo (only once units exist). */
function warnUnknownUnit(unit) {
  if (!unit) return
  const units = (readJson(join(repoDir, "agent.json"), {}).units ?? [])
    .map((u) => u?.id)
    .filter(Boolean)
  if (units.length && !units.includes(unit)) {
    console.warn(`figs: ! --unit "${unit}" isn't one of your charter units (${units.join(", ")}) — typo?`)
  }
}
/** --run should name a job in this journal; warn on a dangling link. */
function warnUnknownRun(runId) {
  if (!runId) return
  if (!foldById(readJsonl("runs.jsonl")).some((r) => r.id === runId)) {
    console.warn(`figs: ! --run "${runId}" isn't a job in this journal — typo? this link will dangle`)
  }
}
/** Copy attachments into artifacts/ — ext + size checks; immutable once there. */
function attachFiles(paths) {
  const names = []
  for (const p of paths) {
    if (!existsSync(p)) die(`--attach: no such file: ${p}`)
    const ext = extname(p).toLowerCase()
    if (!ARTIFACT_EXTS.has(ext)) {
      die(`--attach: unsupported type "${ext || p}" — supported: ${[...ARTIFACT_EXTS].join(" ")}`)
    }
    const bytes = readFileSync(p)
    if (bytes.length > ARTIFACT_MAX) {
      die(`--attach: ${basename(p)} is ${(bytes.length / 1048576).toFixed(1)} MB — over the ${ARTIFACT_MAX / 1048576} MB cap; compress or split it`)
    }
    const name = basename(p)
    const dest = join(repoDir, "artifacts", name)
    if (existsSync(dest) && !readFileSync(dest).equals(bytes)) {
      die(
        `--attach: artifacts/${name} already exists with different content — artifacts are immutable once published; use a new name (e.g. ${name.slice(0, -ext.length)}-v2${ext}) and reference that`,
      )
    }
    mkdirSync(join(repoDir, "artifacts"), { recursive: true })
    writeFileSync(dest, bytes)
    names.push(name)
  }
  return names
}

// A `$` eaten by the caller's shell (double-quoted "$4,474.63" → ",474.63")
// leaves a signature legit prose essentially never has: an orphaned thousands
// group or a bare ".00" cents tail. Best-effort tripwire — warn and teach,
// never block (the heuristic can't be certain, and records fold by id, so a
// corrected re-run heals the row). "$1K" → "K" leaves no signature; that case
// is why every emitted template teaches single-quoted prose in the first place.
function warnEatenDollar(...texts) {
  // regex lives inside the function: the CLI dispatches commands during module
  // evaluation, so a top-level const here would still be in its TDZ when called
  const eaten = /(^|[\s([{])(,\d{3}\b|\.00\b)/
  if (texts.flat().filter(Boolean).some((t) => eaten.test(String(t)))) {
    console.warn(
      "figs: ! a value looks like your shell ate a `$` (\"$4,474.63\" in double quotes becomes \",474.63\") — single-quote prose args ('…') and re-run; the same id folds the fix onto the record",
    )
  }
}

// ---------- the inbox + show (the DOWN view — pure local reads) -------------
// Everything here reads local files: in-flight jobs (runs.jsonl), open asks
// (asks.jsonl), reply threads (messages.jsonl). No win-logic — the agent gets
// the complete, time-ordered truth and judges. (The soft messages-only
// down-sync when linked is layered on top in a later step.)

/** Relative time for inbox lines — rough on purpose. */
function agoStr(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}
/** Replies for an ask, oldest-first (messages accumulate; order by ts). */
function repliesFor(messages, askId) {
  return messages
    .filter((m) => m.ask === askId)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
}
/** One reply, verbatim — never paraphrase a human's words. `(transcribed)`
 *  marks a chat reply (self-reported); app replies are attested by mint origin. */
function messageLine(m) {
  const head =
    m.kind === "verdict"
      ? `${String(m.verdict).replace(/-/g, " ")} by ${m.by}`
      : `answered by ${m.by}`
  const grade = m.source === "app" ? "" : " (transcribed)"
  const body = [m.chosen ? `→ "${m.chosen}"` : null, m.text ? `"${m.text}"` : null]
    .filter(Boolean)
    .join(" · ")
  return `${head}${grade} · ${agoStr(m.ts)}${body ? `\n      ${body}` : ""}`
}
/** Attachments on a record — the new `attachments[]`, falling back to the old
 *  run `artifact`/`artifacts` and ask `refs` shapes (forward-compatible reads). */
function attachmentsOf(rec) {
  if (Array.isArray(rec.attachments)) return rec.attachments
  return [
    ...[rec.artifact, ...(rec.artifacts ?? [])].filter(Boolean),
    ...(rec.refs ?? []).map((r) => r?.artifact).filter(Boolean),
  ]
}
/** The newest reply on an ask → the exact next command. */
function nextMove(ask, replies) {
  const last = replies[replies.length - 1]
  if (!last) {
    return "waiting on your human — relay the ask to them in chat; record their reply with `figs answer`"
  }
  if (last.kind === "verdict" && last.verdict === "changes-requested") {
    return `changes requested — revise, then re-raise on the same id: figs ask ${ask.type ?? "sign-off"} --id ${ask.id} --title '…' …`
  }
  if (last.kind === "verdict" && last.verdict === "rejected") {
    return `declined — acknowledge it: figs close ${ask.id}`
  }
  return `act on it (real work → figs report it under its own --id), then: figs close ${ask.id}${"" /* --run <job> when work was done */}`
}

/**
 * The one thing that flows DOWN (spec v2 §8): this agent's human messages,
 * merged into `messages.jsonl` (append-if-id-absent). Soft — it never blocks
 * the inbox; returns a status the caller surfaces. Runs only when linked + a
 * token is present. The trust grade is the server's to enforce (it forces
 * `source:"chat"` on transcriptions); the CLI just folds messages in by id.
 */
async function syncMessages() {
  const config = readJson(join(repoDir, "config.json"), {})
  if (!config.workspaceId) return { ran: false, reason: "local" }
  const token = getToken()
  if (!token) return { ran: false, reason: "not logged in" }
  const base = resolveEndpoint()
  let res
  try {
    res = await fetchT(
      `${base}/api/messages?agent=${config.agentId}`,
      { headers: authHeaders(token) },
      SYNC_TIMEOUT_MS,
    )
  } catch (e) {
    return { ran: false, reason: `couldn't reach ${base} (${netReason(e)})` }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    return { ran: false, reason: `sync failed (${res.status})${t ? `: ${t.slice(0, 120)}` : ""}` }
  }
  let data
  try {
    data = await res.json()
  } catch {
    return { ran: false, reason: "sync returned non-JSON" }
  }
  const incoming = Array.isArray(data.messages) ? data.messages : []
  const have = new Set(readJsonl("messages.jsonl").map((m) => m.id))
  let added = 0
  for (const m of incoming) {
    if (!m?.id || have.has(m.id)) continue // immutable + id-keyed → dedup is exact
    appendJsonl("messages.jsonl", m)
    have.add(m.id)
    added++
  }
  return { ran: true, added, truncated: Boolean(data.truncated) }
}

/**
 * `figs inbox` — session start. When linked, a soft messages-only down-sync
 * runs first (degradable; loud on failure/truncation), then everything is a
 * local read: open asks grouped by reply state + unfinished jobs, each with its
 * next command. With an id: routes to `figs show <id>` (the magnifier).
 */
async function inboxCmd() {
  requireFigs()
  if (positional()) return showCmd() // `figs inbox <id>` → show

  // Down-sync first (unless --no-sync): a stale inbox that says "nothing needs
  // you" is the worst failure mode, so we touch the network here — softly.
  const sync = hasFlag("--no-sync") ? { ran: false, reason: "skipped" } : await syncMessages()

  const asks = foldById(readJsonl("asks.jsonl"))
  const messages = readJsonl("messages.jsonl")
  const jobs = foldById(readJsonl("runs.jsonl")).filter((r) => r.state === "in-flight")
  const open = asks
    .filter((a) => (a.status ?? "open") === "open")
    .map((a) => ({ a, replies: repliesFor(messages, a.id) }))
  const answered = open.filter(
    ({ replies }) => replies.length && replies[replies.length - 1].verdict !== "changes-requested",
  )
  const changes = open.filter(
    ({ replies }) => replies.length && replies[replies.length - 1].verdict === "changes-requested",
  )
  const quiet = open.filter(({ replies }) => !replies.length)

  // Orphan replies: a synced message whose ask isn't in this copy's journal
  // (a fresh clone). Surface it — never silently drop a human's reply.
  const localAskIds = new Set(asks.map((a) => a.id))
  const orphanAskIds = [...new Set(messages.map((m) => m.ask).filter((id) => id && !localAskIds.has(id)))]

  // Warnings the agent can act on without scraping stderr.
  const warnings = []
  if (sync.ran && sync.truncated) {
    warnings.push("sync incomplete — the server returned a partial set; some replies may be missing")
  } else if (!sync.ran && sync.reason !== "local" && sync.reason !== "skipped") {
    warnings.push(`showing local state — couldn't sync (${sync.reason})`)
  }

  if (hasFlag("--json")) {
    return printJson(
      {
        asks: open.map(({ a, replies }) => ({
          id: a.id, type: a.type, title: a.title, status: a.status ?? "open", replies,
        })),
        jobs,
        orphanAsks: orphanAskIds,
        sync,
      },
      { warnings },
    )
  }

  for (const w of warnings) console.warn(`figs: ! ${w}`)

  if (open.length === 0 && jobs.length === 0 && orphanAskIds.length === 0) {
    console.log("figs: ✓ inbox empty — no open asks, no unfinished jobs, nothing needs you")
    return
  }
  console.log(
    `figs: inbox — ${answered.length} answered · ${changes.length} need revision · ${quiet.length} waiting on your human` +
      (jobs.length ? ` · ${jobs.length} job${jobs.length === 1 ? "" : "s"} in flight` : ""),
  )
  const printItem = ({ a, replies }) => {
    console.log(`\n  ${a.id} · ${a.type ?? "?"} — ${a.title ?? ""}`)
    if (replies.length) console.log(`    ${messageLine(replies[replies.length - 1])}`)
    console.log(`    → ${nextMove(a, replies)}${replies.length > 1 ? `   (full thread: figs show ${a.id})` : ""}`)
  }
  for (const item of [...answered, ...changes]) printItem(item)
  if (quiet.length) {
    console.log(`\n  Waiting on your human — relay these in chat, then \`figs answer\` their reply:`)
    for (const { a } of quiet) console.log(`    · ${a.id} · ${a.type ?? "?"} — ${a.title ?? ""} (raised ${a.ts ? agoStr(a.ts) : "—"})`)
  }
  if (jobs.length) {
    console.log(`\n  Unfinished jobs — in flight (your past self's work; finish or settle):`)
    for (const j of jobs) {
      console.log(`    · ${j.id}${j.result ? ` — ${j.result}` : ""} (last update ${agoStr(j.ts)})`)
      console.log(`      → continue it (\`figs checkpoint --id ${j.id}\` as you go); \`figs report --id ${j.id}\` settles it`)
    }
  }
  if (orphanAskIds.length) {
    console.log(`\n  Replies on asks not in this copy's journal (raised elsewhere — full context in the app):`)
    for (const id of orphanAskIds) console.log(`    · ${id}  → figs show ${id}`)
  }
}

/**
 * `figs show <id>` — the magnifier, pure local. Auto-detects an ask or a job
 * and prints the folded record + its thread/trail + attachment names. No
 * network: an attachment not on disk is noted (view it in the app), never
 * downloaded — local is the source of truth.
 */
function showCmd() {
  requireFigs()
  const id = positional()
  if (!id) die("show needs an id: figs show <ask-id|job-id>")
  const asks = foldById(readJsonl("asks.jsonl"))
  const runs = foldById(readJsonl("runs.jsonl"))
  const messages = readJsonl("messages.jsonl")
  const ask = asks.find((a) => a.id === id)
  const replies = repliesFor(messages, id)

  if (ask || replies.length) {
    if (hasFlag("--json")) return printJson({ ask: ask ?? null, replies })
    if (ask) {
      console.log(`figs: ${ask.title ?? id}`)
      console.log(
        `      ${ask.type ?? "?"} · ${ask.status ?? "open"}${ask.to ? ` · for the ${ask.to}` : ""}${ask.ts ? ` · raised ${agoStr(ask.ts)}` : ""}`,
      )
      if (ask.found) console.log(`\n  What it found:\n      ${ask.found}`)
      if (ask.need) console.log(`\n  What it needs:\n      ${ask.need}`)
      if (ask.options?.length) {
        console.log(`\n  Options (a reply cites one verbatim):`)
        for (const o of ask.options) console.log(`      · ${o}`)
      }
      if (ask.details?.length) {
        console.log(`\n  Details:`)
        for (const d of ask.details) console.log(`      ${d.l}: ${d.v}`)
      }
      // Union across all of the ask's raw lines (raise/revise/close) — folding
      // would drop an intermediate; attachments belong to their moment.
      showAttachmentNames(
        readJsonl("asks.jsonl").filter((a) => a.id === id).flatMap(attachmentsOf),
      )
    } else {
      console.log(`figs: ask ${id} — not in this copy's journal (full context in the app); showing the replies that are here`)
    }
    if (replies.length) {
      console.log(`\n  THE THREAD (your humans' words, verbatim):`)
      for (const m of replies) console.log(`    · ${messageLine(m)}`)
    } else {
      console.log(`\n  No reply yet.`)
    }
    console.log(`\n  → next: ${nextMove(ask ?? { id }, replies)}`)
    return
  }

  const run = runs.find((r) => r.id === id)
  if (run) {
    const trail = readJsonl("runs.jsonl").filter((r) => r.id === id)
    if (hasFlag("--json")) return printJson({ run, trail })
    console.log(`figs: job ${id}${run.unit ? ` · ${run.unit}` : ""}${run.period ? ` · ${run.period}` : ""}`)
    console.log(`      ${run.state ?? "settled"}${run.status ? ` · ${run.status}` : ""} — ${run.result ?? ""}`)
    console.log(`\n  Trail (each checkpoint/report at the moment it happened):`)
    for (const l of trail) {
      const atts = attachmentsOf(l)
      console.log(
        `    · ${l.ts ? agoStr(l.ts) : "—"} [${l.state ?? "settled"}] ${l.result ?? ""}${atts.length ? `  · ${atts.join(", ")}` : ""}`,
      )
    }
    showAttachmentNames(trail.flatMap(attachmentsOf))
    return
  }

  die(`"${id}" isn't a run or an ask in this journal — \`figs inbox\` lists what's here`)
}

/** Print attachment names (deduped), noting any not present on this machine. */
function showAttachmentNames(names) {
  const unique = [...new Set(names)]
  if (!unique.length) return
  console.log(`\n  Attachments:`)
  for (const name of unique) {
    const here = existsSync(join(repoDir, "artifacts", name))
    console.log(`      · ${name}${here ? "" : "  (not in this copy — view it in the app)"}`)
  }
}

// ---------- figs answer — record the human's reply (you run it, not them) ----
/**
 * `figs answer <ask-id>` transcribes a human's out-of-band reply into
 * `messages.jsonl`. It's a plain writing verb (append + auto-push). `--by` names
 * the HUMAN; the CLI stamps id/ts/source — the agent never authors plumbing.
 */
async function answerCmd() {
  requireFigs()
  const askId = positional()
  if (!askId) {
    die("answer needs the ask id: figs answer <ask-id> --by '<who>' (--chosen … | --text … | --approve|--request-changes|--reject)")
  }
  if (!askExistsLocally(askId)) {
    die(`ask "${askId}" isn't in this journal — \`figs inbox\` shows your open asks. You record a human's reply to an ask YOU raised; you don't answer one that doesn't exist here.`)
  }
  const by = flag("--by")
  if (!by) die("answer needs --by '<who said it>' — the human's name, not yours (you're transcribing their words)")

  const verdicts = [
    ["--approve", "approved"],
    ["--request-changes", "changes-requested"],
    ["--reject", "rejected"],
  ].filter(([f]) => hasFlag(f))
  if (verdicts.length > 1) die("pick one verdict: --approve | --request-changes | --reject")

  const chosen = flag("--chosen")
  const text = flag("--text")
  const msg = {
    id: genId("msg"),
    kind: verdicts.length ? "verdict" : "answer",
    ask: askId,
    by,
    ts: nowIso(),
    source: "chat", // transcribed here; app-minted replies arrive via inbox sync
  }
  if (verdicts.length) msg.verdict = verdicts[0][1]
  if (chosen) msg.chosen = chosen
  if (text) msg.text = text
  if (msg.kind === "answer" && !chosen && !text) {
    die("answer needs --chosen '<option verbatim>' or --text '<what they said>' (or a verdict flag for a sign-off)")
  }

  // --chosen must quote one of the ask's options verbatim (when the ask is local).
  if (chosen) {
    const ask = foldById(readJsonl("asks.jsonl")).find((a) => a.id === askId)
    const options = ask?.options ?? []
    if (options.length && !options.includes(chosen)) {
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
      const near = options.find((o) => norm(o) === norm(chosen))
      if (near) die(`--chosen must quote the option verbatim — did you mean "${near}"?`)
      die(
        `--chosen "${chosen}" doesn't match any of the ask's options:\n` +
          options.map((o) => `    · ${o}`).join("\n") +
          "\n  (quote one verbatim, or use --text for a free-text reply)",
      )
    }
  }

  // Double-transcription guard: a reply made in the app syncs down on its own,
  // so re-typing it here would mint a duplicate (a weaker-grade copy).
  const priorSame = readJsonl("messages.jsonl").some(
    (m) =>
      m.ask === askId &&
      ((chosen && m.chosen === chosen) ||
        (text && m.text === text) ||
        (msg.verdict && m.verdict === msg.verdict)),
  )
  if (priorSame) {
    console.warn(
      "figs: ! a reply on this ask already carries that — replies made in the app sync down automatically; `figs answer` is only for replies that exist nowhere but your chat",
    )
  }

  warnEatenDollar(msg.chosen, msg.text)
  const issues = validateMessage(msg)
  if (issues.length) die(`not written:\n  ${issues.join("\n  ")}`)
  appendJsonl("messages.jsonl", msg)
  console.log(`figs: ✓ reply recorded — ${JSON.stringify(msg)}`)
  console.log(
    `figs:   transcribed ${by}'s reply. Act on it, then \`figs close ${askId}\` (it cites this) — real work first → report it, then \`figs close ${askId} --run <job>\`.`,
  )
  await autoPush()
}

// ---------- figs close — the one closing verb (derives from the reply) -------
/** The old resolve surface → teaching errors (the migration path). A function,
 *  not a top-level const: the CLI dispatches during module eval, so a const
 *  declared after the dispatch block would still be in its TDZ when called. */
function closeCutFlags() {
  return {
    "--chosen":
      "replies are recorded with `figs answer <id> --chosen '…' --by '<who>'`; close only ends the ask (it cites the reply on file automatically)",
    "--by":
      "the answerer is named on the reply: `figs answer <id> … --by '<who>'`; close cites it automatically",
    "--answer-id":
      "close auto-cites the NEWEST reply on file — you don't name it",
    "--rejected":
      "record the human's reject as a verdict first: `figs answer <id> --reject --by '<who>'`, then `figs close <id>` derives 'rejected' from it",
  }
}
/** The teaching menu when an ask has no reply on file yet. */
function closeMenu(askId) {
  return (
    `no reply on file for "${askId}" — close needs to know what happened:\n` +
    `    · answered in chat?   → record it first: figs answer ${askId} --by '<who>' (--chosen … | --text …)\n` +
    `    · YOU retracted it?   → figs close ${askId} --withdrawn\n` +
    `    · cleared on its own? → figs close ${askId} --note '<what happened>'  (recorded via: self)`
  )
}
async function closeCmd() {
  requireFigs()
  const askId = positional()
  if (!askId) die("close needs the ask id: figs close <ask-id> [--note …] [--run …] [--withdrawn]")
  // The old resolve surface → teaching errors (the migration path).
  for (const [f, help] of Object.entries(closeCutFlags())) {
    if (hasFlag(f) || flag(f) !== undefined) die(`\`${f}\` is gone — ${help}`)
  }
  if (!askExistsLocally(askId)) {
    die(`ask "${askId}" isn't in this journal — \`figs inbox\` shows your open asks`)
  }
  const withdrawn = hasFlag("--withdrawn")
  const note = flag("--note")
  const runRef = flag("--run")
  warnUnknownRun(runRef)
  const attached = attachFiles(flagAll("--attach")) // proof of what was done

  // The newest reply for this ask drives the close (messages accumulate; sort by ts).
  const replies = readJsonl("messages.jsonl")
    .filter((m) => m.ask === askId)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
  const newest = replies[replies.length - 1]

  const resolution = {}
  let status
  if (withdrawn) {
    status = "withdrawn" // the agent's own act — no reply needed, nobody acted
  } else if (!newest) {
    if (!note) die(closeMenu(askId))
    status = "resolved" // cleared on its own — self-reported
    resolution.via = "self"
  } else if (newest.kind === "verdict" && newest.verdict === "changes-requested") {
    die(
      `changes were requested on "${askId}" — revise and re-raise on the same id (\`figs ask sign-off --id ${askId} …\`); this isn't a close`,
    )
  } else {
    // an answer, an approval, or a rejection — all derive a close, citing it
    status = newest.verdict === "rejected" ? "rejected" : "resolved"
    resolution.via = "figs"
    resolution.answer = newest.id
    if (newest.by) resolution.by = newest.by
    if (newest.chosen) resolution.chosen = newest.chosen
  }
  if (note) resolution.note = note
  if (runRef) resolution.run = runRef
  // Machine-stamped, inside resolution so the fold can't collide with the raise ts.
  resolution.ts = nowIso()

  warnEatenDollar(resolution.chosen, resolution.note)
  const line = { id: askId, status, resolution }
  if (attached.length) line.attachments = attached // pinned to the close moment
  appendJsonl("asks.jsonl", line)
  const cite =
    resolution.answer && newest
      ? ` — ${status === "rejected" ? "acknowledging" : "acting on"} ${newest.by ?? "the"} reply${newest.chosen ? ` '${newest.chosen}'` : ""}`
      : ""
  console.log(`figs: ✓ ask ${askId} ${status}${cite}`)
  await autoPush()
}

/**
 * The verbs' shared final step. The write already succeeded locally before this
 * runs, so the record is safe no matter what happens here — that's why every
 * not-published outcome is exit 2 (retry `figs push`), never exit 1.
 *
 *  - local mode (not linked)  → don't attempt; calm note; exit 0.
 *  - --no-push                → deliberately deferred; exit 0.
 *  - linked, no token         → exit 2 + the canonical line.
 *  - linked, push fails       → exit 2 + the canonical line.
 *  - linked, push ok          → exit 0.
 */
async function autoPush() {
  if (hasFlag("--no-push")) {
    console.log("figs:   saved locally (--no-push) — `figs push` publishes it")
    return
  }
  if (!isLinked()) {
    console.log("figs:   local mode — `figs link` to publish")
    return
  }
  if (!getToken()) {
    console.warn("figs: ! not logged in — `figs login`, then `figs push`")
    console.warn(`figs: ! ${RECORDED_LOCALLY}`)
    process.exitCode = 2
    return
  }
  if (!(await doPush()).ok) {
    console.warn(`figs: ! ${RECORDED_LOCALLY}`)
    process.exitCode = 2
  }
}

async function reportCmd() {
  requireFigs()
  const result = flag("--result")
  if (!result) {
    die("report needs --result '<one-line outcome>' — e.g. figs report --result '88% matched · 31 flagged'")
  }
  // state is verb-stamped, never typed: report settles the job (checkpoint
  // marks it in-flight). The settling fold overrides any earlier checkpoint.
  const idGiven = flag("--id")
  const id = idGiven || genId("r")
  // Before the append, so "new" means new-to-this-outbox (the typo catch).
  const isNew = !foldById(readJsonl("runs.jsonl")).some((r) => r.id === id)
  const run = { id, ts: nowIso(), result, state: "settled" }
  const unit = flag("--unit")
  if (unit) run.unit = unit
  const period = flag("--period")
  if (period) run.period = period
  const status = flag("--status")
  if (status) run.status = status
  const trigger = flag("--trigger")
  if (trigger) run.session = { trigger }
  const attached = attachFiles(flagAll("--attach"))
  if (attached.length) run.attachments = attached
  warnEatenDollar(run.result)
  warnUnknownUnit(unit)
  const issues = validateRun(run)
  if (issues.length) die(`not written:\n  ${issues.join("\n  ")}`)
  appendJsonl("runs.jsonl", run)
  console.log(`figs: ✓ run recorded — ${JSON.stringify(run)}`)
  // Announce new-vs-fold only for an explicit --id — that's where a typo means
  // "I meant to continue a job but opened a sibling" (auto-ids are always new).
  if (idGiven) announceFold("job", id, isNew, " (settled)")
  // Teaching, never a gate: a settled job with open asks citing it is the
  // normal tail-of-job pattern (the ask owns the waiting) — but if the job's
  // OUTCOME depends on an answer, in-flight is the honest state. Local fold
  // only (other machines' asks are invisible here): best-effort by design.
  const openCiting = foldById(readJsonl("asks.jsonl")).filter(
    (a) => a.run === run.id && (a.status ?? "open") === "open",
  )
  if (openCiting.length > 0) {
    const n = openCiting.length
    console.log(
      `figs:   note: ${n} open ask${n === 1 ? "" : "s"} cite${n === 1 ? "s" : ""} this job (${openCiting
        .map((a) => a.id)
        .join(", ")}) — a tail sign-off is fine; if the OUTCOME depends on an answer, keep the job in flight instead (\`figs checkpoint --id ${run.id} --status warn\`)`,
    )
  }
  await autoPush()
}

/**
 * `figs checkpoint` — save a job's progress so it survives this sitting. The
 * first checkpoint on an id OPENS the job (state: in-flight); a crash mid-job
 * then leaves a visible, recoverable stub the next session finds in
 * `figs inbox`, instead of nothing. Same fold-by-id write as report — only
 * the stamped state differs; `figs report` settles the id.
 */
async function checkpointCmd() {
  requireFigs()
  const id = flag("--id")
  if (!id) {
    die("checkpoint needs --id '<job-id>' — the stable job id the next session will look for (e.g. recon-acme-2026-11)")
  }
  const note = flag("--note")
  if (!note) {
    die(`checkpoint needs --note '<where the job stands>' — e.g. figs checkpoint --id ${id} --note 'Statements pulled — matching now'`)
  }
  // Before the append, so "new" means new-to-this-outbox (the teaching line).
  const isNew = !foldById(readJsonl("runs.jsonl")).some((r) => r.id === id)
  const run = { id, ts: nowIso(), result: note, state: "in-flight" }
  const unit = flag("--unit")
  if (unit) run.unit = unit
  const period = flag("--period")
  if (period) run.period = period
  const status = flag("--status")
  if (status) run.status = status
  const trigger = flag("--trigger")
  if (trigger) run.session = { trigger }
  const attached = attachFiles(flagAll("--attach"))
  if (attached.length) run.attachments = attached
  warnEatenDollar(run.result)
  warnUnknownUnit(unit)
  const issues = validateRun(run)
  if (issues.length) die(`not written:\n  ${issues.join("\n  ")}`)
  // A new sitting on a SETTLED id is a legitimate reopen (the warn→ok story),
  // but usually means "I should have used a new id" — nudge without blocking.
  const settledBefore = foldById(readJsonl("runs.jsonl")).some(
    (r) => r.id === id && r.state === "settled",
  )
  appendJsonl("runs.jsonl", run)
  console.log(`figs: ✓ checkpoint recorded — ${JSON.stringify(run)}`)
  if (isNew) {
    console.log(
      `figs:   new job opened: ${id} (in flight) — checkpoint as you go; \`figs report --id ${id}\` settles it`,
    )
  } else if (settledBefore) {
    console.warn(
      `figs: ! reopening a settled job (${id}) — continue only if it's truly the same job; new work wants a new id`,
    )
  } else {
    console.log(`figs:   folded onto existing job ${id} (in flight)`)
  }
  await autoPush()
  // A checkpoint exists to survive a crash — but only when this repo intends to
  // publish (linked). In local mode the file IS the protection, so the calm
  // "local mode" line autoPush printed is the whole truth. When linked, a failed
  // push (exit 2) means the crash-stub never reached the server — say so loudly.
  if (process.exitCode === 2) {
    console.warn(
      `figs: ! this checkpoint is NOT protecting the job remotely yet — nothing reached the server. Run \`figs push\` before continuing the work.`,
    )
  }
}

async function askCmd() {
  requireFigs()
  let base = {}
  if (hasFlag("--stdin")) {
    let raw = ""
    try {
      raw = readFileSync(0, "utf8")
    } catch {
      /* no stdin */
    }
    if (!raw.trim()) die("--stdin given but nothing arrived on stdin — pipe a JSON object")
    try {
      base = JSON.parse(raw)
    } catch (e) {
      die(`--stdin: invalid JSON: ${e.message}`)
    }
    if (!base || typeof base !== "object" || Array.isArray(base)) {
      die("--stdin must be a single JSON object (one ask)")
    }
  }
  const type = positional() ?? base.type
  if (!type) die(`ask needs a type: figs ask <${ASK_TYPES.join("|")}> --title '…'`)
  const ask = { ...base, id: flag("--id") ?? base.id ?? genId("ask"), ts: nowIso(), type }
  if (!ask.status) ask.status = "open"
  const title = flag("--title") ?? base.title
  if (!title) die("ask needs --title '<the ask, in one line>'")
  ask.title = title
  for (const [f, k] of [["--need", "need"], ["--found", "found"], ["--unit", "unit"], ["--to", "to"]]) {
    const v = flag(f)
    if (v) ask[k] = v
  }
  const options = flagAll("--option")
  if (options.length) ask.options = options
  for (const o of ask.options ?? []) {
    if (o.length > 80) {
      console.warn(
        `figs: ! option "${o.slice(0, 40)}…" is long — options should be short, stable, quotable (an answer cites one verbatim)`,
      )
    }
  }
  const onApprove = flagAll("--on-approve")
  if (onApprove.length) ask.onApprove = onApprove
  if (ask.onApprove?.length && ask.type !== "sign-off") {
    die(
      `--on-approve is the approval contract — sign-off only. A ${ask.type} has no approval; the chosen option carries the next step (put it in the --option text)`,
    )
  }
  const details = flagAll("--detail").map((d) => {
    const i = d.indexOf("=")
    if (i < 1) die(`--detail must be "Label=Value", got "${d}"`)
    return { l: d.slice(0, i), v: d.slice(i + 1) }
  })
  if (details.length) ask.details = [...(base.details ?? []), ...details]
  const runRef = flag("--run")
  if (runRef === "last") {
    // Deliberately unsupported: concurrent sessions of the same agent report
    // runs in parallel — "the latest run" may be someone else's. Explicit only.
    die('--run takes the explicit run id (no "last" — another session may have reported since); `figs report` prints the id of what it wrote')
  }
  if (runRef) ask.run = runRef
  warnUnknownRun(runRef)
  warnUnknownUnit(ask.unit)
  const attached = attachFiles(flagAll("--attach"))
  // Unified attachments[] (bare file names). Accept attachments[] from --stdin,
  // and normalize a legacy refs[] into it (the filename is the label now).
  const baseAtts = Array.isArray(base.attachments)
    ? base.attachments
    : (base.refs ?? []).map((r) => r?.artifact).filter(Boolean)
  delete ask.refs
  if (attached.length || baseAtts.length) ask.attachments = [...baseAtts, ...attached]
  if (ask.type === "sign-off" && !ask.attachments?.length) {
    console.warn(
      "figs: ! tip: a sign-off reviews best with attachments — the exact content to approve, plus a brief (what to do once approved + what it requires). Add --attach <file>",
    )
  }
  if (ask.type === "sign-off" && !ask.onApprove?.length) {
    console.warn(
      "figs: ! tip: state what approval sets in motion — --on-approve '<step>' (repeatable, ordered); an approver shouldn't have to guess what approve causes",
    )
  }
  warnEatenDollar(
    ask.title,
    ask.found,
    ask.need,
    ask.options ?? [],
    ask.onApprove ?? [],
    (ask.details ?? []).flatMap((d) => [d.l, d.v]),
  )
  const issues = validateAsk(ask)
  if (issues.length) die(`not written:\n  ${issues.join("\n  ")}`)
  const askIdGiven = flag("--id") ?? base.id
  const askIsNew = !foldById(readJsonl("asks.jsonl")).some((a) => a.id === ask.id)
  appendJsonl("asks.jsonl", ask)
  console.log(`figs: ✓ ask raised — ${JSON.stringify(ask)}`)
  // Announce new-vs-fold for an explicit id — re-raising the same id (a revision)
  // folds; a typo'd id silently opens a sibling ask. Catch it.
  if (askIdGiven) announceFold("ask", ask.id, askIsNew)
  if (!ask.to) {
    console.log("figs:   tip: address asks with --to manager|builder so they route to the right person")
  }
  await autoPush()
  // Local: the agent must put the ask in front of the human — nothing else
  // surfaces it. When linked, the app surfaces it too.
  console.log(
    isLinked()
      ? "figs:   show this ask to your human (it's also in the app); record their reply with `figs answer`, read it back with `figs inbox`"
      : "figs:   show this ask to your human in chat now — nothing else surfaces it. Record their reply with `figs answer`.",
  )
}

/**
 * `figs doctor` — the spec's conformance validator. Local validation is
 * normative and **runs account-free**: a fresh, no-token, offline repo gets a
 * full pass and exit 0. Server validation (when linked + logged in) is an
 * additive second opinion, never the gate.
 */
async function doctor() {
  // Local checks first (no token/network needed) — fail fast and offline.
  if (!existsSync(repoDir)) die(noFigsHint())
  const config = readJson(join(repoDir, "config.json"), {})
  if (!config.agentId) die("config missing agentId — run `figs init`")
  const agentJson = readJson(join(repoDir, "agent.json"), null)
  if (!agentJson) die("missing .figs/agent.json — author it first (see .figs/GUIDE.md)")

  // Refuse to bless a charter that still has `<…>` template placeholders — `figs
  // init` scaffolds them, and pushing them would publish "<one line — what you
  // are>" to the org chart. This is the "not ready to push" signal.
  const placeholders = findPlaceholders(agentJson)
  if (placeholders.length) {
    if (JSON_OUT) {
      printJson({ valid: false, placeholders }, { ok: false })
    } else {
      console.log("figs: ✗ .figs/agent.json still has template placeholders — fill these in before pushing:")
      for (const p of placeholders) console.log(`  ${p.path}: ${p.value}`)
      console.log("  (replace the <…> values by reading your own repo, then re-run `figs doctor`)")
    }
    process.exit(1)
  }

  // Same local checks the write-path runs — catches hand-authored mistakes
  // offline, before the server round-trip.
  const localIssues = validateOutbox(
    foldById(readJsonl("runs.jsonl")),
    foldById(readJsonl("asks.jsonl")),
    readJsonl("messages.jsonl"),
  )
  if (localIssues.length) {
    if (JSON_OUT) {
      printJson({ valid: false, scope: "local", issues: localIssues }, { ok: false })
    } else {
      console.log("figs: ✗ local validation issues:")
      for (const i of localIssues) console.log(`  ${i}`)
    }
    process.exit(1)
  }

  // Local conformance passed. Server validation is the additive layer — it
  // needs both a destination (linked) and a token; without either, we're done,
  // and that is a full, legitimate pass (the spec's conformance is local).
  if (!config.workspaceId || !getToken()) {
    const why = !config.workspaceId ? "not linked" : "not logged in"
    if (JSON_OUT) return printJson({ valid: true, scope: "local", serverValidation: "skipped", reason: why })
    console.log(`figs: ✓ .figs/ passes local conformance — server validation skipped (${why})`)
    return
  }
  const r = await api("POST", "/api/validate", {
    workspaceId: config.workspaceId,
    agent: { ...agentJson, id: config.agentId },
    runs: foldById(readJsonl("runs.jsonl")),
    asks: foldById(readJsonl("asks.jsonl")),
    messages: readJsonl("messages.jsonl"),
  })
  if (r.ok) {
    if (JSON_OUT) return printJson({ valid: true, scope: "server" })
    console.log("figs: ✓ .figs/ is valid — ready to push")
    return
  }
  if (JSON_OUT) {
    printJson({ valid: false, scope: "server", issues: r.issues }, { ok: false })
  } else {
    console.log("figs: ✗ validation issues:")
    for (const i of r.issues) {
      console.log(`  ${i.path || "(root)"}: ${i.message}`)
      // The server quotes the canonical shape for the field you got wrong —
      // show it so you don't have to re-read the guide to fix it.
      if (i.expected) console.log(`      expected e.g. ${i.expected}`)
    }
    console.log(`  (full shapes + a valid example: ${resolveEndpoint()}/llms.txt)`)
  }
  process.exit(1)
}

/**
 * `figs push` — the bare transport. Exit 1 on a **structural** failure (fix
 * something: not linked, no agent.json, bad data), exit 2 on a **transient** one
 * (network/server — the records are safe; retry later).
 */
async function push() {
  const r = await doPush()
  if (!r.ok) process.exit(r.retryable ? 2 : 1)
}

/**
 * The one transport: spine → /api/ingest, artifacts → /api/artifacts/upload.
 * `figs push` is a thin wrapper; the writing verbs call this after their local
 * append (auto-push IS push — one transport, many entry points). Runs the same
 * local checks as `figs doctor` first, so a malformed hand-written line never
 * reaches the server as a confusing 4xx. Prints its own errors and returns
 * `{ ok, retryable }` — callers map that to an exit code.
 */
async function doPush() {
  const fail = (msg, retryable = false) => {
    console.error(`figs: ✗ push: ${msg}`)
    return { ok: false, retryable }
  }
  if (!existsSync(repoDir)) return fail(noFigsHint())
  const config = readJson(join(repoDir, "config.json"), {})
  if (!config.agentId) return fail("config missing agentId — run `figs init`")
  if (!config.workspaceId) {
    return fail("not linked — local records are safe; `figs link` to publish")
  }
  const token = getToken()
  if (!token) return fail("not logged in — run `figs login` (or set FIGS_TOKEN)")
  await checkVersion({ hardFail: true })

  const endpoint = process.env.FIGS_ENDPOINT || config.endpoint || DEFAULT_ENDPOINT
  const agentJson = readJson(join(repoDir, "agent.json"), null)
  if (!agentJson) return fail("missing .figs/agent.json — author it, then `figs doctor`")
  const agent = { ...agentJson, id: config.agentId }
  const runs = foldById(readJsonl("runs.jsonl"))
  const asks = foldById(readJsonl("asks.jsonl"))
  // Messages are immutable events — sent whole (no fold); the server dedupes by id.
  const messages = readJsonl("messages.jsonl")
  // One-time confirm that a name change on an already-registered id is a real
  // rename, not a copied folder (the server's rename guard refuses it otherwise).
  const confirmRename = hasFlag("--rename")

  // Local pre-flight — fail fast, offline, with teaching errors.
  const placeholders = findPlaceholders(agentJson)
  if (placeholders.length) {
    return fail(
      `agent.json still has template placeholders (${placeholders.map((p) => p.path).join(", ")}) — fill them in; \`figs doctor\` lists them`,
    )
  }
  const issues = validateOutbox(runs, asks, messages)
  if (issues.length) return fail(`local validation failed:\n  ${issues.join("\n  ")}`)

  const base = endpoint.replace(/\/+$/, "")
  let res
  try {
    res = await fetchT(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({
        workspaceId: config.workspaceId,
        agent,
        runs,
        asks,
        messages,
        ...(confirmRename ? { confirmRename: true } : {}),
      }),
    })
  } catch (e) {
    // Network/timeout — transient; the records are safe locally.
    return fail(`cannot reach ${base} (${netReason(e)})`, true)
  }
  const text = await res.text()
  // 4xx = the payload is wrong (re-pushing won't help) → structural; 5xx = transient.
  // The server's teaching message rides in { error } — surface that, not raw JSON.
  if (!res.ok) {
    let detail = text
    try {
      const body = JSON.parse(text)
      if (body?.error) detail = body.error
    } catch {
      // non-JSON body — keep the raw text
    }
    return fail(`server rejected it (${res.status}): ${detail}`, res.status >= 500)
  }
  console.log(
    `figs: ✓ pushed ${agent.name ?? agent.id} — ${runs.length} runs, ${asks.length} asks, ${messages.length} messages`,
  )
  // The wow-moment link — relay this to your human so they can see the agent.
  console.log(`       view at ${base}/w/${config.workspaceId}`)

  // The spine landed; an artifact-stage failure is transient/oversize — retry.
  return (await pushArtifacts(base, token, config))
    ? { ok: true }
    : { ok: false, retryable: true }
}

/**
 * Upload the files attached anywhere in the journal. Collected from the RAW
 * lines (not the folded records) so a file attached at a checkpoint isn't lost
 * when a later report folds over it — attachments belong to their moment. The
 * spine ingest is JSON-only; files go to a separate content-addressed endpoint
 * (an unchanged file is skipped server-side), base64-encoded so any type
 * survives. A **server rejection** (auth/size) is fatal; a **missing local
 * file** is only a warning (the agent referenced something it didn't produce).
 */
async function pushArtifacts(base, token, config) {
  const names = [
    ...new Set(
      [...readJsonl("runs.jsonl"), ...readJsonl("asks.jsonl")].flatMap(attachmentsOf),
    ),
  ]
  if (names.length === 0) return true

  let uploaded = 0
  let unchanged = 0
  let missing = 0
  let failed = 0
  for (const name of names) {
    const p = join(repoDir, "artifacts", name)
    if (!existsSync(p)) {
      console.warn(`figs: ! artifact missing, skipped: artifacts/${name}`)
      missing++
      continue
    }
    const content = readFileSync(p).toString("base64")
    let res
    try {
      res = await fetchT(`${base}/api/artifacts/upload`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({
          workspaceId: config.workspaceId,
          agentId: config.agentId,
          name,
          content,
        }),
      })
    } catch (e) {
      console.error(`figs: ✗ artifact upload failed ${name}: ${netReason(e)}`)
      failed++
      continue
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      const hint =
        res.status === 413 ? " — too large (>3 MB); compress or split it" : ""
      console.error(
        `figs: ✗ artifact upload failed (${res.status}) ${name}${hint}${t ? `: ${t}` : ""}`,
      )
      failed++
      continue
    }
    const body = await res.json().catch(() => ({}))
    if (body.unchanged) unchanged++
    else uploaded++
  }
  console.log(
    `figs: ${failed ? "✗" : "✓"} artifacts — ${uploaded} uploaded, ${unchanged} unchanged` +
      (missing ? `, ${missing} missing` : "") +
      (failed ? `, ${failed} failed` : ""),
  )
  // The spine already landed; a false return lets the caller exit non-zero so
  // an agent's run loop can catch that an artifact the manager needs to read
  // did not publish.
  return failed === 0
}

function readJsonl(name) {
  const p = join(repoDir, name)
  if (!existsSync(p)) return []
  const lines = readFileSync(p, "utf8").split("\n")
  // A process killed mid-append leaves a half-written FINAL line — the journal
  // must survive the agent dying while writing it. Tolerate exactly one broken
  // last (non-empty) line: warn + skip, keep the rest. A broken INTERIOR line is
  // real corruption — die loudly. (`name` files are append-only, so only the
  // tail can be torn.)
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastNonEmpty = i
      break
    }
  }
  const out = []
  lines.forEach((line, i) => {
    const s = line.trim()
    if (!s) return
    try {
      out.push(JSON.parse(s))
    } catch {
      if (i === lastNonEmpty) {
        console.warn(
          `figs: ! last line of .figs/${name} is broken — likely a crash mid-write; skipped it (re-record that entry). The rest is intact.`,
        )
      } else {
        die(`malformed JSON in .figs/${name} line ${i + 1}: ${s.slice(0, 80)}`)
      }
    }
  })
  return out
}

/** Fold append-only records by id — latest line wins. */
function foldById(rows) {
  const m = new Map()
  for (const r of rows) m.set(r.id, { ...(m.get(r.id) ?? {}), ...r })
  return [...m.values()]
}
