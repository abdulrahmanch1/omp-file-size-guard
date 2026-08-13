// fsg — file-size-guard CLI. `file-size-guard check` scans every authored file in the
// current git repository (tracked + untracked, .gitignore respected) and
// exits non-zero when files exceed the line limits. Same core, exemptions
// file, and thresholds as the agent extensions — one policy for agents,
// humans (pre-commit), and CI.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	CONFIG_REL,
	DEFAULT_LIMITS,
	type FlaggedEntry,
	type Tier,
	formatFlagged,
	git,
	limitsFrom,
	scanAll,
} from "../core/guard.ts";

const TIER_RANK: Record<Tier, number> = { warn: 1, strict: 2, error: 3 };

function usage(): void {
	console.log(`fsg — file-size-guard CLI

Usage:
  fsg [check] [dir]     Scan all authored files in the git repo containing dir (default: cwd)
  fsg --help            Show this help

Options:
  --fail-on=<warn|strict|error>   Minimum tier that fails the check (default: warn — any flagged file fails)

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

const args = process.argv.slice(2).filter((a) => a !== "check");
let failOn: Tier = "warn";
let dir: string | undefined;
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
	} else if (dir === undefined) {
		dir = a;
	} else {
		console.error(`fsg: unexpected extra argument "${a}"`);
		process.exit(2);
	}
}

const cwd = dir ?? process.cwd();
if (!existsSync(cwd)) {
	console.error(`fsg: directory does not exist: ${cwd}`);
	process.exit(2);
}
const top = git(cwd, ["rev-parse", "--show-toplevel"]);
if (top === null) {
	console.error(`fsg: ${cwd} is not inside a git repository — nothing to check (the guard is git-based by design).`);
	process.exit(2);
}
const root = top.trim();

// A present-but-unusable config deserves a visible note; absent means silent defaults.
if (existsSync(path.join(root, CONFIG_REL))) {
	let bad = true;
	try {
		bad = limitsFrom(JSON.parse(readFileSync(path.join(root, CONFIG_REL), "utf8"))) === null;
	} catch {
		bad = true;
	}
	if (bad) console.error(`fsg: ${CONFIG_REL} is malformed or not ascending (warn < strict < error) — using default limits.`);
}

const { flagged, counts, limits } = scanAll(root, root);

if (flagged.length === 0) {
	console.log(`fsg: ${root} — all authored files within the line limits.`);
	process.exit(0);
}

const byTier = (t: Tier): FlaggedEntry[] => flagged.filter((f) => f.tier === t);
for (const tier of ["error", "strict", "warn"] as const) {
	const entries = byTier(tier);
	if (entries.length === 0) continue;
	const limit = tier === "error" ? limits.error : tier === "strict" ? limits.strict : limits.warn;
	console.log(`\n${tier.toUpperCase()} (over ${limit} lines):`);
	for (const f of entries) console.log(`  ${formatFlagged(f, limits)}`);
}
console.log(
	`\nfsg: ${flagged.length} file(s) over the limits — ${counts.error} error, ${counts.strict} strict, ${counts.warn} warn. ` +
		`Split, shrink, or extract constants; or exempt deliberately in .omp/file-size-exemptions.json.`,
);

const failed = flagged.some((f) => TIER_RANK[f.tier] >= TIER_RANK[failOn]);
process.exit(failed ? 1 : 0);
