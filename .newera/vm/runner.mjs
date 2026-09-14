// .newera/vm/runner.mjs — NewEra headless coding agent v4.1 (runs inside GitHub Actions).
// Self-contained: Node 20 built-ins only. Model access is proxied through the
// NewEra control plane, so no model API keys ever enter this VM.
//
// v4: unified TASK CONTRACT (scope lock + live contract relay + finish gates),
// START PROTOCOL, think/todo/grep tools, plan echo on every observation,
// machine-enforced delivery freeze after contract completion, admin prompt
// override via NEWERA_VM_PROMPT_B64, and green-verification tracking.
// v3.6: finish aliases (final_output & friends), graceful 409 cancellation,
// fetch+rebase progress pushes, boot-time zombie killer, Next.js
// static-export self-heal, auto-matched skills, and WORKLOG.md — the
// durable cross-VM session memory (relay/resume VMs read it on boot).
// v2: parallel sub-agents, rolling-summary context management, VM relay
// (checkpoint + handoff + continuation on a fresh VM, max 2 relays), and
// deploy-to-Cloudflare after a verified green build.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
const execFileAsync = promisify(execFile);

const API = (process.env.NEWERA_API_URL || "").replace(/\/$/, "");
const JOB_ID = process.env.NEWERA_JOB_ID || "";
const TOKEN = process.env.NEWERA_JOB_TOKEN || "";
const TASK = Buffer.from(process.env.NEWERA_TASK_B64 || "", "base64").toString("utf8");
const MAX_MINUTES = Math.max(5, Number(process.env.NEWERA_MAX_MINUTES) || 30);
const DEADLINE = Date.now() + Math.max(5, MAX_MINUTES - 6) * 60 * 1000;
const MAX_STEPS = 600;
// Resume-chain handoff (resume_vm_agent): the EXPLICIT continuation path
// seeds this VM with the previous session handoff via NEWERA_HANDOFF_B64.
// Relay children get their continuation embedded in TASK instead, so this
// stays empty there. When present, the first message points the agent at
// the handoff and forbids redoing committed work.
const HANDOFF = Buffer.from(process.env.NEWERA_HANDOFF_B64 || "", "base64").toString("utf8").trim();
// v4: admin override of the VM system prompt (AdminConfig.vmPromptOverride).
// Base64 env wiring — YAML injection can never reach the prompt text.
const CUSTOM_PROMPT = (function () {
  try {
    var raw = process.env.NEWERA_VM_PROMPT_B64 || "";
    if (!raw) return "";
    var text = Buffer.from(raw, "base64").toString("utf8").trim();
    return text.length > 200 ? text : "";
  } catch (e) { return ""; }
})();
// v4: the unified TASK CONTRACT — the requirement matrix the user approved.
// The chat orchestrator and this VM share it; update_contract relays live
// status back, and the finish gate refuses to close the job while a
// mandatory requirement lacks completion evidence.
const CONTRACT = (function () {
  try {
    var raw = process.env.NEWERA_CONTRACT_B64 || "";
    if (!raw) return null;
    var doc = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return doc && Array.isArray(doc.requirements) ? doc : null;
  } catch (e) { return null; }
})();
const REPO = process.env.GITHUB_REPOSITORY || "";
const GIT_TOKEN = process.env.GITHUB_TOKEN || "";
const ROOT = process.cwd();

// ---------- relay: a chain of VMs for long-horizon work ----------
// RELAY_INDEX 0 = the original job; 1..2 are continuations. The control
// plane refuses to chain past MAX_RELAYS, and so does the runner.
const RELAY_INDEX = Math.max(0, Number(process.env.NEWERA_RELAY_INDEX) || 0);
const MAX_RELAYS = 2;
// The wrap-up checkpoint: this many minutes before the soft deadline the
// runner stops STARTING new work, writes the handoff, commits, and asks
// the control plane to boot the next VM. For a 240-minute budget this
// fires at about 3h39m — the VM is never killed mid-edit.
const RELAY_CHECKPOINT_MIN = 15;
// Only long-horizon jobs relay. A default 30-minute job that runs out of
// time ends honestly as unfinished instead of silently chaining on.
const RELAY_MIN_JOB_MINUTES = 45;
let relayDispatched = false;

