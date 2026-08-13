import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";
import {
	type Baseline,
	blockReason,
	countLines,
	estimateEditResult,
	git,
	isExempt,
	loadExemptions,
	loadLimits,
	markerExists,
	relKey,
	reportText,
	scanAll,
	scanChanged,
	shouldSkip,
	snapshotBaseline,
	writeMarker,
} from "../../core/guard.ts";

// opencode adapter. opencode has no stop-hook continuation and no confirm UI
// for plugins, but every session fires `session.idle` at run end and the SDK
// client can inject a prompt into the session — the report therefore arrives
// as a real user-role prompt immediately after the run settles, which starts
// the fix run on its own. Baselines are idle→idle windows per sessionID.
export const FileSizeGuard: Plugin = async (input) => {
	const cwd = input.directory;
	const probeRoot = (): string | null => {
		const out = git(cwd, ["rev-parse", "--show-toplevel"]);
		return out === null ? null : out.trim();
	};
	let root = probeRoot(); // re-probed after every idle scan
	let baseline: Baseline = root === null ? new Map() : snapshotBaseline(root);

	const inject = async (sessionID: string, text: string): Promise<void> => {
		await input.client.session.prompt({
			path: { id: sessionID },
			body: { parts: [{ type: "text", text }] },
		});
	};

	return {
		// Pre-execution hard limit (error tier): throwing blocks the tool call and the
		// message reaches the agent as the tool error.
		"tool.execute.before": async ({ tool }, output) => {
			if (tool !== "write" && tool !== "edit") return;
			if (root === null) return; // no git repo: guard fully inactive
			const args = output.args as Record<string, unknown>;
			const p = String(args.filePath ?? "");
			const abs = path.resolve(cwd, p);
			if (!p || shouldSkip(abs, cwd)) return;
			const newText =
				tool === "write"
					? String(args.content ?? "")
					: estimateEditResult(abs, String(args.oldString ?? ""), String(args.newString ?? ""), args.replaceAll === true);
			if (newText === null) return;
			const lines = countLines(newText);
			const limits = loadLimits(cwd);
			if (lines <= limits.error) return;
			if (isExempt(abs, cwd, loadExemptions(cwd))) return;
			throw new Error(blockReason(relKey(abs, cwd), lines, limits));
		},

		event: async ({ event }) => {
			if (event.type !== "session.idle") return;
			if (root === null) {
				root = probeRoot(); // a `git init` since plugin load activates the guard
				baseline = root === null ? new Map() : snapshotBaseline(root);
				return;
			}
			const sessionID = event.properties.sessionID;

			// One-time onboarding: no confirm UI exists for plugins, so the scan
			// result is injected as a prompt and the agent settles the decision
			// with the user (fix now vs bulk-exempt into the exemptions file).
			if (!markerExists(cwd)) {
				const { flagged } = scanAll(root, cwd);
				if (flagged.length === 0) {
					writeMarker(cwd, "clean");
				} else {
					writeMarker(cwd, "prompted");
					const bulk = flagged.map((f) => `- ${f.rel}`).join("\n");
					await inject(
						sessionID,
						`[file-size-guard onboarding] This project has ${flagged.length} pre-existing file(s) over the line limits:\n${bulk}\nAsk the user to choose:\n1. Fix them all now (split / shrink / extract constants; add a convincing per-file exemption to .omp/file-size-exemptions.json only where a single piece is genuinely required).\n2. Leave them: then add EVERY listed file to .omp/file-size-exemptions.json with the reason "Pre-existing file at file-size-guard adoption; user declined onboarding fixes." so they are never flagged again.\nDo not proceed with other work until the user has chosen.`,
					);
				}
				baseline = snapshotBaseline(root);
				return;
			}

			const flagged = scanChanged(root, cwd, baseline);
			baseline = snapshotBaseline(root); // next run measures from this idle
			if (flagged.length === 0) return;
			await inject(sessionID, reportText(flagged, loadLimits(cwd)));
		},
	};
};

export default FileSizeGuard;
