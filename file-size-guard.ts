import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const WARN_LINES = 150;
const STRICT_LINES = 250;
const ERROR_LINES = 350;
const EXEMPTIONS_REL = ".omp/file-size-exemptions.json";
const ONBOARDED_REL = ".omp/file-size-guard-onboarded.json";

interface Exemptions {
	files: Record<string, string>;
	extensions: Record<string, string>;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let newlines = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
	return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
}

// Counts lines streaming in 64 KiB chunks: memory stays bounded no matter the
// file size, and the binary NUL check only inspects the first 4 KiB.
// Returns null for binary or unreadable files (both are skipped by callers).
function countFileLines(abs: string): number | null {
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

function loadExemptions(cwd: string): Exemptions {
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

function relKey(absPath: string, cwd: string): string {
	const rel = path.relative(cwd, absPath);
	if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
	return absPath;
}

function shouldSkip(absPath: string, cwd: string): boolean {
	if (absPath.includes("://")) return true;
	const rel = relKey(absPath, cwd);
	return rel === ".git" || rel.startsWith(".git/") || rel.startsWith("node_modules/") || rel.includes("/node_modules/");
}

function isExempt(absPath: string, cwd: string, ex: Exemptions): boolean {
	return ex.files[relKey(absPath, cwd)] !== undefined || ex.extensions[path.extname(absPath)] !== undefined;
}

function tierFor(lines: number): "error" | "strict" | "warn" | null {
	if (lines > ERROR_LINES) return "error";
	if (lines > STRICT_LINES) return "strict";
	if (lines > WARN_LINES) return "warn";
	return null;
}

const REMEDIATION = `Review the file and decide:
1. If there is no strong reason for this size: split it into smaller modules, extract repeated literals into constants, or remove duplication — then continue.
2. If it genuinely must stay one piece (e.g. this type of file must remain a single unit, or the logic must stay together for readability): add an exemption to .omp/file-size-exemptions.json at the project root with EITHER a per-file entry {"files": {"<cwd-relative-path>": "<convincing reason>"}} OR an extension entry {"extensions": {"<.ext>": "<convincing reason>"}}. Exempted files are never flagged again.`;

function tierMessage(tier: "error" | "strict" | "warn", rel: string, lines: number): string {
	if (tier === "error") {
		return `[file-size-guard] ERROR: ${rel} now has ${lines} lines (hard limit ${ERROR_LINES}). You MUST reduce it below ${ERROR_LINES} lines before doing anything else: split it, extract constants, or — only if a single piece is genuinely required — add a convincing exemption entry.\n${REMEDIATION}`;
	}
	if (tier === "strict") {
		return `[file-size-guard] STRICT WARNING: ${rel} now has ${lines} lines (strict limit ${STRICT_LINES}). This is excessive for a single file.\n${REMEDIATION}`;
	}
	return `[file-size-guard] WARNING: ${rel} now has ${lines} lines (soft limit ${WARN_LINES}).\n${REMEDIATION}`;
}

function blockReason(rel: string, lines: number): string {
	return `[file-size-guard] BLOCKED: this change would make ${rel} ${lines} lines (hard limit ${ERROR_LINES}). Write a smaller file: split the code into multiple modules, extract repeated literals into constants, or — only if a single piece is genuinely required — first add a convincing exemption entry to .omp/file-size-exemptions.json ({"files": {"${rel}": "<reason>"}}), then retry the write.`;
}

function git(root: string, args: string[]): string | null {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : null;
}

// Files changed vs HEAD (staged + unstaged, renames report the new name) plus
// untracked files. --exclude-standard makes git skip .gitignore'd paths
// (node_modules, dist, …) natively. Paths are NUL-separated, relative to root.
function changedFiles(root: string): Set<string> {
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
function allFiles(root: string): string[] {
	const stdout = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (stdout === null) return [];
	return stdout.split("\0").filter((p) => p.length > 0);
}

export default function fileSizeGuard(pi: ExtensionAPI): void {
	const probeRoot = (cwd: string): string | null => {
		const out = git(cwd, ["rev-parse", "--show-toplevel"]);
		return out === null ? null : out.trim();
	};
	// Probed once per cwd, re-probed each turn_start: tool_call between turns
	// uses the cached value instead of spawning git on every write/edit.
	const repoRoots = new Map<string, string | null>();
	const repoRoot = (cwd: string): string | null => {
		const cached = repoRoots.get(cwd);
		if (cached !== undefined) return cached;
		const root = probeRoot(cwd);
		repoRoots.set(cwd, root);
		return root;
	};

	// Dirty-file snapshot at run start: gitRel -> "mtimeMs:size". A file dirty
	// before the user's prompt is only flagged if the agent touched it since.
	// turn_start fires per agent-loop iteration, so it cannot anchor the
	// baseline; before_agent_start fires once per run. Our own session_stop
	// continuation starts a new run — keep the original baseline for it, or the
	// files flagged last stop would count as "pre-existing" and never re-flag.
	let baseline: Map<string, string> = new Map();
	let baselineRoot: string | null = null;
	let continuationExpected = false;

	// One-time onboarding per project: on the first interactive session in a git
	// repo, scan EVERY authored file (not just changed ones) and let the user
	// choose: the agent fixes all over-limit files now, or every flagged file is
	// bulk-exempted. A marker file makes it run exactly once; headless sessions
	// and non-git directories are skipped without consuming the marker.
	pi.on("session_start", async (_event, ctx) => {
		const root = repoRoot(ctx.cwd);
		if (root === null) return;
		const markerPath = path.join(ctx.cwd, ONBOARDED_REL);
		if (existsSync(markerPath)) return;
		if (!ctx.hasUI) return;
		const ex = loadExemptions(ctx.cwd);
		const flagged: string[] = [];
		const counts = { warn: 0, strict: 0, error: 0 };
		for (const p of allFiles(root)) {
			const abs = path.join(root, p);
			if (shouldSkip(abs, ctx.cwd) || isExempt(abs, ctx.cwd, ex)) continue;
			const lines = countFileLines(abs);
			if (lines === null) continue;
			const tier = tierFor(lines);
			if (!tier) continue;
			counts[tier]++;
			const limit = tier === "error" ? ERROR_LINES : tier === "strict" ? STRICT_LINES : WARN_LINES;
			flagged.push(`${relKey(abs, ctx.cwd)} — ${lines} lines (limit ${limit})`);
		}
		const writeMarker = (decision: string): void => {
			try {
				mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
				writeFileSync(markerPath, `${JSON.stringify({ version: 1, decision, at: new Date().toISOString() })}\n`);
			} catch {
				// a read-only .omp must not break the session; onboarding simply re-offers next time
			}
		};
		if (flagged.length === 0) {
			writeMarker("clean");
			return;
		}
		const message = `${flagged.length} file(s) exceed the line limits (${counts.error} over ${ERROR_LINES}, ${counts.strict} over ${STRICT_LINES}, ${counts.warn} over ${WARN_LINES}).\n\nYes — the agent fixes each file now (split / shrink / extract constants), exempting only what genuinely must stay one piece.\nNo — every flagged file is added to .omp/file-size-exemptions.json and never flagged again.`;
		// Deferred past session_start dispatch: the confirm may sit unanswered
		// longer than the 30s handler timeout. A failed/dismissed dialog POSTPONES
		// onboarding (no marker, no exemptions) — it never bulk-exempts by accident.
		ctx.setTimeout(() => {
			void (async () => {
				let fix: boolean;
				try {
					fix = await ctx.ui.confirm("file-size-guard: initial project scan", message);
				} catch {
					ctx.ui.notify("file-size-guard: initial scan postponed to next session", "info");
					return;
				}
				if (!fix) {
					const exPath = path.join(ctx.cwd, EXEMPTIONS_REL);
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
						files[entry.split(" — ")[0]] = "Pre-existing file at file-size-guard adoption; user declined onboarding fixes.";
					}
					raw.files = files;
					try {
						mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
						writeFileSync(exPath, `${JSON.stringify(raw, null, 2)}\n`);
					} catch {
						// same rationale as writeMarker
					}
					writeMarker("exempted");
					ctx.ui.notify(`file-size-guard: ${flagged.length} pre-existing file(s) exempted`, "info");
					return;
				}
				writeMarker("fix");
				const list = flagged.slice(0, 1000);
				const prompt = `[file-size-guard onboarding] This project has ${flagged.length} file(s) over the line limits:\n${list.map((f) => `- ${f}`).join("\n")}${flagged.length > list.length ? `\n…and ${flagged.length - list.length} more.` : ""}\nFix every one now: split into smaller modules, shrink them, or extract repeated literals into constants. Only where a single piece is genuinely required, add a convincing per-file exemption to .omp/file-size-exemptions.json. The guard re-scans everything you change when your run ends and will send you back to any file still over the limit.`;
				void pi.sendUserMessage(prompt);
			})();
		}, 300);
	});

	// Pre-execution hard limit (>350) for write/edit — the only tier that can be
	// prevented before it happens. Everything else is reported when the run settles.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (repoRoot(ctx.cwd) === null) return; // no git repo: guard fully inactive
		const p = String(event.input.path ?? "");
		const abs = path.resolve(ctx.cwd, p);
		if (!p || shouldSkip(abs, ctx.cwd)) return;
		let newText: string | null = null;
		if (event.toolName === "write") {
			newText = String(event.input.content ?? "");
		} else {
			// edit: estimate resulting content; fall through silently if not computable
			try {
				const cur = readFileSync(abs, "utf8");
				const oldString = String(event.input.old_string ?? "");
				const newString = String(event.input.new_string ?? "");
				const next =
					event.input.replace_all === true && oldString !== ""
						? cur.split(oldString).join(newString)
						: cur.replace(oldString, newString);
				if (next !== cur) newText = next;
			} catch {
				return;
			}
		}
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
		const root = probeRoot(ctx.cwd); // fresh probe: picks up `git init` since last run
		repoRoots.set(ctx.cwd, root);
		baselineRoot = root;
		baseline = new Map();
		if (root === null) return;
		for (const p of changedFiles(root)) baseline.set(p, statKey(path.join(root, p)));
	});

	// One scan per finished run: git names exactly what changed since the run
	// started — via write/edit/ast_edit/bash/eval and via task subagents alike,
	// since the baseline predates them all (subagents also get their own
	// extension instance, so their events never touch this state). session_stop
	// never fires for subagent sessions, and its continuation hands the report
	// to the agent immediately (core caps consecutive continuations at 8; if
	// the cap hits, continuationExpected stays set and the next prompt reuses
	// the stale baseline, which simply re-reports whatever is still too big).
	pi.on("session_stop", async (_event, ctx) => {
		const root = repoRoot(ctx.cwd);
		if (root === null || root !== baselineRoot) return;
		const ex = loadExemptions(ctx.cwd);
		const flagged: string[] = [];
		for (const p of changedFiles(root)) {
			const abs = path.join(root, p);
			const before = baseline.get(p);
			if (before !== undefined && before === statKey(abs)) continue; // dirty before the turn, untouched since
			if (shouldSkip(abs, ctx.cwd) || !existsSync(abs) || isExempt(abs, ctx.cwd, ex)) continue;
			const lines = countFileLines(abs); // null = binary or unreadable
			if (lines === null) continue;
			const tier = tierFor(lines);
			if (tier) flagged.push(tierMessage(tier, relKey(abs, ctx.cwd), lines));
		}
		if (flagged.length === 0) return;
		if (ctx.hasUI) ctx.ui.notify(`file-size-guard: ${flagged.length} file(s) over the line limits`, "warning");
		continuationExpected = true;
		return {
			continue: true,
			additionalContext: [
				`[file-size-guard] End-of-turn git scan: ${flagged.length} file(s) changed this turn exceed the line limits. Address each one now — split it, shrink it, extract constants, or add a convincing exemption:`,
				...flagged,
			].join("\n\n"),
		};
	});
}
