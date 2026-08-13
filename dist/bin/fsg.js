#!/usr/bin/env node

// bin/fsg.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";

// core/guard.ts
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
var WARN_LINES = 150;
var STRICT_LINES = 250;
var ERROR_LINES = 350;
var EXEMPTIONS_REL = ".omp/file-size-exemptions.json";
var CONFIG_REL = ".omp/file-size-guard.json";
var DEFAULT_LIMITS = { warn: WARN_LINES, strict: STRICT_LINES, error: ERROR_LINES };
function limitsFrom(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const merged = { ...DEFAULT_LIMITS };
  for (const key of ["warn", "strict", "error"]) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) merged[key] = Math.floor(v);
  }
  return merged.warn < merged.strict && merged.strict < merged.error ? merged : null;
}
function loadLimits(cwd2) {
  try {
    const parsed = limitsFrom(JSON.parse(readFileSync(path.join(cwd2, CONFIG_REL), "utf8")));
    if (parsed !== null) return parsed;
  } catch {
  }
  return { ...DEFAULT_LIMITS };
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
function loadExemptions(cwd2) {
  try {
    const raw = JSON.parse(readFileSync(path.join(cwd2, EXEMPTIONS_REL), "utf8"));
    return {
      files: raw && typeof raw.files === "object" && raw.files !== null ? raw.files : {},
      extensions: raw && typeof raw.extensions === "object" && raw.extensions !== null ? raw.extensions : {}
    };
  } catch {
    return { files: {}, extensions: {} };
  }
}
function relKey(absPath, cwd2) {
  const rel = path.relative(cwd2, absPath);
  if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
  return absPath;
}
function shouldSkip(absPath, cwd2) {
  if (absPath.includes("://")) return true;
  const rel = relKey(absPath, cwd2);
  return rel === ".git" || rel.startsWith(".git/") || rel.startsWith("node_modules/") || rel.includes("/node_modules/");
}
function isExempt(absPath, cwd2, ex) {
  return ex.files[relKey(absPath, cwd2)] !== void 0 || ex.extensions[path.extname(absPath)] !== void 0;
}
function tierFor(lines, limits2 = DEFAULT_LIMITS) {
  if (lines > limits2.error) return "error";
  if (lines > limits2.strict) return "strict";
  if (lines > limits2.warn) return "warn";
  return null;
}
function git(root2, args2) {
  const r = spawnSync("git", ["-C", root2, ...args2], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function allFiles(root2) {
  const stdout = git(root2, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (stdout === null) return [];
  return stdout.split("\0").filter((p) => p.length > 0);
}
function classify(abs, cwd2, ex, limits2) {
  if (shouldSkip(abs, cwd2) || isExempt(abs, cwd2, ex)) return null;
  const lines = countFileLines(abs);
  if (lines === null) return null;
  const tier = tierFor(lines, limits2);
  if (!tier) return null;
  return { rel: relKey(abs, cwd2), lines, tier };
}
function scanAll(root2, cwd2) {
  const ex = loadExemptions(cwd2);
  const limits2 = loadLimits(cwd2);
  const flagged2 = [];
  const counts2 = { warn: 0, strict: 0, error: 0 };
  for (const p of allFiles(root2)) {
    const entry = classify(path.join(root2, p), cwd2, ex, limits2);
    if (!entry) continue;
    counts2[entry.tier]++;
    flagged2.push(entry);
  }
  return { flagged: flagged2, counts: counts2, limits: limits2 };
}
function limitFor(tier, limits2) {
  return tier === "error" ? limits2.error : tier === "strict" ? limits2.strict : limits2.warn;
}
function formatFlagged(entry, limits2 = DEFAULT_LIMITS) {
  return `${entry.rel} \u2014 ${entry.lines} lines (limit ${limitFor(entry.tier, limits2)})`;
}

// bin/fsg.ts
var TIER_RANK = { warn: 1, strict: 2, error: 3 };
function usage() {
  console.log(`fsg \u2014 file-size-guard CLI

Usage:
  fsg [check] [dir]     Scan all authored files in the git repo containing dir (default: cwd)
  fsg --help            Show this help

Options:
  --fail-on=<warn|strict|error>   Minimum tier that fails the check (default: warn \u2014 any flagged file fails)

Exit codes:
  0  no file at or above the --fail-on tier
  1  one or more files at or above the --fail-on tier
  2  not a git repository or invalid arguments

Exemptions: add entries to .omp/file-size-exemptions.json at the repo root:
  {"files": {"src/data/word-list.ts": "<reason>"}, "extensions": {".snap": "<reason>"}}

Custom thresholds: add .omp/file-size-guard.json at the repo root (any subset; the rest default):
  {"warn": 200, "strict": 300, "error": 400}

Default limits: warn > ${DEFAULT_LIMITS.warn} lines, strict > ${DEFAULT_LIMITS.strict}, error > ${DEFAULT_LIMITS.error}`);
}
var args = process.argv.slice(2).filter((a) => a !== "check");
var failOn = "warn";
var dir;
for (const a of args) {
  if (a === "--help" || a === "-h") {
    usage();
    process.exit(0);
  } else if (a.startsWith("--fail-on=")) {
    const v = a.slice("--fail-on=".length);
    if (v !== "warn" && v !== "strict" && v !== "error") {
      console.error(`fsg: invalid --fail-on value "${v}" (expected warn, strict, or error)`);
      process.exit(2);
    }
    failOn = v;
  } else if (a.startsWith("-")) {
    console.error(`fsg: unknown option "${a}"`);
    usage();
    process.exit(2);
  } else if (dir === void 0) {
    dir = a;
  } else {
    console.error(`fsg: unexpected extra argument "${a}"`);
    process.exit(2);
  }
}
var cwd = dir ?? process.cwd();
if (!existsSync2(cwd)) {
  console.error(`fsg: directory does not exist: ${cwd}`);
  process.exit(2);
}
var top = git(cwd, ["rev-parse", "--show-toplevel"]);
if (top === null) {
  console.error(`fsg: ${cwd} is not inside a git repository \u2014 nothing to check (the guard is git-based by design).`);
  process.exit(2);
}
var root = top.trim();
if (existsSync2(path2.join(root, CONFIG_REL))) {
  let bad = true;
  try {
    bad = limitsFrom(JSON.parse(readFileSync2(path2.join(root, CONFIG_REL), "utf8"))) === null;
  } catch {
    bad = true;
  }
  if (bad) console.error(`fsg: ${CONFIG_REL} is malformed or not ascending (warn < strict < error) \u2014 using default limits.`);
}
var { flagged, counts, limits } = scanAll(root, root);
if (flagged.length === 0) {
  console.log(`fsg: ${root} \u2014 all authored files within the line limits.`);
  process.exit(0);
}
var byTier = (t) => flagged.filter((f) => f.tier === t);
for (const tier of ["error", "strict", "warn"]) {
  const entries = byTier(tier);
  if (entries.length === 0) continue;
  const limit = tier === "error" ? limits.error : tier === "strict" ? limits.strict : limits.warn;
  console.log(`
${tier.toUpperCase()} (over ${limit} lines):`);
  for (const f of entries) console.log(`  ${formatFlagged(f, limits)}`);
}
console.log(
  `
fsg: ${flagged.length} file(s) over the limits \u2014 ${counts.error} error, ${counts.strict} strict, ${counts.warn} warn. Split, shrink, or extract constants; or exempt deliberately in .omp/file-size-exemptions.json.`
);
var failed = flagged.some((f) => TIER_RANK[f.tier] >= TIER_RANK[failOn]);
process.exit(failed ? 1 : 0);
