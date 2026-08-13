import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import path from "node:path";
import {
	type Baseline,
	blockReason,
	bulkExempt,
	countLines,
	estimateEditResult,
	git,
	isExempt,
	loadExemptions,
	loadLimits,
	markerExists,
	onboardingDialog,
	onboardingPrompt,
	relKey,
	reportText,
	scanAll,
	scanChanged,
	shouldSkip,
	snapshotBaseline,
	writeMarker,
} from "../../core/guard.ts";

export default function fileSizeGuard(pi: ExtensionAPI): void {
	const probeRoot = (cwd: string): string | null => {
		const out = git(cwd, ["rev-parse", "--show-toplevel"]);
		return out === null ? null : out.trim();
	};
	// Probed once per cwd, re-probed each run start: tool_call between runs
	// uses the cached value instead of spawning git on every write/edit.
	const repoRoots = new Map<string, string | null>();
	const repoRoot = (cwd: string): string | null => {
		const cached = repoRoots.get(cwd);
		if (cached !== undefined) return cached;
		const root = probeRoot(cwd);
		repoRoots.set(cwd, root);
		return root;
	};

	// Dirty-file snapshot at run start. turn_start fires per agent-loop
	// iteration, so it cannot anchor the baseline; before_agent_start fires once
	// per run. Our own session_stop continuation starts a new run — keep the
	// original baseline for it, or the files flagged last stop would count as
	// "pre-existing" and never re-flag.
	let baseline: Baseline = new Map();
	let baselineRoot: string | null = null;
	let continuationExpected = false;

	// One-time onboarding per project: on the first interactive session in a git
	// repo, scan EVERY authored file (not just changed ones) and let the user
	// choose: the agent fixes all over-limit files now, or every flagged file is
	// bulk-exempted. A marker file makes it run exactly once; headless sessions
	// and non-git directories are skipped without consuming the marker.
	// Everything past the three cheap guards runs in a managed timer: the scan
	// can take seconds on a huge repo and the confirm can sit unanswered, both
	// longer than the 30s handler-dispatch timeout. A failed/dismissed dialog
	// POSTPONES onboarding (no marker, no exemptions) — never bulk-exempts.
	pi.on("session_start", async (_event, ctx) => {
		const root = repoRoot(ctx.cwd);
		if (root === null) return;
		if (markerExists(ctx.cwd)) return;
		if (!ctx.hasUI) return;
		ctx.setTimeout(() => {
			void (async () => {
				const { flagged, counts, limits } = scanAll(root, ctx.cwd);
				if (flagged.length === 0) {
					writeMarker(ctx.cwd, "clean");
					return;
				}
				let fix: boolean;
				try {
					fix = await ctx.ui.confirm("file-size-guard: initial project scan", onboardingDialog(flagged, counts, limits));
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
				void pi.sendUserMessage(onboardingPrompt(flagged, limits));
			})();
		}, 300);
	});

	// Pre-execution hard limit (error tier) for write/edit — the only tier that can be
	// prevented before it happens. Everything else is reported when the run settles.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (repoRoot(ctx.cwd) === null) return; // no git repo: guard fully inactive
		const p = String(event.input.path ?? "");
		const abs = path.resolve(ctx.cwd, p);
		if (!p || shouldSkip(abs, ctx.cwd)) return;
		const newText =
			event.toolName === "write"
				? String(event.input.content ?? "")
				: estimateEditResult(
						abs,
						String(event.input.old_string ?? ""),
						String(event.input.new_string ?? ""),
						event.input.replace_all === true,
					);
		if (newText === null) return;
		const lines = countLines(newText);
		const limits = loadLimits(ctx.cwd);
		if (lines <= limits.error) return;
		if (isExempt(abs, ctx.cwd, loadExemptions(ctx.cwd))) return;
		return { block: true, reason: blockReason(relKey(abs, ctx.cwd), lines, limits) };
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (continuationExpected) {
			continuationExpected = false;
			return;
		}
		const root = probeRoot(ctx.cwd); // fresh probe: picks up `git init` since last run
		repoRoots.set(ctx.cwd, root);
		baselineRoot = root;
		baseline = root === null ? new Map() : snapshotBaseline(root);
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
		const flagged = scanChanged(root, ctx.cwd, baseline);
		if (flagged.length === 0) return;
		if (ctx.hasUI) ctx.ui.notify(`file-size-guard: ${flagged.length} file(s) over the line limits`, "warning");
		continuationExpected = true;
		return { continue: true, additionalContext: reportText(flagged, loadLimits(ctx.cwd)) };
	});
}
