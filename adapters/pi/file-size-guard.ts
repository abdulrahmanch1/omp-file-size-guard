import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// pi adapter. pi has no session_stop continuation: before_agent_start and
// agent_end each fire exactly once per user prompt, so the baseline anchors at
// run start, the scan runs at run end, and the report is delivered as an
// injected message at the NEXT run's start (documented limitation: a
// single-shot headless run never receives its own report).
export default function fileSizeGuard(pi: ExtensionAPI): void {
	const probeRoot = (cwd: string): string | null => {
		const out = git(cwd, ["rev-parse", "--show-toplevel"]);
		return out === null ? null : out.trim();
	};
	const repoRoots = new Map<string, string | null>();
	const repoRoot = (cwd: string): string | null => {
		const cached = repoRoots.get(cwd);
		if (cached !== undefined) return cached;
		const root = probeRoot(cwd);
		repoRoots.set(cwd, root);
		return root;
	};

	let baseline: Baseline = new Map();
	let baselineRoot: string | null = null;
	let pendingReport: string | null = null;

	// One-time onboarding per project (see the omp adapter for the full
	// rationale). pi ctx has no managed timers, so a plain setTimeout defers
	// past session_start dispatch — the WHOLE deferred body stays inside
	// try/catch, because an unhandled throw outlives handler isolation here.
	pi.on("session_start", async (_event, ctx) => {
		const root = repoRoot(ctx.cwd);
		if (root === null) return;
		if (markerExists(ctx.cwd)) return;
		if (!ctx.hasUI) return;
		setTimeout(() => {
			void (async () => {
				try {
					const { flagged, counts, limits } = scanAll(root, ctx.cwd);
					if (flagged.length === 0) {
						writeMarker(ctx.cwd, "clean");
						return;
					}
					const fix = await ctx.ui.confirm(
						"file-size-guard: initial project scan",
						onboardingDialog(flagged, counts, limits),
					);
					if (!fix) {
						bulkExempt(ctx.cwd, flagged);
						writeMarker(ctx.cwd, "exempted");
						ctx.ui.notify(`file-size-guard: ${flagged.length} pre-existing file(s) exempted`, "info");
						return;
					}
					await pi.sendUserMessage(onboardingPrompt(flagged, limits));
					writeMarker(ctx.cwd, "fix");
				} catch {
					// dialog dismissed/failed, scan blew up, or send failed: postpone
					// to the next session — never bulk-exempt by accident.
					try {
						ctx.ui.notify("file-size-guard: initial scan postponed to next session", "info");
					} catch {
						// headless/torn-down UI: nothing more to do
					}
				}
			})();
		}, 300);
	});

	// Pre-execution hard limit (error tier) for write/edit — identical to omp.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (repoRoot(ctx.cwd) === null) return;
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

	// Run start: fresh baseline (picks up `git init` since last run), plus
	// delivery of the previous run's report as a persistent injected message.
	pi.on("before_agent_start", async (_event, ctx) => {
		const root = probeRoot(ctx.cwd);
		repoRoots.set(ctx.cwd, root);
		baselineRoot = root;
		baseline = root === null ? new Map() : snapshotBaseline(root);
		if (pendingReport === null) return;
		const text = pendingReport;
		pendingReport = null;
		return {
			message: {
				customType: "file-size-guard",
				content: text,
				display: true,
			},
		};
	});

	// Run end (agent_end fires once per user prompt): scan and stash.
	pi.on("agent_end", async (_event, ctx) => {
		const root = repoRoot(ctx.cwd);
		if (root === null || root !== baselineRoot) return;
		const flagged = scanChanged(root, ctx.cwd, baseline);
		if (flagged.length === 0) return;
		pendingReport = reportText(flagged, loadLimits(ctx.cwd));
		if (ctx.hasUI) ctx.ui.notify(`file-size-guard: ${flagged.length} file(s) over the line limits`, "warning");
	});
}
