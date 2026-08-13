var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// adapters/pi/file-size-guard.ts
var file_size_guard_exports = {};
__export(file_size_guard_exports, {
  default: () => fileSizeGuard
});
module.exports = __toCommonJS(file_size_guard_exports);
var import_node_path2 = __toESM(require("node:path"), 1);

// core/guard.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var WARN_LINES = 150;
var STRICT_LINES = 250;
var ERROR_LINES = 350;
var EXEMPTIONS_REL = ".omp/file-size-exemptions.json";
var ONBOARDED_REL = ".omp/file-size-guard-onboarded.json";
function countLines(text) {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
  return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
}
function countFileLines(abs) {
  let fd;
  try {
    fd = (0, import_node_fs.openSync)(abs, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(65536);
    let newlines = 0;
    let total = 0;
    let lastByte = -1;
    let firstChunk = true;
    for (; ; ) {
      const n = (0, import_node_fs.readSync)(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      if (firstChunk) {
        if (buf.subarray(0, Math.min(n, 4096)).includes(0)) return null;
        firstChunk = false;
      }
      for (let i = 0; i < n; i++) if (buf[i] === 10) newlines++;
      total += n;
      lastByte = buf[n - 1];
    }
    if (total === 0) return 0;
    return lastByte === 10 ? newlines : newlines + 1;
  } catch {
    return null;
  } finally {
    (0, import_node_fs.closeSync)(fd);
  }
}
function loadExemptions(cwd) {
  try {
    const raw = JSON.parse((0, import_node_fs.readFileSync)(import_node_path.default.join(cwd, EXEMPTIONS_REL), "utf8"));
    return {
      files: raw && typeof raw.files === "object" && raw.files !== null ? raw.files : {},
      extensions: raw && typeof raw.extensions === "object" && raw.extensions !== null ? raw.extensions : {}
    };
  } catch {
    return { files: {}, extensions: {} };
  }
}
function relKey(absPath, cwd) {
  const rel = import_node_path.default.relative(cwd, absPath);
  if (!rel.startsWith("..")) return rel.split(import_node_path.default.sep).join("/");
  return absPath;
}
function shouldSkip(absPath, cwd) {
  if (absPath.includes("://")) return true;
  const rel = relKey(absPath, cwd);
  return rel === ".git" || rel.startsWith(".git/") || rel.startsWith("node_modules/") || rel.includes("/node_modules/");
}
function isExempt(absPath, cwd, ex) {
  return ex.files[relKey(absPath, cwd)] !== void 0 || ex.extensions[import_node_path.default.extname(absPath)] !== void 0;
}
function tierFor(lines) {
  if (lines > ERROR_LINES) return "error";
  if (lines > STRICT_LINES) return "strict";
  if (lines > WARN_LINES) return "warn";
  return null;
}
var REMEDIATION = `Review the file and decide:
1. If there is no strong reason for this size: split it into smaller modules, extract repeated literals into constants, or remove duplication \u2014 then continue.
2. If it genuinely must stay one piece (e.g. this type of file must remain a single unit, or the logic must stay together for readability): add an exemption to .omp/file-size-exemptions.json at the project root with EITHER a per-file entry {"files": {"<cwd-relative-path>": "<convincing reason>"}} OR an extension entry {"extensions": {"<.ext>": "<convincing reason>"}}. Exempted files are never flagged again.`;
function tierMessage(tier, rel, lines) {
  if (tier === "error") {
    return `[file-size-guard] ERROR: ${rel} now has ${lines} lines (hard limit ${ERROR_LINES}). You MUST reduce it below ${ERROR_LINES} lines before doing anything else: split it, extract constants, or \u2014 only if a single piece is genuinely required \u2014 add a convincing exemption entry.
${REMEDIATION}`;
  }
  if (tier === "strict") {
    return `[file-size-guard] STRICT WARNING: ${rel} now has ${lines} lines (strict limit ${STRICT_LINES}). This is excessive for a single file.
${REMEDIATION}`;
  }
  return `[file-size-guard] WARNING: ${rel} now has ${lines} lines (soft limit ${WARN_LINES}).
${REMEDIATION}`;
}
function blockReason(rel, lines) {
  return `[file-size-guard] BLOCKED: this change would make ${rel} ${lines} lines (hard limit ${ERROR_LINES}). Write a smaller file: split the code into multiple modules, extract repeated literals into constants, or \u2014 only if a single piece is genuinely required \u2014 first add a convincing exemption entry to .omp/file-size-exemptions.json ({"files": {"${rel}": "<reason>"}}), then retry the write.`;
}
function git(root, args) {
  const r = (0, import_node_child_process.spawnSync)("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function changedFiles(root) {
  const hasHead = git(root, ["rev-parse", "--verify", "HEAD"]) !== null;
  const diffArgs = hasHead ? ["diff", "--name-only", "-z", "HEAD"] : ["diff", "--name-only", "-z", "--cached"];
  const out = /* @__PURE__ */ new Set();
  for (const stdout of [git(root, diffArgs), git(root, ["ls-files", "--others", "--exclude-standard", "-z"])]) {
    if (stdout === null) continue;
    for (const p of stdout.split("\0")) if (p) out.add(p);
  }
  return out;
}
function statKey(abs) {
  try {
    const st = (0, import_node_fs.statSync)(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}
function allFiles(root) {
  const stdout = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (stdout === null) return [];
  return stdout.split("\0").filter((p) => p.length > 0);
}
function snapshotBaseline(root) {
  const baseline = /* @__PURE__ */ new Map();
  for (const p of changedFiles(root)) baseline.set(p, statKey(import_node_path.default.join(root, p)));
  return baseline;
}
function classify(abs, cwd, ex) {
  if (shouldSkip(abs, cwd) || isExempt(abs, cwd, ex)) return null;
  const lines = countFileLines(abs);
  if (lines === null) return null;
  const tier = tierFor(lines);
  if (!tier) return null;
  return { rel: relKey(abs, cwd), lines, tier };
}
function scanChanged(root, cwd, baseline) {
  const ex = loadExemptions(cwd);
  const flagged = [];
  for (const p of changedFiles(root)) {
    const abs = import_node_path.default.join(root, p);
    const before = baseline.get(p);
    if (before !== void 0 && before === statKey(abs)) continue;
    if (!(0, import_node_fs.existsSync)(abs)) continue;
    const entry = classify(abs, cwd, ex);
    if (entry) flagged.push(entry);
  }
  return flagged;
}
function scanAll(root, cwd) {
  const ex = loadExemptions(cwd);
  const flagged = [];
  const counts = { warn: 0, strict: 0, error: 0 };
  for (const p of allFiles(root)) {
    const entry = classify(import_node_path.default.join(root, p), cwd, ex);
    if (!entry) continue;
    counts[entry.tier]++;
    flagged.push(entry);
  }
  return { flagged, counts };
}
function reportText(flagged) {
  return [
    `[file-size-guard] End-of-turn git scan: ${flagged.length} file(s) changed this turn exceed the line limits. Address each one now \u2014 split it, shrink it, extract constants, or add a convincing exemption:`,
    ...flagged.map((f) => tierMessage(f.tier, f.rel, f.lines))
  ].join("\n\n");
}
function limitFor(tier) {
  return tier === "error" ? ERROR_LINES : tier === "strict" ? STRICT_LINES : WARN_LINES;
}
function formatFlagged(entry) {
  return `${entry.rel} \u2014 ${entry.lines} lines (limit ${limitFor(entry.tier)})`;
}
function onboardingDialog(flagged, counts) {
  return `${flagged.length} file(s) exceed the line limits (${counts.error} over ${ERROR_LINES}, ${counts.strict} over ${STRICT_LINES}, ${counts.warn} over ${WARN_LINES}).

Yes \u2014 the agent fixes each file now (split / shrink / extract constants), exempting only what genuinely must stay one piece.
No \u2014 every flagged file is added to .omp/file-size-exemptions.json and never flagged again.`;
}
function onboardingPrompt(flagged) {
  const list = flagged.slice(0, 1e3);
  return `[file-size-guard onboarding] This project has ${flagged.length} file(s) over the line limits:
${list.map((f) => `- ${formatFlagged(f)}`).join("\n")}${flagged.length > list.length ? `
\u2026and ${flagged.length - list.length} more.` : ""}
Fix every one now: split into smaller modules, shrink them, or extract repeated literals into constants. Only where a single piece is genuinely required, add a convincing per-file exemption to .omp/file-size-exemptions.json. The guard re-scans everything you change when your run ends and will send you back to any file still over the limit.`;
}
function markerExists(cwd) {
  return (0, import_node_fs.existsSync)(import_node_path.default.join(cwd, ONBOARDED_REL));
}
function writeMarker(cwd, decision) {
  try {
    (0, import_node_fs.mkdirSync)(import_node_path.default.join(cwd, ".omp"), { recursive: true });
    (0, import_node_fs.writeFileSync)(import_node_path.default.join(cwd, ONBOARDED_REL), `${JSON.stringify({ version: 1, decision, at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
  } catch {
  }
}
function bulkExempt(cwd, flagged) {
  const exPath = import_node_path.default.join(cwd, EXEMPTIONS_REL);
  let raw = {};
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(exPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed;
  } catch {
    raw = {};
  }
  const files = raw.files && typeof raw.files === "object" && !Array.isArray(raw.files) ? { ...raw.files } : {};
  for (const entry of flagged) {
    files[entry.rel] = "Pre-existing file at file-size-guard adoption; user declined onboarding fixes.";
  }
  raw.files = files;
  try {
    (0, import_node_fs.mkdirSync)(import_node_path.default.join(cwd, ".omp"), { recursive: true });
    (0, import_node_fs.writeFileSync)(exPath, `${JSON.stringify(raw, null, 2)}
`);
  } catch {
  }
}
function estimateEditResult(abs, oldString, newString, replaceAll) {
  try {
    const cur = (0, import_node_fs.readFileSync)(abs, "utf8");
    const next = replaceAll && oldString !== "" ? cur.split(oldString).join(newString) : cur.replace(oldString, newString);
    return next === cur ? null : next;
  } catch {
    return null;
  }
}

// adapters/pi/file-size-guard.ts
function fileSizeGuard(pi) {
  const probeRoot = (cwd) => {
    const out = git(cwd, ["rev-parse", "--show-toplevel"]);
    return out === null ? null : out.trim();
  };
  const repoRoots = /* @__PURE__ */ new Map();
  const repoRoot = (cwd) => {
    const cached = repoRoots.get(cwd);
    if (cached !== void 0) return cached;
    const root = probeRoot(cwd);
    repoRoots.set(cwd, root);
    return root;
  };
  let baseline = /* @__PURE__ */ new Map();
  let baselineRoot = null;
  let pendingReport = null;
  pi.on("session_start", async (_event, ctx) => {
    const root = repoRoot(ctx.cwd);
    if (root === null) return;
    if (markerExists(ctx.cwd)) return;
    if (!ctx.hasUI) return;
    setTimeout(() => {
      void (async () => {
        try {
          const { flagged, counts } = scanAll(root, ctx.cwd);
          if (flagged.length === 0) {
            writeMarker(ctx.cwd, "clean");
            return;
          }
          const fix = await ctx.ui.confirm(
            "file-size-guard: initial project scan",
            onboardingDialog(flagged, counts)
          );
          if (!fix) {
            bulkExempt(ctx.cwd, flagged);
            writeMarker(ctx.cwd, "exempted");
            ctx.ui.notify(`file-size-guard: ${flagged.length} pre-existing file(s) exempted`, "info");
            return;
          }
          await pi.sendUserMessage(onboardingPrompt(flagged));
          writeMarker(ctx.cwd, "fix");
        } catch {
          try {
            ctx.ui.notify("file-size-guard: initial scan postponed to next session", "info");
          } catch {
          }
        }
      })();
    }, 300);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (repoRoot(ctx.cwd) === null) return;
    const p = String(event.input.path ?? "");
    const abs = import_node_path2.default.resolve(ctx.cwd, p);
    if (!p || shouldSkip(abs, ctx.cwd)) return;
    const newText = event.toolName === "write" ? String(event.input.content ?? "") : estimateEditResult(
      abs,
      String(event.input.old_string ?? ""),
      String(event.input.new_string ?? ""),
      event.input.replace_all === true
    );
    if (newText === null) return;
    const lines = countLines(newText);
    if (lines <= ERROR_LINES) return;
    if (isExempt(abs, ctx.cwd, loadExemptions(ctx.cwd))) return;
    return { block: true, reason: blockReason(relKey(abs, ctx.cwd), lines) };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const root = probeRoot(ctx.cwd);
    repoRoots.set(ctx.cwd, root);
    baselineRoot = root;
    baseline = root === null ? /* @__PURE__ */ new Map() : snapshotBaseline(root);
    if (pendingReport === null) return;
    const text = pendingReport;
    pendingReport = null;
    return {
      message: {
        customType: "file-size-guard",
        content: text,
        display: true
      }
    };
  });
  pi.on("agent_end", async (_event, ctx) => {
    const root = repoRoot(ctx.cwd);
    if (root === null || root !== baselineRoot) return;
    const flagged = scanChanged(root, ctx.cwd, baseline);
    if (flagged.length === 0) return;
    pendingReport = reportText(flagged);
    if (ctx.hasUI) ctx.ui.notify(`file-size-guard: ${flagged.length} file(s) over the line limits`, "warning");
  });
}
