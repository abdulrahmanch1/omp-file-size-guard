// adapters/opencode/file-size-guard.ts
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
function estimateEditResult(abs, oldString, newString, replaceAll) {
  try {
    const cur = readFileSync(abs, "utf8");
    const next = replaceAll && oldString !== "" ? cur.split(oldString).join(newString) : cur.replace(oldString, newString);
    return next === cur ? null : next;
  } catch {
    return null;
  }
}

// adapters/opencode/file-size-guard.ts
var FileSizeGuard = async (input) => {
  const cwd = input.directory;
  const probeRoot = () => {
    const out = git(cwd, ["rev-parse", "--show-toplevel"]);
    return out === null ? null : out.trim();
  };
  let root = probeRoot();
  let baseline = root === null ? /* @__PURE__ */ new Map() : snapshotBaseline(root);
  const inject = async (sessionID, text) => {
    await input.client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] }
    });
  };
  return {
    // Pre-execution hard limit (>350): throwing blocks the tool call and the
    // message reaches the agent as the tool error.
    "tool.execute.before": async ({ tool }, output) => {
      if (tool !== "write" && tool !== "edit") return;
      if (root === null) return;
      const args = output.args;
      const p = String(args.filePath ?? "");
      const abs = path2.resolve(cwd, p);
      if (!p || shouldSkip(abs, cwd)) return;
      const newText = tool === "write" ? String(args.content ?? "") : estimateEditResult(abs, String(args.oldString ?? ""), String(args.newString ?? ""), args.replaceAll === true);
      if (newText === null) return;
      const lines = countLines(newText);
      if (lines <= ERROR_LINES) return;
      if (isExempt(abs, cwd, loadExemptions(cwd))) return;
      throw new Error(blockReason(relKey(abs, cwd), lines));
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      if (root === null) {
        root = probeRoot();
        baseline = root === null ? /* @__PURE__ */ new Map() : snapshotBaseline(root);
        return;
      }
      const sessionID = event.properties.sessionID;
      if (!markerExists(cwd)) {
        const { flagged: flagged2 } = scanAll(root, cwd);
        if (flagged2.length === 0) {
          writeMarker(cwd, "clean");
        } else {
          writeMarker(cwd, "prompted");
          const bulk = flagged2.map((f) => `- ${f.rel}`).join("\n");
          await inject(
            sessionID,
            `[file-size-guard onboarding] This project has ${flagged2.length} pre-existing file(s) over the line limits:
${bulk}
Ask the user to choose:
1. Fix them all now (split / shrink / extract constants; add a convincing per-file exemption to .omp/file-size-exemptions.json only where a single piece is genuinely required).
2. Leave them: then add EVERY listed file to .omp/file-size-exemptions.json with the reason "Pre-existing file at file-size-guard adoption; user declined onboarding fixes." so they are never flagged again.
Do not proceed with other work until the user has chosen.`
          );
        }
        baseline = snapshotBaseline(root);
        return;
      }
      const flagged = scanChanged(root, cwd, baseline);
      baseline = snapshotBaseline(root);
      if (flagged.length === 0) return;
      await inject(sessionID, reportText(flagged));
    }
  };
};
var file_size_guard_default = FileSizeGuard;
export {
  FileSizeGuard,
  file_size_guard_default as default
};