// ---------- machine-enforced deploy (v3.5 "ship immediately") ----------
// The dispatch bakes the user-approved subdomain in as NEWERA_DEPLOY_SUBDOMAIN;
// the harness re-checks it at every wind-down (ensureDeployRequested), so an
// approved deploy can no longer be silently skipped by a forgetful model.
const DEPLOY_SUBDOMAIN = (process.env.NEWERA_DEPLOY_SUBDOMAIN || "").trim().toLowerCase();
let deployRequested = false;

  // ---------- v3.6: finish aliases ----------
  // Models raised on other harnesses invent completion verbs — final_output
  // was the exact name that killed a live job with "unknown tool" at its
  // LAST step. Every plausible completion verb now lands in finish{summary},
  // with the summary picked from whichever arg the model actually supplied.
  const FINISH_ALIASES = {
    finish: true, final_output: true, final_report: true, final_result: true,
    finalanswer: true, complete: true, completed: true, done: true, stop: true,
    task_complete: true, submit_final: true, end_task: true, finish_task: true,
  };
  function isFinishTool(name) {
    var n = String(name || "").trim().toLowerCase();
    return FINISH_ALIASES[n] === true;
  }

  // ---------- v3.6: WORKLOG — durable cross-VM session memory ----------
  // Every VM in this job chain appends its steps and wind-downs to
  // .newera/vm/WORKLOG.md; relay and resumed VMs read it on boot so no VM
  // ever redoes work a previous VM already committed. Same contract as the
  // operator worklog that keeps human agent sessions coherent.
  const WORKLOG_PATH = path.join(ROOT, ".newera", "vm", "WORKLOG.md");
  const WORKLOG_HEADER = "# VM Agent Worklog\n\nDurable session memory for this VM job chain. Each line is one step or wind-down from one VM. Read it on boot; never delete it.\n";
  function worklogAppend(entry) {
    try {
      var stamp = new Date().toISOString();
      var line = "- [" + stamp + " | VM " + (RELAY_INDEX + 1) + "/" + (MAX_RELAYS + 1) + "] " + String(entry).replace(/[\r\n]+/g, " ").slice(0, 400) + "\n";
      var current = "";
      try { current = fs.readFileSync(WORKLOG_PATH, "utf8"); } catch (e) {}
      if (!current.trim()) current = WORKLOG_HEADER;
      var next = current + line;
      // Cap: keep the header + the newest 400 lines, so a 3-VM 12-hour
      // chain cannot grow the file without bound.
      if (next.length > 60000) {
        var linesArr = next.split("\n");
        next = WORKLOG_HEADER + "\n" + linesArr.slice(Math.max(0, linesArr.length - 400)).join("\n");
      }
      fs.mkdirSync(path.dirname(WORKLOG_PATH), { recursive: true });
      fs.writeFileSync(WORKLOG_PATH, next, "utf8");
    } catch (e) {}
  }

  // ---------- v4.1: BOOT SELF-CHECK — verify the environment with facts ----------
  // The live failure this kills: on jobs vm-mtjyv21e and vm-mtjywj88 the
  // model FIRST reply claimed "no repository or execution tools are
  // available" and finalized, ending a 240-minute job after ~60 seconds
  // with zero work — while this runner had a working shell, a checked-out
  // repo and all 17 tools. A model that starts from a false belief never
  // self-corrects, so the harness runs REAL commands at boot and hands
  // the results to the model as verified facts.
  var SELF_CHECK_FACTS = "(self-check not yet run)";
  function runSelfCheck() {
    var lines = [];
    var degraded = false;
    function sh(cmd) {
      try {
        var r = spawnSync("bash", ["-lc", cmd], { cwd: ROOT, encoding: "utf8", timeout: 15000 });
        return r && r.status === 0 ? String(r.stdout || "").trim() : null;
      } catch (e) { return null; }
    }
    var shellOk = sh("echo shell-ok");
    if (shellOk !== "shell-ok") degraded = true;
    lines.push("shell: " + (shellOk === "shell-ok" ? "VERIFIED (the harness executed bash on this VM at boot)" : "FAILED"));
    var nodeV = sh("node --version");
    lines.push("node: " + (nodeV || "not found"));
    var npmV = sh("npm --version");
    lines.push("npm: " + (npmV || "not found"));
    var pyV = sh("python3 --version");
    lines.push("python3: " + (pyV || "not found"));
    var gitSha = sh("git rev-parse --short HEAD");
    lines.push("git: " + (gitSha ? "repo checked out @ " + gitSha : "no commits yet (greenfield repo)"));
    var fsOk = false;
    var probe = path.join(ROOT, ".newera", "vm", ".selfcheck-probe");
    try {
      fs.mkdirSync(path.dirname(probe), { recursive: true });
      fs.writeFileSync(probe, "probe-ok", "utf8");
      fsOk = fs.readFileSync(probe, "utf8") === "probe-ok";
      fs.rmSync(probe, { force: true });
    } catch (e) { fsOk = false; }
    if (!fsOk) degraded = true;
    lines.push("filesystem: " + (fsOk ? "WRITABLE (the harness wrote + read back a probe file)" : "PROBE FAILED"));
    var skillsCount = 0;
    try {
      skillsCount = fs.readdirSync(SKILLS_DIR).filter(function (n) { return n.endsWith(".md"); }).length;
    } catch (e) {}
    lines.push("skills: " + skillsCount + " knowledge docs in .newera/skills/ (list_skills / read_skill)");
    return { degraded: degraded, lines: lines };
  }

  // ---------- v4.1: TOOLS DIGEST — the protocol survives system-message loss ----------
  // The TOOLS catalog normally lives in the system prompt. If the provider
  // chat template, an admin prompt override, or any proxy layer drops or
  // mangles the system message, the model sees ONLY user messages — and
  // honestly concludes it has no tools (the exact observed failure). The
  // first USER message therefore carries the boot facts + the protocol +
  // the tool list too, so the model can act no matter what happened to the
  // system message. Belt and braces: the control plane also re-checks.
  const TOOLS_DIGEST = [
    "## ENVIRONMENT — VERIFIED BY THE HARNESS AT BOOT (facts, not assumptions)",
    "__SELFCHECK__",
    "",
    "You are NOT a text-only chat: you are running INSIDE that VM, and this loop dispatches REAL tools for you.",
    "Every reply is EXACTLY ONE JSON object — no prose, no markdown fences:",
    "{\"thought\":\"...\",\"action\":{\"tool\":\"...\",\"args\":{...}}}",
    "or, ONLY when the task is genuinely complete: {\"thought\":\"...\",\"final\":\"complete summary\"}",
    "TOOLS: shell{command,timeout_minutes?} list_files{path?} list_skills{} read_skill{name} read_file{path,start?,end?} grep{pattern,path?,glob?} write_file{path,content} append_file{path,content} edit_file{path,find,replace,all?} delete_file{path} think{notes} todo{steps} update_contract{requirement_id,status,evidence} spawn_agents{tasks} generate_image{prompt,path,size?} request_deploy{subdomain,mode?,build_output_path?} finish{summary}",
    "FRESH CHECKOUT RULE: this repo ships WITHOUT node_modules — run \"npm install\" (or pip install / flutter pub get) BEFORE any build/lint/test. \"command not found\" means you skipped the install, never that the toolchain is broken.",
    "A blocked claim is credible ONLY after you actually ran the tool and can quote its exact error text. Never claim tools or repository access is unavailable — the harness just proved they run.",
  ].join("\n");

  // ---------- v4.1: PREMATURE-FINAL GUARD — the false-finish detector ----------
  // Both failed jobs ended with a first-reply final that claimed the tools
  // do not exist. The harness now checks that claim against reality: the
  // shell IS verified working, the tools ARE dispatched by this very loop.
  // A finish with no real work behind it is a FALSE finish — rejected with
  // the boot evidence, twice max, then accepted under protest so a
  // genuinely broken job can still end honestly.
  var toolsExecuted = 0;
  var prematureFinalPushes = 0;
  var MAX_PREMATURE_PUSHES = 2;
  var NO_TOOLS_CLAIM_RE = /no (shell|tools?|execution|filesystem|repository|repo|tool)[\s\S]{0,120}(available|provided|access|exists?)|cannot (access|use)[\s\S]{0,60}(shell|tools?|filesystem|repository|repo)/i;
  function prematureFinalRejection(summaryText, where) {
    if (prematureFinalPushes >= MAX_PREMATURE_PUSHES) return null;
    var text = String(summaryText || "");
    var claimsNoTools = NO_TOOLS_CLAIM_RE.test(text);
    var mandatoryLeft = contractIncomplete().length;
    var tooEarly = toolsExecuted < 2;
    // Fire when the model claims it lacks tools (always false here — the
    // harness dispatches them and just proved the shell runs), or when a
    // contract job tries to finish before doing any real work.
    if (!claimsNoTools && !(tooEarly && CONTRACT && mandatoryLeft > 0)) return null;
    if (!claimsNoTools && toolsExecuted >= 2) return null;
    prematureFinalPushes++;
    worklogAppend("PREMATURE FINAL rejected (" + where + "): " + text.slice(0, 160));
    return "FINISH REJECTED (premature-final guard, " + where + "): your report claims " +
      (claimsNoTools ? "tools/repository access is unavailable — that is FACTUALLY WRONG for this VM" : "the task is blocked before any real work happened") +
      ". Proof from the boot self-check (real commands executed by this harness on this very VM): " + SELF_CHECK_FACTS +
      ". Tool calls YOU have actually executed so far: " + toolsExecuted + ". " +
      "The tools are dispatched by this loop and they exist. If a specific tool errors, RUN it and quote the exact error text as the blocker — a blanket no-tools claim is a false finish, not evidence. " +
      "Reply now with ONE JSON tool call, for example: " +
      "{\"thought\":\"verify the environment myself\",\"action\":{\"tool\":\"shell\",\"args\":{\"command\":\"ls -la && node --version && git log --oneline | head -5\"}}}" +
      (CONTRACT && mandatoryLeft ? " Then continue the task: " + mandatoryLeft + " mandatory requirement(s) are still incomplete." : "");
  }

  // ---------- v4: PLAN (the todo tool) — the visible execution plan ----------
  // One step per contract requirement, exactly ONE in_progress at a time,
  // persisted to .newera/vm/PLAN.json so relays/resumes inherit it, and
  // echoed under every observation so a 40-step job never loses the thread.
  const PLAN_PATH = path.join(ROOT, ".newera", "vm", "PLAN.json");
  let PLAN = [];
  function planLoad() {
    try {
      if (fs.existsSync(PLAN_PATH)) PLAN = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8")) || [];
      if (!Array.isArray(PLAN)) PLAN = [];
    } catch (e) { PLAN = []; }
  }
  function planSave() {
    try {
      fs.mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
      fs.writeFileSync(PLAN_PATH, JSON.stringify(PLAN), "utf8");
    } catch (e) {}
  }
  function planRender() {
    if (!PLAN.length) return "";
    var out = ["## CURRENT PLAN (" + PLAN.length + " steps)"];
    var done = 0;
    for (var i = 0; i < PLAN.length; i++) {
      var s = PLAN[i] || {};
      var mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[~]" : s.status === "blocked" ? "[!]" : "[ ]";
      if (s.status === "done") done++;
      out.push((i + 1) + ". " + mark + " " + String(s.title || "step").slice(0, 90) + (s.requirement ? " (req " + s.requirement + ")" : "") + (s.status === "in_progress" ? "  <- NOW" : ""));
    }
    out.push(done + "/" + PLAN.length + " steps done");
    return out.join("\n");
  }
  function toolTodo(args) {
    var steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) return { ok: false, output: "todo requires steps:[{title, status?, requirement?}] — one entry per planned step, requirement ids from the task contract." };
    if (steps.length > 40) steps = steps.slice(0, 40);
    var inProgress = 0;
    var clean = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i] || {};
      var title = String(s.title || s.name || "").trim();
      if (!title) continue;
      var st = String(s.status || "pending");
      if (["pending", "in_progress", "done", "blocked"].indexOf(st) === -1) st = "pending";
      if (st === "in_progress") inProgress++;
      var entry = { title: title.slice(0, 160), status: st };
      if (s.requirement) entry.requirement = String(s.requirement).slice(0, 40);
      clean.push(entry);
    }
    if (!clean.length) return { ok: false, output: "todo requires steps with titles." };
    if (inProgress > 1) {
      return { ok: false, output: "Only ONE step may be in_progress at a time (you listed " + inProgress + "). The plan is a queue, not a set — fix the statuses and re-send todo." };
    }
    PLAN = clean;
    planSave();
    worklogAppend("PLAN updated: " + PLAN.length + " steps");
    return { ok: true, output: "Plan recorded (" + PLAN.length + " steps):\n" + planRender() };
  }

  // ---------- v4: contract helpers ----------
  function contractRequirements() {
    return CONTRACT && Array.isArray(CONTRACT.requirements) ? CONTRACT.requirements : [];
  }
  function contractRender() {
    var reqs = contractRequirements();
    if (!reqs.length) return "";
    var out = ["## TASK CONTRACT — the requirement matrix the user approved (SCOPE LOCK)"];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i] || {};
      out.push("- [" + String(r.status || "pending") + "] " + String(r.id || "?") + " — " + String(r.description || "").slice(0, 140) + (r.mandatory === false ? " (optional)" : " (MANDATORY)") + (r.acceptanceCriteria ? " | acceptance: " + String(r.acceptanceCriteria).slice(0, 120) : ""));
    }
    out.push("Work ONLY on these requirements — anything else is out of scope. Mark progress with update_contract. finish requires every MANDATORY requirement complete (or blocked with documented evidence).");
    return out.join("\n");
  }
  function contractIncomplete() {
    return contractRequirements().filter(function (r) {
      return r.mandatory !== false && r.status !== "complete" && r.status !== "deferred";
    });
  }
  function contractComplete() {
    var reqs = contractRequirements();
    return reqs.length > 0 && contractIncomplete().length === 0;
  }
  async function toolUpdateContract(args) {
    if (!CONTRACT) return { ok: false, output: "update_contract: this job carries no task contract (legacy brief) — continue with the build plan as written." };
    var id = String(args.requirement_id || args.id || "").trim();
    var status = String(args.status || "").trim();
    var evidence = String(args.evidence || "").trim();
    var valid = { pending: 1, in_progress: 1, complete: 1, blocked: 1, deferred: 1 };
    if (!id || !valid[status]) return { ok: false, output: "update_contract requires requirement_id and a status of pending | in_progress | complete | blocked | deferred." };
    var reqs = contractRequirements();
    var hit = null;
    for (var i = 0; i < reqs.length; i++) if (String(reqs[i].id) === id) hit = reqs[i];
    if (!hit) return { ok: false, output: "unknown requirement_id: " + id + " — the contract lists: " + reqs.map(function (r) { return String(r.id); }).join(", ") };
    hit.status = status;
    if (evidence) hit.evidenceRef = evidence.slice(0, 300);
    worklogAppend("CONTRACT " + id + " -> " + status + (evidence ? ": " + evidence.slice(0, 200) : ""));
    try {
      fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
      fs.writeFileSync(path.join(ROOT, ".newera", "vm", "contract.json"), JSON.stringify(CONTRACT, null, 2), "utf8");
    } catch (e) {}
    try {
      await apiPost("/api/vm/agent", { event: "contract_update", requirement_id: id, status: status, evidence: evidence.slice(0, 300) }, 30000);
    } catch (e) {
      log("[contract] live report failed (non-fatal): " + (e && e.message ? e.message : e));
    }
    var left = contractIncomplete();
    return {
      ok: true,
      output:
        "contract " + id + " marked " + status +
        (status === "complete" && left.length ? ". " + left.length + " mandatory requirement(s) still open." : contractComplete() ? ". ALL mandatory requirements complete — if the build is green and the deploy (if authorized) is requested, call finish NOW." : ""),
    };
  }

  // ---------- v4: verification tracker + delivery freeze ----------
  // wroteSinceVerify: a write landed after the last GREEN verification
  // command. The finish gate refuses to close a job whose latest edits
  // were never re-verified; the freeze blocks ALL writes once the contract
  // is complete and verification is current (the anti-freelancing lock).
  var wroteSinceVerify = false;
  // v4.2: BUILD-EVIDENCE GATE state. buildGreenThisSession flips true the
  // moment a real BUILD command exits 0 in THIS VM session. A fresh checkout
  // has no node_modules and no committed build output, so "the previous VM
  // built it" is not evidence — every session that delivers a buildable web
  // project must run install + build itself, the way an engineer at their own
  // terminal would before calling something shippable.
  var buildGreenThisSession = false;
  var buildGatePushes = 0;
  function isVerificationCommand(command) {
    var c = String(command || "").toLowerCase();
    if (/npm run (build|test)|yarn (build|test)|pnpm (build|test)|bun (test|run build)|next build|tsc |vitest|jest|pytest|mocha|flutter build|cargo (build|test)|go (build|test)|gradle (build|test)/.test(c)) return true;
    return /(typecheck|type-check)/.test(c);
  }
  function isBuildCommand(command) {
    var c = String(command || "").toLowerCase();
    return /npm run build|yarn build|pnpm build|bun run build|next build|vite build|flutter build|cargo build|go build|gradle build|make/.test(c);
  }
  function noteGreenVerification(command) {
    if (isVerificationCommand(command)) {
      wroteSinceVerify = false;
      if (isBuildCommand(command)) buildGreenThisSession = true;
      worklogAppend("VERIFIED green: " + String(command).slice(0, 160));
    }
  }
  // v4.2: does this repo define a build script (a buildable web/node
  // project)? Static/Python-only projects are exempt from the build gate.
  function webProjectBuildable() {
    try {
      var raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
      var pkg = JSON.parse(raw);
      return Boolean(pkg && pkg.scripts && typeof pkg.scripts.build === "string" && pkg.scripts.build.trim());
    } catch (e) { return false; }
  }
  function staticOutputExists() {
    try { return Boolean(guessStaticOutDir()); } catch (e) { return false; }
  }
  function writesFrozen() {
    if (!contractComplete()) return false;
    return !wroteSinceVerify;
  }
  function scopeLockMessage() {
    return "SCOPE LOCK: every contract requirement is complete and the build is green — this job is DELIVERED. Further file edits are forbidden (the user did not order them). Call finish{summary} with your delivery report. If a requirement is genuinely NOT met, first call update_contract{requirement_id, status:\"in_progress\"} with what is missing.";
  }
  var finishGatePushes = 0;
  function finishGateRejection(where) {
    if (finishGatePushes >= 2) return null;
    if (wroteSinceVerify) {
      finishGatePushes++;
      return "FINISH BLOCKED (verification gate, " + where + "): files changed but no build/test command has run GREEN since the last change. Run the project verification now (e.g. shell{command:\"npm run build\"}, plus the test suite if one exists) and then finish. Finishing without re-verifying edits is a false completion report.";
    }
    var missing = contractIncomplete();
    if (CONTRACT && missing.length) {
      finishGatePushes++;
      return "FINISH BLOCKED (contract gate, " + where + "): " + missing.length + " mandatory requirement(s) lack completion evidence: " + missing.slice(0, 5).map(function (r) { return String(r.id) + " (" + String(r.description || "").slice(0, 60) + ")"; }).join("; ") + ". Complete them and mark each complete via update_contract, or mark them blocked with the exact reason — blocked-with-evidence is an honest finish; a silent drop is not.";
    }
    // v4.2 — BUILD-EVIDENCE GATE: a buildable web project that was never
    // built green in this session (and has no static output on disk) is not
    // delivered. One pushback max, then honored, so a genuinely broken build
    // can still end honestly with the blocker documented.
    if (buildGatePushes < 1 && !buildGreenThisSession && !staticOutputExists() && webProjectBuildable() && toolsExecuted >= 2) {
      buildGatePushes++;
      worklogAppend("BUILD-EVIDENCE gate rejected " + where + ": buildable project never built green this session");
      return "FINISH BLOCKED (build-evidence gate, " + where + "): this repository defines package.json scripts.build, but NO build command has run green in this session and no static output directory exists on disk. A fresh VM checkout ships WITHOUT node_modules — run shell{command:\"npm install --no-audit --no-fund && npm run build\"} now, fix the first real error, and re-run until green. Building the deliverable before reporting it done is the core of this job, not optional polish. If the build is genuinely impossible, finish and document the exact blocker (quote the error text) — but never claim a buildable project is complete without having built it in this VM.";
    }
    return null;
  }

  // ---------- v4: think + grep ----------
  function toolThink(args) {
    var notes = String(args.notes || "").trim();
    if (!notes) return { ok: false, output: "think requires notes — what you know, what you are about to do, what could break." };
    worklogAppend("THINK: " + notes);
    return { ok: true, output: "Noted (drafted in the durable worklog). Proceed with the plan." };
  }
  function toolGrep(args) {
    var pattern = String(args.pattern || "");
    if (!pattern) return { ok: false, output: "grep requires pattern (a regex, passed to ripgrep as ONE argument — no shell quoting needed)." };
    var target = safePath(String(args.path || "."));
    var glob = args.glob ? String(args.glob) : "";
    var argv = ["--no-messages", "-n", "-S", "--max-count", "60"];
    if (glob) argv.push("--glob", glob);
    argv.push("-e", pattern, target);
    var res = null;
    try { res = spawnSync("rg", argv, { cwd: ROOT, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); } catch (e) { res = null; }
    if (!res || res.error || (res.status !== 0 && res.status !== 1)) {
      var fb = ["-rnE", "--color=never", pattern];
      if (glob) fb.push("--include", glob);
      fb.push(target);
      try { res = spawnSync("grep", fb, { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); } catch (e2) { res = null; }
    }
    if (!res) return { ok: false, output: "grep failed: no search binary (rg/grep) is available in this VM." };
    var out = String(res.stdout || "");
    var lines = out.split("\n").filter(function (l) { return l && l.indexOf("node_modules") === -1 && l.indexOf(".git/") === -1; });
    if (!lines.length) return { ok: true, output: "no matches for /" + pattern + "/" + (glob ? " in *" + glob : "") };
    return { ok: true, output: lines.slice(0, 60).join("\n") + (lines.length > 60 ? "\n... " + (lines.length - 60) + " more matches — narrow the pattern or set a glob" : "") };
  }

  // ---------- v4: worklog tail (boot orientation, zero tool calls) ----------
  function readWorklogTail(maxLines) {
    try {
      if (!fs.existsSync(WORKLOG_PATH)) return "";
      var raw = fs.readFileSync(WORKLOG_PATH, "utf8");
      var lines = raw.split("\n").filter(function (l) { return l.trim(); });
      return lines.slice(-maxLines).join("\n");
    } catch (e) { return ""; }
  }
  function worklogTail(maxLines) {
    try {
      var raw = fs.readFileSync(WORKLOG_PATH, "utf8");
      var lines = raw.split("\n").filter(function (l) { return l.trim(); });
      return lines.slice(-maxLines).join("\n") || "(worklog empty)";
    } catch (e) { return "(no worklog yet)"; }
  }

// ---------- sub-agents ----------
const SUB_CONCURRENCY = 3;
const SUB_MAX_STEPS = 40;
const SUB_MAX_PER_SPAWN = 6;
const SUB_MAX_MINUTES = 20;
// Sub-agents get a smaller context budget and a simple splice (no extra
// summarize calls — the parent compaction already carries the big picture).
const SUB_BUDGET_CHARS = 150000;

// ---------- context management (same shape as the browser loop) ----------
// ~480k chars is roughly 130k tokens of history — safely inside the
// smallest configured coder window (256k) once system+task+summary are
// counted. The middle is compacted through the summarize model.
const CONTEXT_BUDGET_CHARS = 480000;
const KEEP_TAIL = 14;
let rollingSummary = "";
let compactions = 0;

function log(line) {
  try { fs.appendFileSync("agent.log", line + "\n"); } catch (e) {}
  console.log(line);
}

function minutesLeft() { return Math.max(0, Math.round((DEADLINE - Date.now()) / 60000)); }

async function apiPost(pathname, body, timeoutMs) {
  const res = await fetch(API + pathname, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
      "X-Newera-Job": JOB_ID,
    },
    body: JSON.stringify(body),
    // Per-call deadline: model calls get 180 s (long generations are real);
    // progress reports 30 s; the default stays generous for safety.
    signal: AbortSignal.timeout(timeoutMs || 280000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) {
    const detail = (data && data.error) ? data.error : ("HTTP " + res.status + " " + text.slice(0, 200));
    const err = new Error("control plane: " + detail);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

// Lightweight GET with the same auth headers — used by the boot-time
// control-plane reachability check (fail fast instead of 25 silent
// minutes). It targets /api/vm/agent on purpose: the one path the app
// middleware leaves open to server-to-server callers, with its own
// per-job bearer auth — a 200 here proves the FULL callback chain (public
// URL + no protection wall + valid job token). v3.1 probed
// /api/vm/jobs/<id>, which is origin/token gated: in production the probe
// itself was 403'd and every job died at boot on a perfectly reachable
// deployment. The body is sniffed so a protection/challenge HTML page is
// reported as what it is instead of a bare status code.
async function apiGet(pathname, timeoutMs) {
  const res = await fetch(API + pathname, {
    headers: {
      Authorization: "Bearer " + TOKEN,
      "X-Newera-Job": JOB_ID,
    },
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const text = await res.text().catch(function () { return ""; });
  if (!res.ok) {
    const t = String(text || "").trim();
    const isHtml = t.length > 0 && t.charAt(0) === "<";
    const detail = "control plane: HTTP " + res.status + (isHtml ? " (an HTML protection/challenge page, not the app)" : " " + t.slice(0, 200));
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  // v3.6: return the parsed body when the control plane sends one (the
  // boot probe exposes job status + model + minutes left) so callers can
  // act on it; bare true keeps the old reachability-only contract.
  var data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return data || true;
}

// purpose: "steps" (the coder model — default) or "summarize" (the cheap
// rag model). The server picks the actual model id; the runner cannot shop.
//
// v3.6 — OUTPUT-CAP CONTINUATION (browser-loop parity). The proxy reports
// finish_reason; a reply that stopped at "length" is INCOMPLETE, and
// executing it anyway is exactly how half-written files and unterminated
// heredocs used to land ("here-document delimited by end-of-file", 89-line
// "complete" files). The runner now transparently continues a capped reply
// from the character it stopped at (up to MAX_CONTINUATIONS rounds) and
// hands back the assembled text. A still-capped reply then fails to parse,
// gets the shrink instruction, and is never executed as-is.
const CONTINUE_HINT = [
  "Your previous reply was cut off by the output token limit - it is INCOMPLETE.",
  "Continue it from EXACTLY the character where it stopped. Output only the remaining text:",
  "no preamble, no apology, no code fences, no repetition of what you already wrote,",
  "and do NOT start a new JSON object - you are finishing the one already in progress.",
].join(" ");
const MAX_CONTINUATIONS = 3;
async function callModel(messages, purpose) {
  let assembled = "";
  let msgs = messages;
  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const data = await apiPost("/api/vm/agent", { messages: msgs, purpose: purpose || "steps" }, 180000);
    if (typeof data.content !== "string" || !data.content.trim()) {
      throw new Error("empty model response");
    }
    assembled += data.content;
    if (data.finish_reason !== "length") return assembled;
    log("[model] reply hit the output cap - auto-continuing (round " + (round + 1) + " of " + MAX_CONTINUATIONS + ")");
    // Replay enough of the assembled text that the model can see which
    // structure it is inside (a third of the text, floored at 12k chars).
    const want = Math.max(12000, Math.floor(assembled.length / 3));
    msgs = messages.concat([
      { role: "assistant", content: assembled.slice(-want) },
      { role: "user", content: CONTINUE_HINT },
    ]);
  }
  return assembled;
}

function reportProgress(payload) {
  return apiPost("/api/vm/agent", { progress: payload }, 30000).catch(function (e) {
    log("[progress] failed: " + e.message);
  });
}

function reportFinal(summary, unfinished, handoff) {
  const body = { event: "final", summary: String(summary || "").slice(0, 8000), unfinished: Boolean(unfinished) };
  // Optional handoff: lets the control plane store a resumable continuation
  // brief on the job even when the auto-relay could not fire (short job,
  // relay budget spent) — resume_vm_agent then seeds the next VM from it.
  if (handoff && String(handoff).trim()) body.handoff = String(handoff).slice(0, 12000);
  return apiPost("/api/vm/agent", body, 30000).catch(function (e) {
    log("[final-report] failed: " + e.message);
  });
}

// Ask the control plane to boot the NEXT VM in this chain. The handoff (and
// all work so far) is already committed on the repo main branch, so the
// next VM simply checks it out and continues. Server-side this creates a
// child VmJob linked through nextJobId and dispatches the workflow.
function reportRelay(handoff) {
  return apiPost("/api/vm/agent", { event: "relay", handoff: String(handoff || "").slice(0, 24000) }, 30000).catch(function (e) {
    log("[relay] failed: " + e.message);
  });
}

// Register a deploy request with the control plane. Cloudflare keys never
// enter the VM: the browser side deploys the uploaded build-output artifact
// through the existing /api/deploy/cloudflare route after the run completes.
// v3.5: a dropped deploy_request means the site never ships even when the
// final summary claims it did (that exact failure ended a live job). So it
// retries (3 attempts with backoff) and RETURNS whether it landed; the
// caller reports failure honestly instead of ok:true.
async function reportDeployRequest(subdomain, mode) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await apiPost("/api/vm/agent", { event: "deploy_request", subdomain: subdomain, mode: mode }, 30000);
      if (res && res.ok) return { ok: true };
      lastErr = new Error("control plane rejected the request");
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) await new Promise(function (r) { setTimeout(r, 3000 * attempt); });
  }
  return { ok: false, error: lastErr ? lastErr.message : "unknown error" };
}

// ---------- filesystem helpers (all paths stay inside the repo) ----------
function safePath(raw) {
  const p = String(raw || "").replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, p);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("path escapes the repository: " + raw);
  }
  return resolved;
}

function listFilesTree(dir, depth, prefix, out) {
  if (out.length > 400) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".venv" || e.name === "__pycache__") continue;
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) {
      out.push(rel + "/");
      if (depth > 0) listFilesTree(path.join(dir, e.name), depth - 1, rel, out);
    } else {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch (err) {}
      out.push(rel + " (" + size + "b)");
    }
  }
}

