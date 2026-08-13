// fsg — file-size-guard CLI. `fsg check` scans every authored file in the
// current git repository (tracked + untracked, .gitignore respected) and
// exits non-zero when files exceed the line limits. Same core, exemptions
// file, and thresholds as the agent extensions — one policy for agents,
// humans (pre-commit), and CI.
import {
	ERROR_LINES,
	type FlaggedEntry,
	STRICT_LINES,
	type Tier,
	WARN_LINES,
	formatFlagged,
	git,
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

Limits: warn > ${WARN_LINES} lines, strict > ${STRICT_LINES}, error > ${ERROR_LINES}`);
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
const top = git(cwd, ["rev-parse", "--show-toplevel"]);
if (top === null) {
	console.error(`fsg: ${cwd} is not inside a git repository — nothing to check (the guard is git-based by design).`);
	process.exit(2);
}
const root = top.trim();

const { flagged, counts } = scanAll(root, root);

if (flagged.length === 0) {
	console.log(`fsg: ${root} — all authored files within the line limits.`);
	process.exit(0);
}

const byTier = (t: Tier): FlaggedEntry[] => flagged.filter((f) => f.tier === t);
for (const tier of ["error", "strict", "warn"] as const) {
	const entries = byTier(tier);
	if (entries.length === 0) continue;
	const limit = tier === "error" ? ERROR_LINES : tier === "strict" ? STRICT_LINES : WARN_LINES;
	console.log(`\n${tier.toUpperCase()} (over ${limit} lines):`);
	for (const f of entries) console.log(`  ${formatFlagged(f)}`);
}
console.log(
	`\nfsg: ${flagged.length} file(s) over the limits — ${counts.error} error, ${counts.strict} strict, ${counts.warn} warn. ` +
		`Split, shrink, or extract constants; or exempt deliberately in .omp/file-size-exemptions.json.`,
);

const failed = flagged.some((f) => TIER_RANK[f.tier] >= TIER_RANK[failOn]);
process.exit(failed ? 1 : 0);
