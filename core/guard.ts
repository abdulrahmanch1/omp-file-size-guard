// file-size-guard shared core: pure, host-agnostic logic.
// Adapters (omp / pi / opencode) wire these primitives to their host's
// event lifecycle, UI surface, and message-injection contract.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WARN_LINES = 150;
export const STRICT_LINES = 250;
export const ERROR_LINES = 350;
export const EXEMPTIONS_REL = ".omp/file-size-exemptions.json";
export const ONBOARDED_REL = ".omp/file-size-guard-onboarded.json";

export type Tier = "error" | "strict" | "warn";

export interface Exemptions {
	files: Record<string, string>;
	extensions: Record<string, string>;
}

export interface FlaggedEntry {
	rel: string;
	lines: number;
	tier: Tier;
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let newlines = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
	return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
}

// Counts lines streaming in 64 KiB chunks: memory stays bounded no matter the
// file size, and the binary NUL check only inspects the first 4 KiB.
// Returns null for binary or unreadable files (both are skipped by callers).
export function countFileLines(abs: string): number | null {
	let fd: number;
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
		for (;;) {
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

export function loadExemptions(cwd: string): Exemptions {
	try {
		const raw = JSON.parse(readFileSync(path.join(cwd, EXEMPTIONS_REL), "utf8"));
		return {
			files: raw && typeof raw.files === "object" && raw.files !== null ? raw.files : {},
			extensions: raw && typeof raw.extensions === "object" && raw.extensions !== null ? raw.extensions : {},
		};
	} catch {
		return { files: {}, extensions: {} };
	}
}

export function relKey(absPath: string, cwd: string): string {
	const rel = path.relative(cwd, absPath);
	if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
	return absPath;
}

export function shouldSkip(absPath: string, cwd: string): boolean {
	if (absPath.includes("://")) return true;
	const rel = relKey(absPath, cwd);
	return rel === ".git" || rel.startsWith(".git/") || rel.startsWith("node_modules/") || rel.includes("/node_modules/");
}

export function isExempt(absPath: string, cwd: string, ex: Exemptions): boolean {
	return ex.files[relKey(absPath, cwd)] !== undefined || ex.extensions[path.extname(absPath)] !== undefined;
}

export function tierFor(lines: number): Tier | null {
	if (lines > ERROR_LINES) return "error";
	if (lines > STRICT_LINES) return "strict";
	if (lines > WARN_LINES) return "warn";
	return null;
}

const REMEDIATION = `Review the file and decide:
1. If there is no strong reason for this size: split it into smaller modules, extract repeated literals into constants, or remove duplication — then continue.
2. If it genuinely must stay one piece (e.g. this type of file must remain a single unit, or the logic must stay together for readability): add an exemption to .omp/file-size-exemptions.json at the project root with EITHER a per-file entry {"files": {"<cwd-relative-path>": "<convincing reason>"}} OR an extension entry {"extensions": {"<.ext>": "<convincing reason>"}}. Exempted files are never flagged again.`;

export function tierMessage(tier: Tier, rel: string, lines: number): string {
	if (tier === "error") {
		return `[file-size-guard] ERROR: ${rel} now has ${lines} lines (hard limit ${ERROR_LINES}). You MUST reduce it below ${ERROR_LINES} lines before doing anything else: split it, extract constants, or — only if a single piece is genuinely required — add a convincing exemption entry.\n${REMEDIATION}`;
	}
	if (tier === "strict") {
		return `[file-size-guard] STRICT WARNING: ${rel} now has ${lines} lines (strict limit ${STRICT_LINES}). This is excessive for a single file.\n${REMEDIATION}`;
	}
	return `[file-size-guard] WARNING: ${rel} now has ${lines} lines (soft limit ${WARN_LINES}).\n${REMEDIATION}`;
}

export function blockReason(rel: string, lines: number): string {
	return `[file-size-guard] BLOCKED: this change would make ${rel} ${lines} lines (hard limit ${ERROR_LINES}). Write a smaller file: split the code into multiple modules, extract repeated literals into constants, or — only if a single piece is genuinely required — first add a convincing exemption entry to .omp/file-size-exemptions.json ({"files": {"${rel}": "<reason>"}}), then retry the write.`;
}

export function git(root: string, args: string[]): string | null {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : null;
}

// Files changed vs HEAD (staged + unstaged, renames report the new name) plus
// untracked files. --exclude-standard makes git skip .gitignore'd paths
// (node_modules, dist, …) natively. Paths are NUL-separated, relative to root.
export function changedFiles(root: string): Set<string> {
	const hasHead = git(root, ["rev-parse", "--verify", "HEAD"]) !== null;
	const diffArgs = hasHead ? ["diff", "--name-only", "-z", "HEAD"] : ["diff", "--name-only", "-z", "--cached"];
	const out = new Set<string>();
	for (const stdout of [git(root, diffArgs), git(root, ["ls-files", "--others", "--exclude-standard", "-z"])]) {
		if (stdout === null) continue;
		for (const p of stdout.split("\0")) if (p) out.add(p);
	}
	return out;
}

function statKey(abs: string): string {
	try {
		const st = statSync(abs);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}

// Every authored file in the repo: tracked + untracked-but-not-ignored.
// Used only by the one-time onboarding scan.
export function allFiles(root: string): string[] {
	const stdout = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (stdout === null) return [];
	return stdout.split("\0").filter((p) => p.length > 0);
}

// Dirty-file snapshot: gitRel -> "mtimeMs:size". A file dirty before a run is
// only flagged if the agent touched it since the snapshot.
export type Baseline = Map<string, string>;

export function snapshotBaseline(root: string): Baseline {
	const baseline: Baseline = new Map();
	for (const p of changedFiles(root)) baseline.set(p, statKey(path.join(root, p)));
	return baseline;
}

function classify(abs: string, cwd: string, ex: Exemptions): FlaggedEntry | null {
	if (shouldSkip(abs, cwd) || isExempt(abs, cwd, ex)) return null;
	const lines = countFileLines(abs); // null = binary or unreadable
	if (lines === null) return null;
	const tier = tierFor(lines);
	if (!tier) return null;
	return { rel: relKey(abs, cwd), lines, tier };
}

// End-of-run scan: files that appeared or changed since the baseline.
export function scanChanged(root: string, cwd: string, baseline: Baseline): FlaggedEntry[] {
	const ex = loadExemptions(cwd);
	const flagged: FlaggedEntry[] = [];
	for (const p of changedFiles(root)) {
		const abs = path.join(root, p);
		const before = baseline.get(p);
		if (before !== undefined && before === statKey(abs)) continue; // dirty before the run, untouched since
		if (!existsSync(abs)) continue; // deleted during the run
		const entry = classify(abs, cwd, ex);
		if (entry) flagged.push(entry);
	}
	return flagged;
}

// One-time onboarding scan: EVERY authored file, changed or not.
export function scanAll(root: string, cwd: string): { flagged: FlaggedEntry[]; counts: Record<Tier, number> } {
	const ex = loadExemptions(cwd);
	const flagged: FlaggedEntry[] = [];
	const counts: Record<Tier, number> = { warn: 0, strict: 0, error: 0 };
	for (const p of allFiles(root)) {
		const entry = classify(path.join(root, p), cwd, ex);
		if (!entry) continue;
		counts[entry.tier]++;
		flagged.push(entry);
	}
	return { flagged, counts };
}

// Report handed to the agent when a run settles with over-limit files.
export function reportText(flagged: FlaggedEntry[]): string {
	return [
		`[file-size-guard] End-of-turn git scan: ${flagged.length} file(s) changed this turn exceed the line limits. Address each one now — split it, shrink it, extract constants, or add a convincing exemption:`,
		...flagged.map((f) => tierMessage(f.tier, f.rel, f.lines)),
	].join("\n\n");
}

function limitFor(tier: Tier): number {
	return tier === "error" ? ERROR_LINES : tier === "strict" ? STRICT_LINES : WARN_LINES;
}

export function formatFlagged(entry: FlaggedEntry): string {
	return `${entry.rel} — ${entry.lines} lines (limit ${limitFor(entry.tier)})`;
}

export function onboardingDialog(flagged: FlaggedEntry[], counts: Record<Tier, number>): string {
	return `${flagged.length} file(s) exceed the line limits (${counts.error} over ${ERROR_LINES}, ${counts.strict} over ${STRICT_LINES}, ${counts.warn} over ${WARN_LINES}).\n\nYes — the agent fixes each file now (split / shrink / extract constants), exempting only what genuinely must stay one piece.\nNo — every flagged file is added to .omp/file-size-exemptions.json and never flagged again.`;
}

export function onboardingPrompt(flagged: FlaggedEntry[]): string {
	const list = flagged.slice(0, 1000);
	return `[file-size-guard onboarding] This project has ${flagged.length} file(s) over the line limits:\n${list.map((f) => `- ${formatFlagged(f)}`).join("\n")}${flagged.length > list.length ? `\n…and ${flagged.length - list.length} more.` : ""}\nFix every one now: split into smaller modules, shrink them, or extract repeated literals into constants. Only where a single piece is genuinely required, add a convincing per-file exemption to .omp/file-size-exemptions.json. The guard re-scans everything you change when your run ends and will send you back to any file still over the limit.`;
}

export function markerExists(cwd: string): boolean {
	return existsSync(path.join(cwd, ONBOARDED_REL));
}

export function writeMarker(cwd: string, decision: string): void {
	try {
		mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		writeFileSync(path.join(cwd, ONBOARDED_REL), `${JSON.stringify({ version: 1, decision, at: new Date().toISOString() })}\n`);
	} catch {
		// a read-only .omp must not break the session; onboarding simply re-offers next time
	}
}

// Decline path: every flagged file is exempted with an auditable reason,
// preserving any existing entries (files and extensions keys).
export function bulkExempt(cwd: string, flagged: FlaggedEntry[]): void {
	const exPath = path.join(cwd, EXEMPTIONS_REL);
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(exPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
	} catch {
		raw = {};
	}
	const files: Record<string, string> =
		raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)
			? { ...(raw.files as Record<string, string>) }
			: {};
	for (const entry of flagged) {
		files[entry.rel] = "Pre-existing file at file-size-guard adoption; user declined onboarding fixes.";
	}
	raw.files = files;
	try {
		mkdirSync(path.join(cwd, ".omp"), { recursive: true });
		writeFileSync(exPath, `${JSON.stringify(raw, null, 2)}\n`);
	} catch {
		// same rationale as writeMarker
	}
}

// Estimate the content an `edit` call would produce, mirroring the host tool's
// replace semantics. null = not computable (missing file, unmatched old_string).
export function estimateEditResult(abs: string, oldString: string, newString: string, replaceAll: boolean): string | null {
	try {
		const cur = readFileSync(abs, "utf8");
		const next = replaceAll && oldString !== "" ? cur.split(oldString).join(newString) : cur.replace(oldString, newString);
		return next === cur ? null : next;
	} catch {
		return null;
	}
}