function toolListFiles(args) {
  const dir = safePath(args.path || ".");
  const out = [];
  listFilesTree(dir, 4, "", out);
  return { ok: true, output: out.length ? out.join("\n") : "(empty directory)" };
}

/* ---- VM skill pack (.newera/skills/) -------------------------------- *
 * list_skills: one-line catalog (name — description).
 * read_skill: full body, capped, greenfield guidance points here. */
const SKILLS_DIR = ".newera/skills";
function skillCatalog() {
  const out = [];
  try {
    const names = fs.readdirSync(SKILLS_DIR).filter(function (n) { return n.endsWith(".md"); }).sort();
    for (const n of names) {
      let desc = "";
      try {
        const raw = fs.readFileSync(SKILLS_DIR + "/" + n, "utf8");
        const m = raw.match(/^description:s*(.+)$/m);
        if (m) desc = m[1].trim().slice(0, 160);
        else {
          const h = raw.match(/^#s*(.+)$/m);
          if (h) desc = h[1].trim().slice(0, 160);
        }
      } catch (e) {}
      out.push("- " + n.replace(/.md$/, "") + (desc ? " — " + desc : ""));
    }
  } catch (e) {
    return "(no skills bundled in this job)";
  }
  return out.length ? "Available skills (read_skill{name}):\n" + out.join("\n") : "(no skills bundled in this job)";
}
function toolListSkills() {
  return { ok: true, output: skillCatalog() };
}
function toolReadSkill(args) {
  const name = String(args.name || "").trim().replace(/.md$/, "");
  if (!name) return { ok: false, output: "name is required — call list_skills first" };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, output: "invalid skill name" };
  const p = safePath(SKILLS_DIR + "/" + name + ".md");
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { ok: false, output: "skill not found: " + name + "\n" + skillCatalog() };
  }
  const st = fs.statSync(p);
  if (st.size > 200 * 1024) return { ok: false, output: "skill too large (" + st.size + "b) — read in slices" };
  const raw = fs.readFileSync(p, "utf8");
  const lines = raw.split("\n");
  const start = Math.max(1, Number(args.start) || 1);
  const end = Math.min(lines.length, Number(args.end) || start + 499);
  const body = lines.slice(start - 1, end).map(function (l, i) { return (start + i) + ": " + l; }).join("\n");
  return {
    ok: true,
    output: "skill " + name + " [lines " + start + "-" + end + " of " + lines.length + "]\n" + body +
      (end < lines.length ? "\n[more — read with start=" + (end + 1) + "]" : ""),
  };
}

  // v3.6: auto-matched skills. The browser agent gets its skills
  // auto-loaded; the VM agent gets the same treatment — the task text is
  // matched against the bundled skill names and the first user message
  // names the docs to read_skill FIRST, so no VM burns its opening steps
  // browsing the catalog.
  function suggestedSkills() {
    var names = [];
    try {
      names = fs.readdirSync(SKILLS_DIR)
        .filter(function (n) { return n.endsWith(".md"); })
        .map(function (n) { return n.replace(/\.md$/, ""); });
    } catch (e) { return []; }
    var t = TASK.toLowerCase();
    var hints = [
      [/next\.?js|app\s?router|app-router|full\s?stack/, "nextjs-app-router"],
      [/vite|single page app|\bspa\b/, "react-vite-spa"],
      [/express|rest api|webhook|node api|backend service/, "node-express-api"],
      [/flutter|dart|cross-platform mobile/, "flutter-web"],
      [/python|pip |pytest|scraper|data pipeline/, "python-project"],
      [/brutal|neo-brutal|bold .*design/, "style-brutalism"],
      [/glass|frosted|blur/, "style-glassmorphism"],
      [/dark|terminal|editor|tool .*interface|hacker/, "style-futuristic"],
      [/minimal|clean|whitespace|swiss/, "style-minimal"],
      [/color|palette|theme/, "craft-color"],
      [/accessib|a11y|screen reader|contrast/, "craft-accessibility"],
      [/form|input|validation/, "craft-form-validation"],
      [/animation|motion|transition/, "craft-animation-discipline"],
    ];
    var out = [];
    for (var i = 0; i < hints.length; i++) {
      if (hints[i][0].test(t) && names.indexOf(hints[i][1]) !== -1) out.push(hints[i][1]);
    }
    // craft-anti-ai-slop rides along for ANY UI work — the single
    // highest-leverage doc in the pack.
    if (/ui|page|site|app|component|landing|dashboard|website/.test(t) && names.indexOf("craft-anti-ai-slop") !== -1) {
      out.push("craft-anti-ai-slop");
    }
    return out.slice(0, 4);
  }

function toolReadFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return { ok: false, output: "file not found: " + args.path };
  const st = fs.statSync(p);
  if (st.size > 2 * 1024 * 1024) return { ok: false, output: "file is larger than 2 MB (" + st.size + " bytes) — read it in slices with shell tools" };
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const start = Math.max(1, Number(args.start) || 1);
  const end = Math.min(lines.length, Number(args.end) || start + 399);
  const body = lines.slice(start - 1, end).map(function (l, i) { return (start + i) + ": " + l; }).join("\n");
  return {
    ok: true,
    output: args.path + " [lines " + start + "-" + end + " of " + lines.length + "]\n" + body +
      (end < lines.length ? "\n[more lines follow — read with start=" + (end + 1) + "]" : ""),
  };
}

function toolWriteFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  if (typeof args.content !== "string") return { ok: false, output: "content (string) is required" };
  const p = safePath(args.path);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, args.content, "utf8");
  const n = args.content.split("\n").length;
  return { ok: true, output: "wrote " + args.path + " (" + n + " lines)" };
}

  // v3.5: append_file — the second half of chunked writing. A model writing a
  // 300-line component as ONE JSON string loses the whole file to a single
  // bad escape (that is exactly what aborted job vm-mthaobjs-m7o40p4t at
  // step 45). write_file the first chunk, append_file the rest: each chunk
  // is small enough to survive, and a broken one only costs one chunk.
function toolAppendFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  if (typeof args.content !== "string" || !args.content) {
    return { ok: false, output: "content (string) is required and must not be empty" };
  }
  const p = safePath(args.path);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { ok: false, output: "file not found: " + args.path + " — create it with write_file first, then append chunks" };
  }
  const current = fs.readFileSync(p, "utf8");
  const joiner = current && !current.endsWith("\n") ? "\n" : "";
  const next = current + joiner + args.content;
  fs.writeFileSync(p, next, "utf8");
  return {
    ok: true,
    output: "appended " + args.content.split("\n").length + " lines to " + args.path + " (now " + next.split("\n").length + " lines, " + next.length + " chars)",
  };
}

  // v3.5: generate_image — real raster assets for the UI. The image model is
  // called through the control plane ({event:"generate_image"}), so image API
  // keys never enter the VM; the runner receives a data URI and writes the
  // bytes. Cap: 12 images per job (the control plane enforces it too).
const MAX_IMAGES = 12;
let imagesGenerated = 0;
async function toolGenerateImage(args) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) {
    return { ok: false, output: "prompt is required — describe the image: subject, style, palette, composition" };
  }
  if (prompt.length > 2000) return { ok: false, output: "prompt too long (" + prompt.length + " chars, max 2000)" };
  const rawPath = String(args.path || "").trim();
  if (!rawPath) return { ok: false, output: "path is required — where to save, e.g. public/og-image.png" };
  if (!/\.(png|jpe?g|webp)$/i.test(rawPath)) {
    return { ok: false, output: "path must end in .png, .jpg or .webp (got: " + rawPath + ")" };
  }
  if (imagesGenerated >= MAX_IMAGES) {
    return { ok: false, output: "image budget reached (" + MAX_IMAGES + ") — keep the assets you already generated" };
  }
  const p = safePath(rawPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let data;
  try {
    data = await apiPost("/api/vm/agent", { event: "generate_image", prompt: prompt, size: args.size ? String(args.size) : undefined }, 90000);
  } catch (err) {
    return { ok: false, output: "image generation failed (control plane): " + (err.message || String(err)) + " — continue without the asset rather than retrying repeatedly" };
  }
  const image = data && data.image;
  if (typeof image !== "string" || image.indexOf("data:image/") !== 0) {
    return {
      ok: false,
      output: "image generation failed: " + (data && data.error ? data.error : "no image in the control-plane response") + " — continue without the asset rather than retrying repeatedly",
    };
  }
  const b64 = image.slice(image.indexOf(",") + 1);
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(p, buf);
  imagesGenerated++;
  return {
    ok: true,
    output: "generated image saved to " + rawPath + " (" + Math.max(1, Math.round(buf.length / 1024)) + " KB; image " + imagesGenerated + " of " + MAX_IMAGES + ")",
  };
}

function toolEditFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  if (typeof args.find !== "string" || !args.find) return { ok: false, output: "find (string) is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p)) return { ok: false, output: "file not found: " + args.path };
  const current = fs.readFileSync(p, "utf8");
  const find = args.find;
  const replace = typeof args.replace === "string" ? args.replace : "";
  const occurrences = current.split(find).length - 1;
  if (occurrences === 0) return { ok: false, output: "find text is not present in " + args.path };
  if (occurrences > 1 && args.all !== true) {
    return { ok: false, output: "find text matches " + occurrences + " places — add more surrounding lines to make it unique, or pass all:true" };
  }
  const next = args.all === true ? current.split(find).join(replace) : current.replace(find, replace);
  fs.writeFileSync(p, next, "utf8");
  return { ok: true, output: "patched " + args.path + " (" + occurrences + " occurrence(s) replaced)" };
}

function toolDeleteFile(args) {
  if (!args.path) return { ok: false, output: "path is required" };
  const p = safePath(args.path);
  if (!fs.existsSync(p)) return { ok: false, output: "file not found: " + args.path };
  fs.rmSync(p, { recursive: true });
  return { ok: true, output: "deleted " + args.path };
}

// v3.6 — HEREDOC BALANCE GUARD. The single most common truncated-command
// symptom in the live traces: bash warning "here-document at line 1
// delimited by end-of-file (wanted PYEOF)" — the model output was cut at
// the token cap, the repair path re-emitted a "valid" but incomplete JSON,
// and the runner happily executed a heredoc that never closes, writing a
// half file to disk. Every <<MARKER must reappear as a standalone line
// before the command is allowed to run.
function unbalancedHeredoc(command) {
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const marker = m[2];
    const closer = new RegExp("(^|\n)[ \t]*" + marker + "[ \t]*(\n|$)");
    if (!closer.test(command)) return marker;
  }
  return null;
}

async function toolShell(args, step) {
  const command = String(args.command || "").trim();
  if (!command) return { ok: false, output: "command is required" };
  const unbalanced = unbalancedHeredoc(command);
  if (unbalanced) {
    return {
      ok: false,
      output:
        "REFUSED: this command looks TRUNCATED - the heredoc marker " + unbalanced + " is never closed, so bash would write a HALF FILE and warn \"here-document delimited by end-of-file\". Your reply was probably cut off by the output limit. Re-issue the work in SMALLER pieces: write_file the first ~80 lines, then append_file the rest - or split the heredoc. Never re-send this command unchanged.",
    };
  }
  const requestedMin = Number(args.timeout_minutes) || 10;
  const timeoutMs = Math.min(30, Math.max(1, requestedMin)) * 60 * 1000;
  // Never let one command eat the packaging headroom or the relay window.
  const budgetMs = Math.max(60000, DEADLINE - Date.now() - 180000);
  const effMs = Math.min(timeoutMs, budgetMs);
  // spawn (not execFile) so long installs can REPORT progress instead of
  // looking like a hang: every 45s the last output line is pushed to the
  // control plane, which watch_vm_agent streams into the chat transcript.
  return await new Promise(function (resolve) {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CI: "1", NO_COLOR: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let lastLine = "";
    function onData(chunk) {
      out += String(chunk);
      if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024);
      const lines = out.split("\n").filter(function (l) { return l.trim(); });
      if (lines.length) lastLine = lines[lines.length - 1].slice(0, 160);
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let done = false;
    const heartbeat = setInterval(function () {
      reportProgress({
        step: step,
        lastTool: "shell",
        thought: "(still running)",
        lastResult: lastLine ? "running… " + lastLine : "running… (no output yet)",
        ok: true,
        minutesLeft: minutesLeft(),
      });
    }, 45000);
    const killTimer = setTimeout(function () { child.kill("SIGKILL"); }, effMs);
    function finish(code, signal) {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      const tail = (out || "").trim();
      if (code === 0) {
        noteGreenVerification(command);
        resolve({ ok: true, output: cap(tail || "(no output)") });
      } else {
        const why = code === null ? "killed by " + (signal || "timeout") : String(code);
        resolve({ ok: false, output: cap(tail + "\n[exit " + why + "]") });
      }
    }
    child.on("close", finish);
    child.on("error", function (err) {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearTimeout(killTimer);
      resolve({ ok: false, output: "spawn failed: " + (err.message || String(err)) });
    });
  });
}

// Write the run summary INTO THE REPO so the package artifact always
// carries it — collect_vm_agent reads it back and shows it to the user.
function writeResultSummary(text) {
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "result-summary.md"), "# VM agent result\n\n" + String(text || "") + "\n");
  } catch (e) {}
}

function cap(text) {
  const t = String(text || "");
  if (t.length <= 24000) return t || "(no output)";
  return t.slice(0, 14000) + "\n... [" + (t.length - 24000) + " chars elided] ...\n" + t.slice(-9000);
}

// ---------- JSON envelope parsing ----------
function extractJsonObjects(text) {
  const out = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

function parseTurn(raw) {
  const blocks = extractJsonObjects(raw);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(blocks[i]);
      if (obj && (obj.action || obj.final)) return obj;
    } catch (e) {}
  }
  return null;
}

  // ---------- v3.5: protocol repair -------------------------------------
  // A malformed reply no longer counts straight toward the 4-strike abort.
  // The jsonRepair model (selected server-side, temperature 0) re-emits the
  // reply as a valid JSON envelope — the same pass the browser loop has had
  // all along. Only when the repair ALSO fails does the strike count. The
  // input sent for repair is the TAIL of the raw reply: the JSON envelope a
  // model emits sits at the end; the head is usually reasoning prose.
const REPAIR_SYSTEM = [
  "You are a JSON repair tool for an autonomous coding agent.",
  "The input below is a model reply that was SUPPOSED to be exactly one JSON envelope but is malformed.",
  "Return ONLY the repaired JSON object — no prose, no markdown fences:",
  '{"thought":"...","action":{"tool":"...","args":{...}}}',
  "or, if the input is genuinely a final report:",
  '{"thought":"...","final":"..."}',
  "Rules: keep the original intent EXACTLY, including FULL file contents byte-for-byte (never summarize or truncate code); if the input describes an intention without emitting a tool call, convert it into the matching action; never invent an action the input did not imply; the output must contain action or final.",
].join("\n");

// Attempt-counted, not success-counted: a stream of failed repairs must not
// become an infinite paid loop on top of a broken model.
let repairsUsed = 0;
const MAX_REPAIRS = 10;

async function repairTurn(raw) {
  if (repairsUsed >= MAX_REPAIRS) return null;
  repairsUsed++;
  const tail = raw.length > 60000 ? raw.slice(raw.length - 60000) : raw;
  const data = await apiPost(
    "/api/vm/agent",
    {
      messages: [
        { role: "system", content: REPAIR_SYSTEM },
        { role: "user", content: "Repair this into valid JSON matching the schema above:\n\n" + tail },
      ],
      purpose: "repair",
    },
    180000
  );
  if (typeof data.content !== "string" || !data.content.trim()) return null;
  const turn = parseTurn(data.content);
  if (turn) log("[repair] recovered a malformed reply (" + raw.length + " chars) via the repair model");
  return turn;
}

// Repair errors are soft: a control-plane hiccup during repair must degrade
// to the plain protocol-reminder path, never crash the step.
async function safeRepair(raw) {
  try {
    return await repairTurn(raw);
  } catch (e) {
    return null;
  }
}

// ---------- git progress commits ----------
async function git(args) {
  return execFileAsync("git", args, { cwd: ROOT, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
}

  // v3.6: fetch+rebase push + token redaction. Two runners can
  // legitimately share a repo (relay overlap, a resumed session, a
  // re-dispatch that slipped past the guards) — a plain push then dies with
  // "fetch first" and the commit is silently LOST from the remote (it stays
  // local, but the next VM checks out the remote head). Rebase onto the
  // fetched head and retry. git embeds the token URL in some error messages, so
  // every logged message passes redactToken first.
  function redactToken(text) {
    return String(text || "").replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
  }
  async function pushWithRebase(remote, branch) {
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        await git(["push", remote, "HEAD:" + branch]);
        return true;
      } catch (err) {
        var msg = String((err && (err.stderr || err.message)) || "");
        if (/fetch first|non-fast-forward|failed to push|rejected/i.test(msg) && attempt < 3) {
          log("[git] push rejected (remote moved) — fetching + rebasing, attempt " + attempt + " of 3");
          worklogAppend("git push rejected (remote moved) — rebasing and retrying");
          try {
            await git(["fetch", remote, branch]);
            await git(["rebase", "FETCH_HEAD"]);
            continue;
          } catch (rerr) {
            log("[git] rebase failed: " + redactToken((rerr && (rerr.stderr || rerr.message)) || String(rerr)));
            return false;
          }
        }
        log("[git] push failed: " + redactToken(msg));
        return false;
      }
    }
    return false;
  }

async function gitCommitIfNeeded(label) {
  if (!GIT_TOKEN || !REPO) return;
  try {
    try {
      fs.mkdirSync(path.join(ROOT, ".git", "info"), { recursive: true });
      fs.appendFileSync(path.join(ROOT, ".git", "info", "exclude"), "node_modules/\n.venv/\n__pycache__/\n*.zip\nagent.log\n");
    } catch (e) {}
    await git(["add", "-A"]);
    const status = await git(["status", "--porcelain"]);
    if (!status.stdout.trim()) return;
    await git(["-c", "user.name=NewEra VM Agent", "-c", "user.email=newera-vm@users.noreply.github.com", "commit", "-m", label]);
    var remote = "https://x-access-token:" + GIT_TOKEN + "@github.com/" + REPO + ".git";
    var branch = process.env.GITHUB_REF_NAME || "main";
    var pushed = await pushWithRebase(remote, branch);
    if (pushed) log("[git] progress commit pushed: " + label);
    else log("[git] progress commit kept LOCAL only (push failed): " + label);
  } catch (err) {
    log("[git] progress commit skipped: " + (err.message || err));
  }
}

// ---------- rolling-summary context management ----------
// Ported from the browser loop (context/agent/summarize.ts): when history
// grows past the budget, the MIDDLE is handed to the cheap summarize model
// and replaced with one durable "## Progress so far" block. The head
// (system + task) and the freshest KEEP_TAIL messages stay verbatim. A
// multi-hour job therefore never forgets decisions, verified facts or file
// state — and the block doubles as the relay handoff skeleton.
const SUMMARY_MARKER = "## Progress so far";

const SUMMARY_PROMPT = [
  "You compress an autonomous coding agent working memory.",
  "Given the transcript below, produce a dense markdown brief with EXACTLY these sections:",
  "",
  "## Progress so far",
  "### Decisions",
  "- durable choices (stack, file layout, naming, trade-offs already settled)",
  "### Files written or changed",
  "- path — what it now contains",
  "### Verified facts",
  "- commands run + exit codes, URLs that work, errors already diagnosed",
  "### Open items",
  "- what still has to happen, in order",
  "",
  "Rules: no prose outside those sections, no speculation, keep every path, command,",
  "version number, port and error string exactly as written. Under 2500 characters.",
].join("\n");

function historyChars(history) {
  let n = 0;
  for (const m of history) n += String(m.content || "").length;
  return n;
}

async function compactHistory(history) {
  if (historyChars(history) <= CONTEXT_BUDGET_CHARS) return false;
  if (history.length <= 4 + KEEP_TAIL) return false;
  const keepHead = 2; // system + task
  const middle = history.slice(keepHead, history.length - KEEP_TAIL);
  const transcript = middle
    .map(function (m) { return m.role.toUpperCase() + ": " + m.content; })
    .filter(Boolean)
    .join("\n\n")
    .slice(-90000);
  try {
    const brief = await callModel([
      { role: "system", content: "You produce terse, dense memory briefs. No thinking tags, no prose outside the requested sections." },
      { role: "user", content: SUMMARY_PROMPT + "\n\n## TRANSCRIPT\n" + (rollingSummary ? "## Prior brief (carry its facts forward)\n" + rollingSummary + "\n\n" : "") + transcript },
    ], "summarize");
    if (brief && brief.trim()) {
      rollingSummary = brief.trim().slice(0, 6000);
      compactions++;
      log("[context] compacted: " + history.length + " -> " + (keepHead + 1 + KEEP_TAIL) + " messages (compaction #" + compactions + ")");
    }
  } catch (err) {
    log("[context] summarize failed, falling back to prune: " + err.message);
  }
  // Rebuild the history: head + rolling summary + fresh tail. When the
  // summarize call failed we still prune the middle (facts survive in the
  // prior summary if one exists, and in the repo itself).
  const tail = history.slice(history.length - KEEP_TAIL);
  const head = history.slice(0, keepHead);
  history.length = 0;
  for (const m of head) history.push(m);
  if (rollingSummary) {
    history.push({ role: "user", content: rollingSummary + "\n\n(This block is your durable memory of earlier steps — treat it as fact.)" });
  }
  for (const m of tail) history.push(m);
  return true;
}

// ---------- deploy after green build ----------
// The static output dirs the deploy pipeline understands (same order as
// pickStaticRoot on the server). guessStaticOutDir finds one that really
// holds an index.html so the artifact prefix matches what deploy expects.
const STATIC_OUT_DIRS = [".newera/out", "out", "build/web", "dist/public", "dist/static", "dist", "build", "public"];

function guessStaticOutDir() {
  for (const d of STATIC_OUT_DIRS) {
    const full = path.join(ROOT, d);
    try {
      if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "index.html"))) return d;
    } catch (e) {}
  }
  return null;
}

function sanitizeSubdomain(raw) {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  if (s.length < 3 || s.length > 63) return null;
  return s;
}

