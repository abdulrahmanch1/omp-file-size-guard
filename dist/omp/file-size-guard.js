// adapters/omp/file-size-guard.ts
import path2 from "node:path";

// core/guard.ts
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
    fd = openSync(abs, "r");
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
      const n = readSync(fd, buf, 0, buf.length, null);
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
    closeSync(fd);
  }
}
function loadExemptions(cwd) {
  try {
    const raw = JSON.parse(readFileSync(path.join(cwd, EXEMPTIONS_REL), "utf8"));
    return {
      files: raw && typeof raw.files === "object" && raw.files !== null ? raw.files : {},
      extensions: raw && typeof raw.extensions === "object" && raw.extensions !== null ? raw.extensions : {}
    };
  } catch {
    return { files: {}, extensions: {} };
  }
}
function relKey(absPath, cwd) {
  const rel = path.relative(cwd, absPath);
  if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
  return absPath;
}
function shouldSkip(absPath, cwd) {
  if (absPath.includes("://")) return true;
  const rel = relKey(absPath, cwd);
  return rel === ".git" || rel.startsWith(".git/") || rel.startsWith("node_modules/") || rel.includes("/node_modules/");
}
function isExempt(absPath, cwd, ex) {
  return ex.files[relKey(absPath, cwd)] !== void 0 || ex.extensions[path.extname(absPath)] !== void 0;
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
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
    const st = statSync(abs);
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
  for (const p of changedFiles(root)) baseline.set(p, statKey(path.join(root, p)));
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
    const abs = path.join(root, p);
    const before = baseline.get(p);
    if (before !== void 0 && before === statKey(abs)) continue;
    if (!existsSync(abs)) continue;
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
    const entry = classify(path.join(root, p), cwd, ex);
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
  return existsSync(path.join(cwd, ONBOARDED_REL));
}
function writeMarker(cwd, decision) {
  try {
    mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    writeFileSync(path.join(cwd, ONBOARDED_REL), `${JSON.stringify({ version: 1, decision, at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
  } catch {
  }
}
function bulkExempt(cwd, flagged) {
  const exPath = path.join(cwd, EXEMPTIONS_REL);
  let raw = {};
  try {
    const parsed = JSON.parse(readFileSync(exPath, "utf8"));
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
    mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    writeFileSync(exPath, `${JSON.stringify(raw, null, 2)}
`);
  } catch {
  }
}
function estimateEditResult(abs, oldString, newString, replaceAll) {
  try {
    const cur = readFileSync(abs, "utf8");
    const next = replaceAll && oldString !== "" ? cur.split(oldString).join(newString) : cur.replace(oldString, newString);
    return next === cur ? null : next;
  } catch {
    return null;
  }
}

// adapters/omp/file-size-guard.ts
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
  let continuationExpected = false;
  pi.on("session_start", async (_event, ctx) => {
    const root = repoRoot(ctx.cwd);
    if (root === null) return;
    if (markerExists(ctx.cwd)) return;
    if (!ctx.hasUI) return;
    ctx.setTimeout(() => {
      void (async () => {
        const { flagged, counts } = scanAll(root, ctx.cwd);
        if (flagged.length === 0) {
          writeMarker(ctx.cwd, "clean");
          return;
        }
        let fix;
        try {
          fix = await ctx.ui.confirm("file-size-guard: initial project scan", onboardingDialog(flagged, counts));
        } catch {
          ctx.ui.notify("file-size-guard: initial scan postponed to next session", "info");
          return;
        }
        if (!fix) {
          bulkExempt(ctx.cwd, flagged);
          writeMarker(ctx.cwd, "exempted");
          ctx.ui.notify(`file-size-guard: ${flagged.length} pre-existing file(s) exempted`, "info");
          return;
        }
        writeMarker(ctx.cwd, "fix");
        void pi.sendUserMessage(onboardingPrompt(flagged));
      })();
    }, 300);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (repoRoot(ctx.cwd) === null) return;
    const p = String(event.input.path ?? "");
    const abs = path2.resolve(ctx.cwd, p);
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
    if (continuationExpected) {
      continuationExpected = false;
      return;
    }
    const root = probeRoot(ctx.cwd);
    repoRoots.set(ctx.cwd, root);
    baselineRoot = root;
    baseline = root === null ? /* @__PURE__ */ new Map() : snapshotBaseline(root);
  });
  pi.on("session_stop", async (_event, ctx) => {
    const root = repoRoot(ctx.cwd);
    if (root === null || root !== baselineRoot) return;
    const flagged = scanChanged(root, ctx.cwd, baseline);
    if (flagged.length === 0) return;
    if (ctx.hasUI) ctx.ui.notify(`file-size-guard: ${flagged.length} file(s) over the line limits`, "warning");
    continuationExpected = true;
    return { continue: true, additionalContext: reportText(flagged) };
  });
}
export {
  fileSizeGuard as default
};