// v4.2: ask the control plane whether a subdomain is free BEFORE the
// request is recorded. Cloudflare keys stay on the control plane; a CF
// side fault returns unknown (never a false "taken" — a bogus conflict
// is what sent old flows into rename spirals).
async function checkSubdomainAvailable(subdomain) {
  try {
    const res = await apiPost("/api/vm/agent", { event: "deploy_check", subdomain: subdomain }, 20000);
    if (res && typeof res.available === "boolean") {
      return { checked: true, available: res.available, alternatives: Array.isArray(res.alternatives) ? res.alternatives.map(String) : [] };
    }
  } catch (e) {}
  return { checked: false, available: true, alternatives: [] };
}
async function toolRequestDeploy(args) {
  const subdomain = sanitizeSubdomain(args.subdomain);
  if (!subdomain) {
    return { ok: false, output: "request_deploy requires a valid subdomain (3-63 chars, letters/digits/hyphens). The URL will be subdomain.newera.page.dev." };
  }
  const mode = args.mode === "permanent" ? "permanent" : "preview";
  let outDir = null;
  if (typeof args.build_output_path === "string" && args.build_output_path.trim()) {
    const rel = String(args.build_output_path).replace(/^\/+/, "");
    const full = safePath(rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      return { ok: false, output: "build_output_path does not exist or is not a directory: " + rel + " — build FIRST, then request the deploy." };
    }
    outDir = rel;
  } else {
    outDir = guessStaticOutDir();
  }
  if (!outDir) {
    return { ok: false, output: "No static build output found (looked for: " + STATIC_OUT_DIRS.join(", ") + " with an index.html). Run the real build first, then request the deploy — a deploy without a verified build is forbidden." };
  }
  const indexPath = path.join(safePath(outDir), "index.html");
  if (!fs.existsSync(indexPath)) {
    return { ok: false, output: "No index.html inside " + outDir + " — this is not a deployable static site. Check the build output directory." };
  }
  // v4.2: availability pre-check — a taken name is reported with
  // alternatives BEFORE anything is recorded, so the agent retries with
  // a different name in one step instead of shipping a deploy request
  // that dies at Cloudflare time (the ingeditt4 failure mode).
  const avail = await checkSubdomainAvailable(subdomain);
  if (avail.checked && avail.available === false) {
    return {
      ok: false,
      output: "SUBDOMAIN TAKEN: " + subdomain + ".newera.page.dev is already in use (verified via the control plane). Alternatives: " + (avail.alternatives.length ? avail.alternatives.join(", ") : "(none suggested — pick a close variant like " + subdomain + "-app)") + ". The deploy was NOT requested. Call request_deploy AGAIN with an available subdomain — the new request replaces any previous one. If you cannot choose one yourself, finish and report the conflict; the orchestrator will ask the user.",
    };
  }
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "build-output-path.txt"), outDir + "\n", "utf8");
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "deploy-request.json"), JSON.stringify({ subdomain: subdomain, mode: mode, build_output: outDir, job: JOB_ID, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
  } catch (err) {
    return { ok: false, output: "could not write the deploy request file: " + (err.message || String(err)) };
  }
  const reported = await reportDeployRequest(subdomain, mode);
  if (!reported.ok) {
    return {
      ok: false,
      output: "DEPLOY REQUEST FAILED — the control plane never received it (" + reported.error + "). The deploy will NOT happen automatically. Retry request_deploy now; if it keeps failing, say clearly in your final summary that deployment is BLOCKED — never claim the site is live.",
    };
  }
  deployRequested = true;
  log("[deploy] requested: " + subdomain + " (" + mode + ") from " + outDir);
  return {
    ok: true,
    output: "Deploy CONFIRMED with the control plane for " + subdomain + ".newera.page.dev (" + mode + " mode, output: " + outDir + "). The workflow uploads the build output as an artifact when this job ends, and NewEra deploys it to Cloudflare Pages automatically — the live URL is delivered after this run. Cloudflare keys stay outside this VM by design. If this subdomain turns out to be wrong or taken later, call request_deploy AGAIN with a different name — the new request REPLACES this one; never re-build just to rename.",
  };
}

// ---------- machine-enforced deploy (v3.5 "ship immediately") ----------
// The trace that motivated this: a VM finished a green static build with a
// user-approved subdomain, then finished WITHOUT ever calling request_deploy
// — and its final summary calmly claimed the site was live at a URL that
// never existed. A deploy that depends on the model remembering its promise
// is not a deploy. So the harness fires it: at EVERY wind-down (finish tool,
// final reply, deadline, step limit, protocol abort) — if a subdomain was
// pre-approved, no deploy was requested yet, and a real static output with
// index.html exists — the RUNNER requests the deploy itself.
// toolRequestDeploy keeps the green-build rule and the honest failure reporting.
// v3.6 — NEXT.JS STATIC-EXPORT SELF-HEAL. A Next.js app built WITHOUT
// output:"export" produces only .next/ — no out/index.html — so the deploy
// stage used to give up with "no static output exists" even after a green
// build (the exact "[deploy] ... cannot auto-request" trace that shipped
// nothing). The harness now patches next.config to enable static export,
// rebuilds, and re-verifies out/index.html before giving up.
async function runBuildCommand(cmd, timeoutMs) {
  try {
    var res = await execFileAsync("bash", ["-lc", cmd], {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      env: Object.assign({}, process.env, { CI: "1", NO_COLOR: "1" }),
    });
    return { ok: true, tail: String(res.stdout || res.stderr || "").split("\n").slice(-15).join("\n") };
  } catch (err) {
    var t = String((err && (err.stdout || err.stderr || err.message)) || "");
    return { ok: false, tail: t.split("\n").slice(-15).join("\n") };
  }
}
function patchNextConfigForExport() {
  var candidates = ["next.config.mjs", "next.config.js", "next.config.ts"];
  for (var i = 0; i < candidates.length; i++) {
    var rel = candidates[i];
    var full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    var raw = "";
    try { raw = fs.readFileSync(full, "utf8"); } catch (e) { continue; }
    if (/output\s*:[^,}]*export/.test(raw)) {
      return { ok: true, file: rel, note: "already exporting" };
    }
    var add = "output: \"export\", images: { unoptimized: true },";
    var patched = null;
    var m = raw.match(/(const\s+nextConfig\s*=\s*\{)/);
    if (m) patched = raw.replace(m[1], m[1] + "\n  " + add);
    if (!patched) {
      m = raw.match(/(module\.exports\s*=\s*\{)/);
      if (m) patched = raw.replace(m[1], m[1] + "\n  " + add);
    }
    if (!patched) {
      m = raw.match(/(export\s+default\s*\{)/);
      if (m) patched = raw.replace(m[1], m[1] + "\n  " + add);
    }
    if (!patched) {
      m = raw.match(/(defineConfig\s*\(\s*\{)/);
      if (m) patched = raw.replace(m[1], m[1] + "\n  " + add);
    }
    if (!patched) {
      return { ok: false, file: rel, note: "config shape not recognized — patch it manually with output:\"export\"" };
    }
    try {
      fs.writeFileSync(full, patched, "utf8");
      return { ok: true, file: rel, note: "patched with output:\"export\" + images.unoptimized" };
    } catch (e) {
      return { ok: false, file: rel, note: "write failed: " + (e.message || e) };
    }
  }
  return { ok: false, file: "(none)", note: "no next.config.* found" };
}
async function healNextStaticExport(reason) {
  try {
    var pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
    var pkg = JSON.parse(pkgRaw);
    var deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
    if (!deps.next) return { healed: false, note: "not a Next.js project" };
    log("[deploy][heal] Next.js project without a static export — self-healing (" + reason + ")");
    worklogAppend("deploy self-heal: patching next.config for static export and rebuilding");
    var patch = patchNextConfigForExport();
    if (!patch.ok) {
      log("[deploy][heal] config patch failed: " + patch.note);
      return { healed: false, note: patch.note };
    }
    log("[deploy][heal] " + patch.file + ": " + patch.note);
    if (!fs.existsSync(path.join(ROOT, "node_modules", ".bin", "next"))) {
      var inst = await runBuildCommand("npm install --no-audit --no-fund", 10 * 60 * 1000);
      if (!inst.ok) {
        log("[deploy][heal] npm install failed — cannot rebuild");
        return { healed: false, note: "npm install failed during self-heal" };
      }
    }
    var build = await runBuildCommand("npm run build", 15 * 60 * 1000);
    log("[deploy][heal] rebuild " + (build.ok ? "ok" : "FAILED") + (build.tail ? "\n" + build.tail : ""));
    if (fs.existsSync(path.join(ROOT, "out", "index.html"))) {
      return { healed: true, note: "static export rebuilt: out/index.html exists" };
    }
    return { healed: false, note: "rebuild produced no out/index.html" + (build.tail ? "\n" + build.tail.slice(0, 500) : "") };
  } catch (e) {
    return { healed: false, note: "heal error: " + (e.message || String(e)) };
  }
}
async function ensureDeployRequested(reason) {
  if (!DEPLOY_SUBDOMAIN || deployRequested) return;
  var guess = guessStaticOutDir();
  if (!guess) {
    var healed = await healNextStaticExport(reason);
    if (healed && healed.healed) {
      guess = guessStaticOutDir();
      log("[deploy][heal] " + healed.note);
    } else if (healed && healed.note && healed.note !== "not a Next.js project") {
      log("[deploy][heal] could not self-heal a static export: " + healed.note);
    }
  }
  if (!guess) {
    log("[deploy] subdomain " + DEPLOY_SUBDOMAIN + " was pre-approved but no static output exists — cannot auto-request (" + reason + ")");
    return;
  }
  var res = await toolRequestDeploy({ subdomain: DEPLOY_SUBDOMAIN, mode: "permanent", build_output_path: guess });
  if (res && res.ok) {
    log("[deploy] harness auto-requested the approved deploy (" + reason + ")");
  } else {
    log("[deploy] harness auto-request FAILED (" + reason + "): " + String(res && res.output ? res.output : "unknown error"));
  }
}

// ---------- sub-agents ----------
// Each sub-agent is a full agent loop with its own context, its own file
// ownership and its own scratch folder, sharing the SAME tools and the SAME
// model proxy as the parent. They may not spawn further agents, may not
// finish the overall task and may not request deploys — those belong to the
// parent only. Bounded concurrency keeps 429s away.
const SUB_SYSTEM_PROMPT = [
  "You are a NewEra VM sub-agent — a focused software engineer working inside a real Ubuntu Linux VM (a GitHub Actions runner) alongside sibling agents.",
  "You have a real shell, the repository on disk, Node 20 + npm and Python 3 + pip (python3 -m pip).",
  "",
  "Every reply is EXACTLY ONE JSON object — no prose, no markdown fences:",
  '{"thought":"brief reasoning","action":{"tool":"<tool>","args":{...}}}',
  "or, when YOUR slice of the work is done:",
  '{"thought":"...","final":"what you did, commands run + exit codes, files changed, anything left"}',
  "",
  "TOOLS: shell{command, timeout_minutes?}, list_files{path?}, read_file{path,start?,end?}, grep{pattern,path?,glob?} (structured search — no shell quoting), think{notes} (draft before risky actions), write_file{path,content}, append_file{path,content}, edit_file{path,find,replace,all?}, delete_file{path}, generate_image{prompt,path,size?}. For files over ~120 lines: write_file the first chunk, then append_file the rest — one giant JSON string breaks the protocol.",
  "",
  "RULES:",
  "1. You may only MODIFY the files assigned to you (plus your scratch folder). Reads are unrestricted.",
  "2. Verify your own work: run the build/tests for your slice and fix real errors. Never claim success without a green command.",
  "3. Do not git commit or push — the harness commits. Never touch .github/workflows/ or .newera/.",
  "4. No long-running servers left alive: background them, curl them, kill them.",
  "5. Finish with an honest summary — partial is fine, silent failure is not.",
].join("\n");

function subScratchDir(name) {
  const safe = String(name || "agent").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return "work/" + (safe || "agent");
}

function subOwnershipError(action, owned, scratch) {
  const MUTATORS = ["write_file", "append_file", "edit_file", "delete_file", "generate_image"];
  if (MUTATORS.indexOf(action.tool) === -1) return null;
  const raw = String((action.args || {}).path || "");
  const rel = raw.replace(/^\/+/, "");
  if (!rel) return "path is missing";
  if (rel === scratch || rel.indexOf(scratch + "/") === 0) return null;
  for (const ownedPath of owned) {
    const o = String(ownedPath).replace(/^\/+/, "");
    if (rel === o || rel.indexOf(o + "/") === 0) return null;
  }
  return "Ownership violation: you may only modify " + owned.join(", ") + " (plus " + scratch + "/). Not " + rel + ".";
}

// Runs ONE sub-agent to completion. Returns a summary string. Progress is
// reported with the agent name in lastTool so the live feed shows the team.
async function runSubagent(spec, parentStep) {
  const name = String(spec.name || "agent");
  const task = String(spec.task || "").trim();
  if (!task) return "### " + name + "\nFAILED: no task text given.";
  const owned = Array.isArray(spec.files) ? spec.files.map(String) : [];
  const scratch = subScratchDir(name);
  const tree = [];
  listFilesTree(ROOT, 3, "", tree);
  const history = [
    { role: "system", content: SUB_SYSTEM_PROMPT },
    {
      role: "user",
      content: "YOUR SLICE OF THE WORK: " + task + "\n\n" +
        (owned.length ? "FILES YOU OWN (only you may modify these): " + owned.join(", ") + "\n" : "") +
        "SCRATCH FOLDER: " + scratch + "/ is yours alone for notes and drafts.\n" +
        "THE OVERALL TASK (context only — do your slice, not all of it):\n" + TASK.slice(0, 4000) + "\n\n" +
        "Repository tree (top):\n" + tree.slice(0, 120).join("\n") + "\n\nStart now. ONE JSON object per reply.",
    },
  ];
  const subDeadline = Math.min(Date.now() + SUB_MAX_MINUTES * 60000, DEADLINE - 8 * 60000);
  const parseFailures0 = { n: 0 };
  let summary = null;
  let step;
  for (step = 1; step <= SUB_MAX_STEPS; step++) {
    if (Date.now() >= subDeadline) {
      return "### " + name + "\nPARTIAL (out of time after " + step + " steps). " + (summary || "See the repo for partial work.");
    }
    let raw = "";
    let modelError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        raw = await callModel(history, "steps");
        modelError = null;
        break;
      } catch (err) {
        modelError = err;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        // v3.4: a 500 "no coder model configured" is a PERMANENT control-plane
        // misconfiguration — retrying with backoff only burns time before the
        // same abort. Stop after the first attempt; the abort message names the fix.
        if (err.status === 500 && /no coder model configured/.test(String(err.message || ""))) break;
        await new Promise(function (r) { setTimeout(r, 3000 * (attempt + 1)); });
      }
    }
    if (modelError) {
      return "### " + name + "\nFAILED (model proxy unreachable after 3 attempts): " + modelError.message;
    }
    // v3.5: same protocol-repair pass as the parent — a mangled big write
    // recovers instead of burning one of the 3 strikes.
    let turn = parseTurn(raw);
    if (!turn) turn = await safeRepair(raw);
    if (!turn) {
      parseFailures0.n++;
      history.push({ role: "assistant", content: raw.slice(0, 1500) });
      history.push({ role: "user", content: "PROTOCOL: reply with EXACTLY one JSON object: {\"thought\":\"...\",\"action\":{\"tool\":\"...\",\"args\":{...}}} — no prose." + (parseFailures0.n >= 2 ? " If the file is large, write it in CHUNKS: write_file the first ~80 lines, then append_file the rest." : "") });
      if (parseFailures0.n >= 3) return "### " + name + "\nFAILED (protocol violations x3).";
      continue;
    }
    if (turn.final) {
      return "### " + name + "\n" + String(turn.final).slice(0, 3000);
    }
    const action = turn.action || {};
    var toolName = String(action.tool || "").trim().toLowerCase();
    var args = action.args || {};
    // v3.6: completion aliases are reserved too — a sub-agent cannot end the
    // overall task under ANY name; it must use its own final summary.
    if (isFinishTool(toolName)) {
      history.push({ role: "user", content: "[" + toolName + "] is reserved for the parent agent (completion aliases included). Do the work yourself, or reply with your final summary as {\"final\": \"...\"}." });
      continue;
    }
    if (toolName === "spawn_agents" || toolName === "request_deploy") {
      history.push({ role: "user", content: "[" + toolName + "] is reserved for the parent agent. Do the work yourself, or reply with your final summary." });
      continue;
    }
    const ownership = subOwnershipError(action, owned, scratch);
    if (ownership) {
      history.push({ role: "user", content: "[ownership guard] " + ownership });
      continue;
    }
    await reportProgress({
      step: parentStep,
      lastTool: "[" + name + "] " + toolName,
      thought: String(turn.thought || "").slice(0, 200),
      lastResult: "(executing…)",
      ok: true,
      minutesLeft: minutesLeft(),
    });
    let result;
    try {
      if (toolName === "shell") result = await toolShell(args, parentStep);
      else if (toolName === "list_files") result = toolListFiles(args);
      else if (toolName === "list_skills") result = toolListSkills();
      else if (toolName === "read_skill") result = toolReadSkill(args);
      else if (toolName === "read_file") result = toolReadFile(args);
      else if (toolName === "grep") result = toolGrep(args);
      else if (toolName === "think") result = toolThink(args);
      else if (toolName === "write_file") result = toolWriteFile(args);
      else if (toolName === "append_file") result = toolAppendFile(args);
      else if (toolName === "edit_file") result = toolEditFile(args);
      else if (toolName === "delete_file") result = toolDeleteFile(args);
      else if (toolName === "generate_image") result = await toolGenerateImage(args);
      else result = { ok: false, output: "unknown tool: " + toolName + " — available: shell, list_files, list_skills, read_skill, read_file, grep, think, write_file, append_file, edit_file, delete_file, generate_image" };
    } catch (err) {
      result = { ok: false, output: "tool error: " + (err.message || String(err)) };
    }
    await reportProgress({
      step: parentStep,
      lastTool: "[" + name + "] " + toolName,
      thought: String(turn.thought || "").slice(0, 200),
      lastResult: String(result.output || "").slice(0, 400),
      ok: result.ok,
      minutesLeft: minutesLeft(),
    });
    history.push({ role: "assistant", content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 400), action: { tool: toolName, args: compactArgs(args) } }) });
    history.push({ role: "user", content: "[" + toolName + (result.ok ? " ok" : " FAILED") + "]\n" + cap(String(result.output || "")).slice(0, 8000) });
    // Sub-agent context: simple budget splice (head + tail kept).
    if (historyChars(history) > SUB_BUDGET_CHARS && history.length > 14) {
      const head = history.slice(0, 2);
      const tail = history.slice(-10);
      history.length = 0;
      for (const m of head) history.push(m);
      history.push({ role: "user", content: "[earlier steps elided to save context — the repo and your scratch notes hold the facts]" });
      for (const m of tail) history.push(m);
    }
  }
  return "### " + name + "\nPARTIAL (hit the " + SUB_MAX_STEPS + "-step limit). " + (summary || "See the repo for partial work.");
}

// spawn_agents{tasks:[{name, task, files?}]} — runs 1..6 sub-agents with
// bounded concurrency and returns one markdown block per agent. The parent
// BLOCKS until all agents finish (a VM job is single-purpose — fire and
// forget would let the parent finish the task while children still edit).
async function toolSpawnAgents(args, step) {
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (rawTasks.length === 0) {
    return { ok: false, output: "spawn_agents requires tasks: [{name, task, files}] — a non-empty array." };
  }
  if (rawTasks.length > SUB_MAX_PER_SPAWN) {
    return { ok: false, output: "Too many sub-agents (" + rawTasks.length + ", max " + SUB_MAX_PER_SPAWN + "). Split the work into fewer, bigger slices or do some yourself." };
  }
  if (minutesLeft() < 12) {
    return { ok: false, output: "Not enough time left (" + minutesLeft() + " min) to supervise sub-agents — do the critical work yourself and finish." };
  }
  const specs = [];
  const usedNames = {};
  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i] && typeof rawTasks[i] === "object" ? rawTasks[i] : {};
    let name = String(t.name || "agent-" + (i + 1)).slice(0, 40);
    let n = 2;
    while (usedNames[name]) { name = String(t.name || "agent-" + (i + 1)).slice(0, 36) + "-" + n; n++; }
    usedNames[name] = true;
    specs.push({ name: name, task: String(t.task || ""), files: Array.isArray(t.files) ? t.files.map(String) : [] });
  }
  // Ownership overlap check — two agents editing the same file is a caller bug.
  const owners = [];
  for (let i = 0; i < specs.length; i++) {
    for (const rawPath of specs[i].files) {
      const p = String(rawPath).replace(/^\/+/, "");
      for (let j = 0; j < owners.length; j++) {
        if (p === owners[j].path || p.indexOf(owners[j].path + "/") === 0 || owners[j].path.indexOf(p + "/") === 0) {
          return { ok: false, output: "Overlapping ownership: " + specs[owners[j].i].name + " owns " + owners[j].path + " and " + specs[i].name + " also wants " + p + ". Split the files." };
        }
      }
      owners.push({ path: p, i: i });
    }
  }
  log("[team] spawning " + specs.length + " sub-agent(s): " + specs.map(function (s) { return s.name; }).join(", "));
  await reportProgress({
    step: step,
    lastTool: "spawn_agents",
    thought: "dispatching " + specs.length + " sub-agent(s)",
    lastResult: "team: " + specs.map(function (s) { return s.name; }).join(", "),
    ok: true,
    minutesLeft: minutesLeft(),
  });
  const outcomes = new Array(specs.length);
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.min(SUB_CONCURRENCY, specs.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async function () {
      if (w > 0) await new Promise(function (r) { setTimeout(r, w * 1500); });
      for (;;) {
        const i = nextIndex++;
        if (i >= specs.length) return;
        const started = Date.now();
        const summary = await runSubagent(specs[i], step);
        outcomes[i] = summary;
        worklogAppend("sub-agent " + specs[i].name + " finished (" + Math.round((Date.now() - started) / 1000) + "s): " + String(summary).slice(0, 200));
        log("[team] " + specs[i].name + " finished in " + Math.round((Date.now() - started) / 1000) + "s");
        await reportProgress({
          step: step,
          lastTool: "[" + specs[i].name + "] done",
          thought: "sub-agent finished",
          lastResult: String(summary).slice(0, 300),
          ok: !/^### .*\nFAILED/.test(summary),
          minutesLeft: minutesLeft(),
        });
      }
    })());
  }
  await Promise.all(workers);
  await gitCommitIfNeeded("agent: sub-agent batch checkpoint");
  const blocks = [];
  for (let i = 0; i < specs.length; i++) {
    blocks.push(outcomes[i] || ("### " + specs[i].name + "\n(no summary)"));
  }
  return {
    ok: true,
    output: "SUB-AGENTS REPORT:\n\n" + cap(blocks.join("\n\n")) + "\n\nEach agent summary above is authoritative for its slice. Verify their claims with your own commands before finishing; commit-worthy work is already committed.",
  };
}

// ---------- relay handoff ----------
// The handoff is the contract between two VMs: original task, durable
// progress (the rolling summary), the exact repo state, and what to do
// next. It is committed to the repo AND sent to the control plane, which
// boots the next VM with it as the task brief.
async function gitStateBlock() {
  let changed = "";
  let log15 = "";
  try {
    const status = await git(["status", "--porcelain"]);
    changed = status.stdout.split("\n").filter(Boolean).slice(0, 200).join("\n") || "(clean tree)";
  } catch (e) { changed = "(git status unavailable: " + (e.message || e) + ")"; }
  try {
    const lg = await git(["log", "--oneline", "-15"]);
    log15 = lg.stdout.trim() || "(no commits yet)";
  } catch (e) { log15 = "(git log unavailable)"; }
  return "## Repository state\nChanged/added files:\n" + changed + "\n\nRecent commits:\n" + log15;
}

async function buildHandoff(step) {
  const gitBlock = await gitStateBlock();
  const parts = [
    "# RELAY HANDOFF — job " + JOB_ID + " (VM " + (RELAY_INDEX + 1) + " of " + (MAX_RELAYS + 1) + ")",
    "Written at the " + RELAY_CHECKPOINT_MIN + "-minute checkpoint with " + minutesLeft() + " min left, after " + step + " steps.",
    "",
    "## Original task",
    TASK,
    "",
    "## Progress so far",
    rollingSummary || "(no rolling summary was generated — reconstruct state from the git log below and the repo itself)",
    "",
    "## Worklog (latest lines — every VM in this chain appended)",
    worklogTail(40),
    "",
    gitBlock,
    "",
    "## Current plan (todo state)",
    planRender() || "(no plan was recorded — write one with todo{steps} before editing)",
    "",
    "## Contract status",
    contractRender() || "(no task contract on this job)",
    "",
    "## What the next VM must do",
    "1. Check the repo state above — everything committed so far is real and on disk.",
    "2. Do NOT redo finished work. Verify what exists (build, tests) before touching anything.",
    "3. Continue the ORIGINAL task to completion, then finish with an honest summary.",
    "4. If a deploy was requested and the build is green, make sure request_deploy was called (see .newera/vm/deploy-request.json).",
  ];
  return parts.join("\n");
}

async function relayNow(step) {
  relayDispatched = true;
  const handoff = await buildHandoff(step);
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), handoff + "\n", "utf8");
  } catch (e) {}
  writeResultSummary("RELAYED to a fresh VM (relay " + (RELAY_INDEX + 1) + " of " + MAX_RELAYS + ") after " + step + " steps. All work is committed; the handoff brief is .newera/vm/handoff.md.");
  worklogAppend("RELAY checkpoint at step " + step + " — handoff committed, VM " + (RELAY_INDEX + 2) + " continues.");
  await gitCommitIfNeeded("agent: relay checkpoint (handoff + progress committed)");
  await reportRelay(handoff);
  log("[relay] handoff committed and reported — the control plane boots VM " + (RELAY_INDEX + 2) + " of " + (MAX_RELAYS + 1));
}

// ---------- system prompt ----------
// v4: the system prompt is ONE addressable document (lib/vm/vm-prompt.ts).
// The admin panel can replace it wholesale (AdminConfig.vmPromptOverride,
// delivered as NEWERA_VM_PROMPT_B64); absent an override the factory
// document ships.
const SYSTEM_PROMPT = CUSTOM_PROMPT || "You are NewEra VM Agent — an autonomous software engineer running with full access inside a real Ubuntu Linux VM (a GitHub Actions runner: 4 vCPU, 16 GB RAM, ~14 GB free disk).\n\nYou have a real shell, a real filesystem, git, Node 20 + npm, and Python 3 + pip (python3, python3 -m pip) — all preinstalled on the runner. This is NOT a sandboxed browser: npm install, pip install, running tests and building the project all actually work.\n\n## SKILL PACK (bundled knowledge)\nA curated skill library is bundled in .newera/skills/ — stack playbooks (nextjs-app-router, react-vite-spa, node-express-api, flutter-web, python-project), UI style systems (style-bento, style-brutalism, style-clean, …) and craft rules (craft-anti-ai-slop, craft-color, craft-accessibility, …). Each encodes the scaffold commands, the build loop that converges, the failure→fix table and the static-output contract the deploy stage requires.\nRULE: before touching an unfamiliar stack, call list_skills, then read_skill the relevant stack skill. Before styling ANY user-facing page, read one style skill + craft-anti-ai-slop. This is not optional — it is the difference between a two-step scaffold and a forty-step spiral.\n\n## THE TASK\nExecute the build plan below against the repository in the current working directory. Build, fix and TEST the project for real. Leave the repository in a state where its own build passes.\n\n## TREAT THIS VM AS YOUR OWN MACHINE\nYou have a real Linux box for the whole budget — work it like a senior engineer at their own terminal, not like a guest afraid to touch things.\n- A FRESH CHECKOUT HAS NO node_modules. Before ANY build/lint/test: npm install (or pip install / flutter pub get). \"command not found\" means you skipped the install, never that the toolchain is broken.\n- BUILD FOR REAL before you report done: for any project with package.json scripts.build (or pubspec.yaml), run install → build → read the FIRST error → fix ONE thing → re-run. Repeat until green. The finish gate rejects a buildable project that was never built in this session.\n- Two identical failures in a row? STOP. think{notes} a new hypothesis before the third attempt — doing the same thing louder is not debugging.\n- Verify artifacts with your own eyes: after a build, ls the output dir and confirm index.html (or the platform artifact) actually exists before requesting a deploy.\n- The machine is disposable, your work is not: the harness commits progress automatically — get work into FILES early and often, not just into your head.\n\n## THE CONTRACT\nThe task brief carries a TASK CONTRACT: the requirement matrix the user approved upstream. It is the ONLY definition of done for this job.\n- Every step you take must serve a contract requirement — your todo plan references requirement ids.\n- Anything NOT in the requirement matrix is OUT OF SCOPE: do not build it, do not \"improve\" it, do not polish it. Features you invent yourself are scope violations even when they are good ideas.\n- When every MANDATORY requirement has evidence AND the build is green AND the deploy (if authorized) was requested, the job is DELIVERED. After delivery you may not edit files: call finish. Post-delivery editing is the #1 failure mode this harness exists to prevent.\n\n## WORK LOOP\nEvery reply is EXACTLY ONE JSON object — no prose, no markdown fences:\n{\"thought\":\"brief reasoning\",\"action\":{\"tool\":\"<tool>\",\"args\":{...}}}\nor, when the task is genuinely done:\n{\"thought\":\"...\",\"final\":\"a complete summary: what was built, test/build results, anything unfinished\"}\n\n## START PROTOCOL (your first three steps, in this order)\n1. Orient: read_file .newera/vm/WORKLOG.md (if present) and re-read the task contract. Earlier VMs in this chain recorded what is already done — never redo finished work.\n2. Plan: call todo{steps:[...]} with one step per contract requirement in dependency order. A step without a requirement id is a red flag that you are planning out-of-scope work.\n3. Execute: one step at a time — think, act, read the observation, update the todo. Verify before declaring anything done.\n\n## TOOLS\n- shell{command, timeout_minutes?} — run ANY bash command in the repo root (10 min default, 30 max). Use it for npm/pip install, builds, tests, git inspection, curl. Long-running commands report live progress automatically.\n- list_files{path?} — repository tree (4 levels deep).\n- list_skills{} — the bundled skill catalog (stacks, styles, craft).\n- read_skill{name, start?, end?} — one full skill doc, 500 lines per call.\n- read_file{path, start?, end?} — numbered lines, 400 per call.\n- grep{pattern, path?, glob?} — fast structured search (ripgrep) across the repo; node_modules/.git/.next are skipped automatically. Use it BEFORE read_file when hunting a symbol, an error string or a config key — no shell-quoting pitfalls, no cat-ing whole directories.\n- write_file{path, content} — create/overwrite a file (UTF-8). IMPORTANT: for any file longer than ~120 lines, write it in CHUNKS — write_file the first ~80 lines, then append_file{path, content} for each next chunk. One giant JSON string is the #1 protocol killer: a single unescaped quote or raw newline loses the whole file.\n- append_file{path, content} — append content to an EXISTING file. Pair it with write_file for large files (components, styles, configs).\n- edit_file{path, find, replace, all?} — exact-string patch; unique match required unless all:true.\n- delete_file{path} — remove a file or directory.\n- think{notes} — private draft before acting: what you know, what you are about to do, what could break. It is appended to the durable worklog and costs one step. Use it before any risky command (deletions, dependency changes, big rewrites) and whenever two failed attempts in a row tempt you to try a third blindly — write down the hypothesis first.\n- todo{steps:[{id?, title, status?, requirement?}]} — replace your execution plan. Exactly ONE step may be in_progress at a time; the full plan is echoed back after every tool result. Statuses: pending | in_progress | done | blocked. Keep it current: finish a step the moment its verification passes.\n- update_contract{requirement_id, status, evidence} — mark a contract requirement complete/blocked/deferred with the evidence that proves it. Progress is relayed LIVE to the orchestrator and the user. The finish gate refuses to close the job while a mandatory requirement is incomplete.\n- spawn_agents{tasks:[{name, task, files?}]} — dispatch 1-6 PARALLEL sub-agents (3 run at once). Each is a full agent loop with its own context, its own file ownership and its own work/<name>/ scratch folder. Give each a complete, self-contained slice and disjoint file lists. Blocks until all finish; their summaries come back as your observation. Use it for genuinely parallel work (independent modules, assets, tests).\n- generate_image{prompt, path, size?} — generate a REAL image with the image model and save it at path (extension .png/.jpg/.webp, e.g. public/og-image.png). Sizes: 1024x1024 default, 512x512, 1536x1024, 1024x1536. Use it for og-image, hero/empty-state art, background textures, illustration, placeholder content — real assets beat CSS-only placeholders. Max 12 per job; image API keys stay on the control plane.\n- request_deploy{subdomain, mode?, build_output_path?} — after the build VERIFIABLY passes, request a Cloudflare Pages deploy for subdomain.newera.page.dev. Requires a real static output dir with index.html (out/, dist/, build/web/ …). The URL is delivered after this job ends — Cloudflare keys never enter this VM. If the name turns out taken or wrong, call request_deploy AGAIN with a different subdomain — the new request REPLACES the old one; never re-build just to rename.\n- finish{summary} — task complete. Requires: dependencies installed, build/test commands actually run and passing (or the exact blocker documented), and every MANDATORY contract requirement marked complete via update_contract. Aliases final_output / final_report / final_result / complete / done / stop are accepted, but plain finish is the contract.\n\n## RULES\n1. Start with the START PROTOCOL: worklog → todo → execute. A job that begins with blind commands is a job that ends in a spiral. Note: a greenfield repo contains only .newera/ and .github/ — that is EXPECTED, you are building from scratch.\n2. Fix real errors reported by real tools. Never claim a fix without re-running the failing command.\n3. Do not git commit or push — the harness commits progress for you. Never modify .github/workflows/ or .newera/vm/. Skills in .newera/skills/ are reference docs — read them, do not edit or delete them.\n4. Do not leave long-running servers alive: background them, curl them, then kill them.\n5. Watch the clock — every observation ends with [N minutes left]. A relay checkpoint fires automatically ~15 min before the deadline: get in-flight work into FILES (not just your head) before then, so the next VM can pick it up.\n6. If a blocker cannot be resolved (missing API key, unfixable upstream), finish and state exactly what is blocked.\n7. Stay inside this repository: never touch anything outside it, never run destructive system-wide commands.\n8. Sub-agents are for PARALLEL slices with disjoint files. A job that is mostly sequential (one bug, one build) does not need them — do it yourself.\n9. Deploy only when the task brief authorizes it AND the build is green. Never request a deploy off a red or untested build.\n10. The harness maintains .newera/vm/WORKLOG.md — the durable cross-VM memory of this job chain. Relay and resumed VMs read it on boot; you may read_file it to check what earlier VMs did. Never delete, truncate or rewrite it.\n11. SCOPE LOCK: the contract matrix is the whole job. When all mandatory requirements are green, the correct action is finish — never a self-invented \"improvement phase\". Suggestions for future work belong in your finish summary, not in the code.\n\n## QUALITY BAR\nProduction-quality code. No placeholder stubs unless the plan asks for them. Run the project own test suite when present; otherwise add a minimal smoke test and run it.\nPolish the UI like a designer, not a template: coherent spacing and typography, dark pro-tool aesthetics when the brief says editor/tool, empty/loading/error states everywhere, and REAL visual assets via generate_image (og-image, empty-state art, icons) instead of bare divs. A working app with an amateur look is not done — but polish INSIDE the contract's scope only.";

// ---------- main loop ----------
async function main() {
  log("[boot] NewEra VM agent v4.2 — job " + JOB_ID + ", repo " + REPO + ", budget " + MAX_MINUTES + " min, relay " + RELAY_INDEX + "/" + MAX_RELAYS);
  if (!API || !TOKEN) {
    log("[fatal] missing NEWERA_API_URL or NEWERA_JOB_TOKEN");
    process.exit(2);
  }
  // CONTROL-PLANE REACHABILITY (fail fast, like a human SSH-ing in and
  // checking the network first): if this deployment cannot be reached from
  // GitHub (localhost / LAN URL, dead host, firewall), the OLD behavior was
  // 5 model retries with 280 s timeouts — ~25 silent minutes before the
  // runner gave up. Now: one 15 s probe, an explicit reason in the log
  // (surfaced by watch_vm_agent as a fast FAILED), exit immediately.
  var probeData = null;
  try {
    probeData = await apiGet("/api/vm/agent", 15000);
    log("[boot] control plane reachable at " + API + " — job token accepted");
  } catch (e) {
    const code = (e && e.status) || 0;
    log("[fatal] CONTROL PLANE UNREACHABLE at " + API + " — " + (e.message || e));
    if (code === 401) {
      log("[fatal] The deployment answered but REJECTED this job token (record lost, KV reset, or a re-deployed control plane). Re-dispatch with start_vm_agent.");
    } else if (code === 403) {
      log("[fatal] HTTP 403 = a protection wall in front of the app. /api/vm/agent is exempt from the app-side NEWERA_ACCESS_TOKEN gate, so a 403 here is a HOSTING-layer block: on Vercel check Project Settings > Deployment Protection (disable it) and Firewall / Attack Challenge Mode (add a bypass for /api/* or /api/vm/*).");
    } else if (code === 404) {
      log("[fatal] HTTP 404 = this deployment does not serve /api/vm/agent — an older NewEra build is live at that URL. Redeploy the current source.");
    } else {
      log("[fatal] VM jobs need a PUBLIC NewEra deployment: GitHub Actions runners cannot reach localhost or LAN addresses.");
    }
    process.exit(2);
  }
  // v3.6 — ZOMBIE KILLER. A re-dispatched or cancelled job whose record is
  // already terminal must not burn 20+ minutes of runner time on work the
  // chain no longer wants. The workflow concurrency group usually replaces
  // the previous runner, but the record check here is the belt to those
  // braces: a terminal status means this VM is a zombie — exit before
  // touching the repo, so it can never clobber the live runner either.
  if (
    probeData &&
    probeData.status &&
    String(probeData.status) !== "dispatching" &&
    String(probeData.status) !== "queued" &&
    String(probeData.status) !== "running"
  ) {
    log("[boot] job record is already " + probeData.status + " — this runner is a zombie; exiting without touching the repo.");
    process.exit(0);
  }
  worklogAppend("boot: VM " + (RELAY_INDEX + 1) + "/" + (MAX_RELAYS + 1) + " online (job " + JOB_ID + ", " + MAX_MINUTES + " min budget" + (RELAY_INDEX > 0 ? ", relay continuation" : "") + ")");
  // v4.1 — BOOT SELF-CHECK: verify the environment with real commands so
  // the model starts from facts — and so a false "no tools available"
  // finish can be rejected with proof later. Logged, worklogged, and
  // inlined into the first user message below (envNote).
  const selfCheck = runSelfCheck();
  SELF_CHECK_FACTS = selfCheck.lines.join("; ").slice(0, 1500);
  log("[boot] self-check " + (selfCheck.degraded ? "DEGRADED" : "PASS") + " — " + SELF_CHECK_FACTS);
  worklogAppend("self-check " + (selfCheck.degraded ? "DEGRADED" : "PASS") + ": " + SELF_CHECK_FACTS.slice(0, 300));
  const tree = [];
  listFilesTree(ROOT, 3, "", tree);
  const relayNote = RELAY_INDEX > 0
    ? "You are the CONTINUATION VM (relay " + RELAY_INDEX + " of " + MAX_RELAYS + "). The prior VM wrote .newera/vm/handoff.md — read it FIRST, verify the repo state, then continue the task. Do not redo finished work.\n\n"
    : "";
  const resumeNote = HANDOFF
    ? "You are a RESUMED session (the user asked to continue a finished job). The previous session left this handoff — obey it, verify the repo state with one fast command, then CONTINUE. Do not redo committed work.\n\n--- HANDOFF ---\n" + HANDOFF.slice(0, 8000) + "\n--- END HANDOFF ---\n\n"
    : "";
  // v3.6: the durable chain memory. Relay and resumed VMs READ the worklog
  // first — it is the authoritative "what already happened" record across
  // every VM in this job.
  const worklogNote = fs.existsSync(WORKLOG_PATH)
    ? ".newera/vm/WORKLOG.md is the durable chain memory — every prior VM in this job appended its steps and wind-downs there. read_file{path:\".newera/vm/WORKLOG.md\"} it FIRST to know exactly what has been done and what remains.\n\n"
    : "";
  // v4: the plan + contract ride along from the previous VM (PLAN.json is
  // committed with the repo), and the worklog TAIL is inlined so the first
  // model turn already knows what happened — zero boot tool calls needed.
  planLoad();
  const contractNote = CONTRACT ? contractRender() + "\n\n" : "";
  const planNote = PLAN.length ? "## PLAN FROM THE PREVIOUS VM (update it with todo as you go)\n" + planRender() + "\n\n" : "";
  const wlTail = readWorklogTail(25);
  const worklogBootNote = wlTail ? "## WORKLOG — last 25 entries from earlier VMs in this chain\n" + wlTail + "\n\n" : "";
  // v3.6: auto-matched skills — the task text picks the docs to read first.
  var bootSkillHint = suggestedSkills();
  const skillNote = bootSkillHint.length
    ? "\n## AUTO-MATCHED SKILLS for this task\n" + bootSkillHint.join(", ") + " — read_skill these FIRST (they encode the scaffold commands, the build loop that converges, and the static-output contract).\n"
    : "";
  // v4.1 — the tools digest rides in the FIRST USER MESSAGE (not only the
  // system prompt), so a dropped/mangled system message can never leave the
  // model believing it has no tools — the failure that killed the two
  // imggeditzz jobs in ~60 seconds each.
  const envNote = TOOLS_DIGEST.replace("__SELFCHECK__", selfCheck.lines.join("\n")) + "\n\n";
  const history = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: envNote + relayNote + resumeNote + worklogNote + "## BUILD PLAN / TASK\n" + TASK + "\n\n" + contractNote + planNote + worklogBootNote + skillNote + "\n\n## REPOSITORY (top of tree)\n" + tree.slice(0, 200).join("\n") +
        "\n\nStart now with the START PROTOCOL: 1) orient on the contract + plan + worklog above, 2) todo{steps} your plan if none is current, 3) execute one step at a time (think before risky actions). Remember: ONE JSON object per reply.",
    },
  ];

  let parseFailures = 0;
  let lastCommitStep = 0;
  let wroteSinceCommit = false;
  let step = 0;

  for (step = 1; step <= MAX_STEPS; step++) {
    const left = minutesLeft();

    // Relay checkpoint: stop STARTING new work, wrap up onto a fresh VM.
    // Fires once, only for long jobs (MAX_MINUTES >= RELAY_MIN_JOB_MINUTES)
    // that have not finished, and only while the chain has VMs left.
    if (
      !relayDispatched &&
      RELAY_INDEX < MAX_RELAYS &&
      MAX_MINUTES >= RELAY_MIN_JOB_MINUTES &&
      left <= RELAY_CHECKPOINT_MIN
    ) {
      log("[relay] checkpoint reached (" + left + " min left) — wrapping up for handoff");
      await relayNow(step);
      await reportFinal("RELAYED: the job needs more time than this VM has. A fresh VM continues from the committed handoff — keep watching the same job chain for the final result.", true);
      return;
    }

    if (Date.now() >= DEADLINE) {
      log("[deadline] time budget exhausted");
      // Write a handoff so the work is resumable even when the auto-relay
      // cannot fire (short budget / relay budget spent): resume_vm_agent
      // boots the next VM from exactly this document.
      const deadlineHandoff = await buildHandoff(step);
      try {
        fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
        fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), deadlineHandoff + "\n", "utf8");
      } catch (e) {}
      const summary = "TIME LIMIT REACHED after " + step + " steps. All work so far is committed to the repo and packaged in the artifact; the handoff at .newera/vm/handoff.md carries the continuation plan.";
      worklogAppend("DEADLINE reached at step " + step + " — handoff written for the next VM or an explicit resume.");
      await ensureDeployRequested("deadline wind-down");
      await reportFinal(summary, true, deadlineHandoff);
      writeResultSummary(summary);
      await gitCommitIfNeeded("agent: checkpoint at time limit");
      return;
    }

    let raw = "";
    let modelError = null;
    let timeoutErrors = 0;
    // 5 attempts with growing backoff: a provider-side 429/503 burst must
    // not kill a job that has 20 minutes of budget left. Hard 4xx (auth,
    // schema) still abort immediately — retrying those is pointless. Three
    // consecutive TIMEOUTS also abort early: a hanging control plane or
    // provider is a structural fault, not a burst to wait out.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        raw = await callModel(history, "steps");
        modelError = null;
        break;
      } catch (err) {
        modelError = err;
        log("[model] attempt " + (attempt + 1) + " failed: " + err.message);
        var isTimeout = err && (err.name === "TimeoutError" || /aborted|timed out|timeout/i.test(String(err.message || "")));
        if (isTimeout) timeoutErrors++;
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
        // v3.4: a 500 "no coder model configured" is a PERMANENT control-plane
        // misconfiguration — retrying with backoff only burns time before the
        // same abort. Stop after the first attempt; the abort message names the fix.
        if (err.status === 500 && /no coder model configured/.test(String(err.message || ""))) break;
        if (timeoutErrors >= 3) {
          log("[model] three timeouts — control plane or provider is hanging; aborting early instead of burning the budget.");
          break;
        }
        await new Promise(function (r) { setTimeout(r, 4000 * (attempt + 1)); });
      }
    }
    if (modelError && modelError.status === 409) {
      // v3.6 — GRACEFUL CANCELLATION. A 409 from the proxy means the job
      // record says cancelled/deadline-passed: the USER (or the control
      // plane) stopped this VM. The old path called it an ABORT, left an
      // ugly crash summary and kept hammering a closed token. The graceful
      // path commits in-flight work and reports an honest CANCELLED.
      log("[cancel] control plane reports the job is no longer live — winding down cleanly");
      var cancelSummary = "CANCELLED (control plane answered 409 — the job was stopped or its window closed). In-flight work is committed; this VM reports and stops here.";
      writeResultSummary(cancelSummary);
      worklogAppend("CANCELLED by control plane at step " + step + " — committing in-flight work and stopping.");
      await gitCommitIfNeeded("agent: cancelled mid-run checkpoint");
      await reportFinal(cancelSummary, true);
      return;
    }
    if (modelError) {
      await reportFinal("ABORTED: model proxy unreachable — " + modelError.message + " (control plane: " + API + ")", true);
      writeResultSummary("ABORTED: model proxy unreachable — " + modelError.message + " (control plane: " + API + ")");
      await gitCommitIfNeeded("agent: abort (model proxy unreachable)");
      process.exit(3);
    }

    // v3.5: protocol repair BEFORE counting a strike. The abort that killed
    // job vm-mthaobjs-m7o40p4t at step 45 was four mangled write_file attempts
    // for one big component — the repair model re-emits them and the work
    // lands. Only an unrecoverable reply counts toward the 4-strike abort,
    // and even that abort now leaves a resumable handoff behind.
    let turn = parseTurn(raw);
    if (!turn) turn = await safeRepair(raw);
    if (!turn) {
      parseFailures++;
      history.push({ role: "assistant", content: raw.slice(0, 2000) });
      history.push({
        role: "user",
        content: "PROTOCOL: your last reply was not a valid JSON envelope (the repair model could not recover it either). Reply with EXACTLY one JSON object: {\"thought\":\"...\",\"action\":{\"tool\":\"...\",\"args\":{...}}} — no prose, no fences. Tools you have (real, verified at boot): shell, list_files, list_skills, read_skill, read_file, grep, write_file, append_file, edit_file, delete_file, think, todo, update_contract, spawn_agents, generate_image, request_deploy (re-callable with a new subdomain to replace a request), finish." +
          (parseFailures >= 2 ? " If you are writing a LARGE file, stop retrying one giant string: write_file the first ~80 lines, then append_file each next chunk." : ""),
      });
      if (parseFailures >= 4) {
        const protocolHandoff = await buildHandoff(step);
        try {
          fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
          fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), protocolHandoff + "\n", "utf8");
        } catch (e) {}
        await ensureDeployRequested("abort wind-down");
        worklogAppend("ABORT (protocol violations x4) at step " + step + " — handoff written for resume.");
        await reportFinal("ABORTED: model kept replying outside the JSON protocol after " + step + " steps. The work that landed is committed and a handoff was written — resume_vm_agent continues from it.", true, protocolHandoff);
        writeResultSummary("ABORTED: model kept replying outside the JSON protocol after " + step + " steps (handoff committed for resume).");
        await gitCommitIfNeeded("agent: abort (protocol)");
        return;
      }
      continue;
    }
    parseFailures = 0;

    if (turn.final) {
      // v4.1: the premature-final guard runs FIRST — a first-reply final
      // that claims tools/repository access is missing is a hallucination,
      // not an honest blocker; correct it with the boot self-check proof.
      const premature = prematureFinalRejection(turn.final, "final reply");
      if (premature) {
        history.push({ role: "assistant", content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 300), final: String(turn.final).slice(0, 400) }) });
        history.push({ role: "user", content: premature });
        continue;
      }
      // v4: the same finish gates apply to the {"final":...} path — a model
      // cannot route around verification or contract evidence by using the
      // other completion shape.
      const finalGate = finishGateRejection("final reply");
      if (finalGate) {
        history.push({ role: "assistant", content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 300), final: String(turn.final).slice(0, 400) }) });
        history.push({ role: "user", content: finalGate });
        continue;
      }
      log("[final] " + String(turn.final).slice(0, 400));
      worklogAppend("FINAL report: " + String(turn.final).slice(0, 300));
      await ensureDeployRequested("final reply");
      await reportFinal(turn.final, false);
      writeResultSummary(turn.final);
      await gitCommitIfNeeded("agent: final state");
      return;
    }

    const action = turn.action || {};
    var toolName = String(action.tool || "").trim().toLowerCase();
    var args = action.args || {};
    // v3.6 — finish aliases. A model prompted elsewhere to call
    // final_output died on "unknown tool" at the very last step. Any
    // plausible completion verb now lands in the finish path, with the
    // summary picked from whichever arg the model actually supplied.
    if (isFinishTool(toolName) && toolName !== "finish") {
      var aliasSummary =
        args.summary || args.final_output || args.final_report || args.result ||
        args.report || args.output || args.message || "";
      args = { summary: String(aliasSummary || turn.final || "done") };
      toolName = "finish";
      log("[alias] " + String(action.tool || "") + " mapped to finish");
    }
    // Pre-report the step BEFORE executing it: a 10-minute npm install then
    // shows up as "[step 7] shell — (executing…)" immediately, instead of
    // silence that looks exactly like a dead job. The shell tool also
    // heartbeats its last output line every 45 s while it runs.
    if (toolName !== "finish") {
      await reportProgress({
        step: step,
        lastTool: toolName,
        thought: String(turn.thought || "").slice(0, 300),
        lastResult: "(executing…)",
        ok: true,
        minutesLeft: left,
      });
    }
    let result;
    try {
      if (toolName === "shell") result = await toolShell(args, step);
      else if (toolName === "list_files") result = toolListFiles(args);
      else if (toolName === "list_skills") result = toolListSkills();
      else if (toolName === "read_skill") result = toolReadSkill(args);
      else if (toolName === "read_file") result = toolReadFile(args);
      else if (toolName === "grep") result = toolGrep(args);
      else if (toolName === "think") result = toolThink(args);
      else if (toolName === "todo") result = toolTodo(args);
      else if (toolName === "update_contract") result = await toolUpdateContract(args);
      else if (toolName === "write_file" || toolName === "append_file" || toolName === "edit_file" || toolName === "delete_file") {
        // v4: SCOPE LOCK — once every mandatory contract requirement is
        // complete AND verification is current, file edits are refused:
        // the job is delivered, and "one more polish pass" is exactly the
        // freelancing this gate exists to kill.
        if (writesFrozen()) {
          result = { ok: false, output: scopeLockMessage() };
        } else {
          if (toolName === "write_file") result = toolWriteFile(args);
          else if (toolName === "append_file") result = toolAppendFile(args);
          else if (toolName === "edit_file") result = toolEditFile(args);
          else result = toolDeleteFile(args);
          if (result && result.ok) { wroteSinceCommit = true; wroteSinceVerify = true; }
        }
      }
      else if (toolName === "spawn_agents") {
        if (writesFrozen()) {
          result = { ok: false, output: scopeLockMessage() };
        } else {
          result = await toolSpawnAgents(args, step);
          if (result && result.ok) { wroteSinceCommit = true; wroteSinceVerify = true; }
        }
      }
      else if (toolName === "generate_image") {
        if (writesFrozen()) {
          result = { ok: false, output: scopeLockMessage() };
        } else {
          result = await toolGenerateImage(args);
          if (result && result.ok) { wroteSinceCommit = true; wroteSinceVerify = true; }
        }
      }
      else if (toolName === "request_deploy") result = await toolRequestDeploy(args);
      else if (toolName === "finish") {
        const summary = String(args.summary || "done");
        // v4.1: premature-final guard first — a finish with zero real work
        // behind it (or one claiming the tools do not exist) is rejected
        // with the boot self-check evidence before the gates even look.
        const premature = prematureFinalRejection(summary, "finish tool");
        if (premature) {
          result = { ok: false, output: premature };
        } else {
        // v4 finish gates: (1) no unverified writes outstanding, (2) every
        // mandatory contract requirement has evidence. Two push-backs max —
        // the third finish attempt is honored so a gate can never strand a
        // job that genuinely cannot satisfy it.
        const gate = finishGateRejection("finish tool");
        if (gate) {
          result = { ok: false, output: gate };
        } else {
          worklogAppend("FINISH (tool" + (String(action.tool || "") !== "finish" ? ", alias " + String(action.tool || "") : "") + "): " + summary.slice(0, 300));
          await ensureDeployRequested("finish tool");
          await reportFinal(summary, false);
          writeResultSummary(summary);
          await gitCommitIfNeeded("agent: final state");
          return;
        }
        }
      }
      else result = { ok: false, output: "unknown tool: " + toolName + " — available: shell, list_files, list_skills, read_skill, read_file, grep, think, todo, update_contract, write_file, append_file, edit_file, delete_file, generate_image, spawn_agents, request_deploy, finish{summary}. If you meant to END the task, call finish{summary} — final_output, final_report, complete, done and stop are accepted as aliases." };
    } catch (err) {
      result = { ok: false, output: "tool error: " + (err.message || String(err)) };
    }

    // v4.1: every dispatched tool call (finish excepted) is evidence the
    // model CAN act — the premature-final guard counts these.
    if (toolName !== "finish") toolsExecuted++;

    log("[step " + step + "] " + toolName + " -> " + (result.ok ? "ok" : "FAILED"));
    worklogAppend("step " + step + " " + toolName + " " + (result.ok ? "ok" : "FAILED") + " [tools so far: " + (toolsExecuted + 1) + "]: " + String(result.output || "").slice(0, 200));
    await reportProgress({
      step: step,
      lastTool: toolName,
      thought: String(turn.thought || "").slice(0, 300),
      lastResult: String(result.output || "").slice(0, 500),
      ok: result.ok,
      minutesLeft: left,
    });

    history.push({
      role: "assistant",
      content: JSON.stringify({ thought: String(turn.thought || "").slice(0, 600), action: { tool: toolName, args: compactArgs(args) } }),
    });
    history.push({
      role: "user",
      content: "[" + toolName + (result.ok ? " ok" : " FAILED") + "]\n" + String(result.output || "") + "\n\n[" + left + " minutes left | step " + step + "/" + MAX_STEPS + "]" + (PLAN.length ? "\n\n" + planRender() : ""),
    });

    // Rolling compaction — long jobs keep their memory instead of degrading.
    await compactHistory(history);

    if ((wroteSinceCommit && step - lastCommitStep >= 8) || step - lastCommitStep >= 25) {
      await gitCommitIfNeeded("agent progress: step " + step);
      lastCommitStep = step;
      wroteSinceCommit = false;
    }
  }

  const stepSummary = "STEP LIMIT reached (" + MAX_STEPS + " steps). Work so far is committed and packaged; the handoff at .newera/vm/handoff.md carries the continuation plan.";
  worklogAppend("STEP LIMIT " + MAX_STEPS + " reached — handoff written for resume.");
  const stepHandoff = await buildHandoff(MAX_STEPS);
  await ensureDeployRequested("step-limit wind-down");
  await reportFinal(stepSummary, true, stepHandoff);
  try {
    fs.mkdirSync(path.join(ROOT, ".newera", "vm"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, ".newera", "vm", "handoff.md"), stepHandoff + "\n", "utf8");
  } catch (e) {}
  writeResultSummary(stepSummary);
  await gitCommitIfNeeded("agent: step limit checkpoint");
}

function compactArgs(args) {
  const out = {};
  for (const k of Object.keys(args || {})) {
    const v = args[k];
    if (typeof v === "string" && v.length > 300) out[k] = v.slice(0, 200) + "…(" + v.length + " chars)";
    else out[k] = v;
  }
  return out;
}

main().then(function () {
  log("[boot] agent loop finished");
  process.exit(0);
}).catch(function (err) {
  log("[fatal] " + (err.stack || err.message || String(err)));
  worklogAppend("CRASHED: " + String(err.message || err).slice(0, 300));
  reportFinal("CRASHED: " + (err.message || String(err)), true);
  writeResultSummary("CRASHED: " + (err.stack || err.message || String(err)));
  gitCommitIfNeeded("agent: crash checkpoint").finally(function () { process.exit(1); });
});