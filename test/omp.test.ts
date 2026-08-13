import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import fileSizeGuard from "../adapters/omp/file-size-guard.ts";

interface MockCtx {
	cwd: string;
	hasUI: boolean;
	ui?: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (msg: string, kind?: string) => void;
	};
	setTimeout?: (fn: () => void, ms: number) => number;
}
interface MockEvent {
	toolName: string;
	input: Record<string, unknown>;
}
interface Blocked {
	block: boolean;
	reason?: string;
}
interface Continuation {
	continue: boolean;
	additionalContext?: string;
}
type Handler = (event: MockEvent | Record<string, never>, ctx: MockCtx) => Promise<unknown>;

const handlers: Record<string, Handler[]> = {};
const sentPrompts: string[] = [];
const pi = {
	on: (event: string, h: Handler) => {
		(handlers[event] ??= []).push(h);
	},
	sendUserMessage: (content: string) => {
		sentPrompts.push(content);
		return Promise.resolve();
	},
};
// Mock boundary: pi only needs `on` + `sendUserMessage`; ExtensionAPI's full surface can't be expressed structurally here.
fileSizeGuard(pi as unknown as Parameters<typeof fileSizeGuard>[0]);
for (const e of ["tool_call", "before_agent_start", "session_stop", "session_start"]) {
	assert.equal(handlers[e]?.length, 1, `handler registered: ${e}`);
}

const gitIn = (cwd: string, args: string[]) =>
	spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

function mkGitCtx(): MockCtx {
	const cwd = mkdtempSync(path.join(tmpdir(), "fsg-"));
	gitIn(cwd, ["init", "-q"]);
	writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
	gitIn(cwd, ["add", ".gitignore"]);
	gitIn(cwd, ["commit", "-qm", "init"]);
	return { cwd, hasUI: false };
}
const plainCtx = () => ({ cwd: mkdtempSync(path.join(tmpdir(), "fsg-")), hasUI: false });
let confirmCalls = 0;
function mkUiCtx(answer: boolean): MockCtx {
	const ctx = mkGitCtx();
	ctx.hasUI = true;
	ctx.ui = {
		confirm: async () => {
			confirmCalls++;
			return answer;
		},
		notify: () => {},
	};
	ctx.setTimeout = (fn) => {
		fn();
		return 0;
	};
	return ctx;
}
const fixture = (ctx: MockCtx, name: string, lines: number) => {
	const abs = path.join(ctx.cwd, name);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, "x\n".repeat(lines));
};

async function call(ctx: MockCtx, event: MockEvent): Promise<Blocked | undefined> {
	// Hook contract: tool_call returns {block, reason} | undefined.
	return (await handlers.tool_call[0](event, ctx)) as Blocked | undefined;
}
const agentStart = (ctx: MockCtx) => handlers.before_agent_start[0]({}, ctx);
const sessionStart = (ctx: MockCtx) => handlers.session_start[0]({}, ctx);
async function stop(ctx: MockCtx): Promise<string> {
	// Hook contract: session_stop returns {continue, additionalContext} | undefined.
	const r = (await handlers.session_stop[0]({}, ctx)) as Continuation | undefined;
	assert.ok(r === undefined || r.continue === true, "stop continuation shape");
	return r?.additionalContext ?? "";
}
interface Marker {
	decision?: string;
}
function markerOf(ctx: MockCtx): Marker | null {
	try {
		return JSON.parse(readFileSync(path.join(ctx.cwd, ".omp/file-size-guard-onboarded.json"), "utf8")) as Marker;
	} catch {
		return null;
	}
}
function exemptionsOf(ctx: MockCtx): Record<string, Record<string, string>> | null {
	try {
		return JSON.parse(readFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), "utf8")) as Record<
			string,
			Record<string, string>
		>;
	} catch {
		return null;
	}
}

let passed = 0;
function check(name: string, cond: boolean) {
	assert.ok(cond, name);
	passed++;
	console.log(`PASS ${name}`);
}

// 1. No git repo -> guard fully inactive (no pre-block, no scan)
{
	const ctx = plainCtx();
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(400) } });
	check("no-git-no-block", r === undefined);
	await agentStart(ctx);
	fixture(ctx, "big.ts", 400);
	check("no-git-no-report", (await stop(ctx)) === "");
}

// 2. git init mid-session: cached negative from case-style probing is refreshed at run start
{
	const ctx = plainCtx();
	const before = await call(ctx, { toolName: "write", input: { path: "x.ts", content: "x\n".repeat(400) } });
	check("pre-init-inactive", before === undefined);
	gitIn(ctx.cwd, ["init", "-q"]);
	await agentStart(ctx);
	const after = await call(ctx, { toolName: "write", input: { path: "x.ts", content: "x\n".repeat(400) } });
	check("post-init-active", after?.block === true);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 3. Git repo -> pre-execution block still works
{
	const ctx = mkGitCtx();
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(400) } });
	check("git-block-350-write", r?.block === true && (r.reason ?? "").includes("BLOCKED"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 4. New 200-line file during the turn -> WARNING at stop; repeats while unfixed; quiet after fix
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	const report = await stop(ctx);
	check("stop-warn-150", report.includes("WARNING") && report.includes("a.ts") && report.includes("150"));
	await agentStart(ctx); // continuation run (consumes the flag)
	check("stop-repeats-unfixed", (await stop(ctx)).includes("a.ts"));
	await agentStart(ctx); // continuation run (consumes the flag)
	fixture(ctx, "a.ts", 100); // agent "fixes" it
	check("stop-quiet-after-fix", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 4b. Continuation runs keep the original baseline (mirrors runtime order:
// flagged stop -> before_agent_start -> next stop). A still-big file must be
// re-flagged in the continuation, not absorbed as "pre-existing dirty".
{
	const ctx = mkGitCtx();
	await agentStart(ctx); // user prompt run
	fixture(ctx, "k.ts", 200);
	check("cont-flag-first", (await stop(ctx)).includes("k.ts"));
	await agentStart(ctx); // continuation run: flag consumed, baseline kept
	check("cont-keeps-baseline", (await stop(ctx)).includes("k.ts"));
	await agentStart(ctx); // continuation run 2
	fixture(ctx, "k.ts", 100); // fixed during the continuation
	check("cont-quiet-after-fix", (await stop(ctx)) === "");
	fixture(ctx, "j.ts", 200); // appears between prompts (user's own edit)
	await agentStart(ctx); // new user prompt -> fresh baseline includes j.ts
	check("fresh-baseline-next-prompt", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 5. New 300-line file -> STRICT WARNING; 400-line via "bash" (untracked) -> ERROR
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	fixture(ctx, "s.ts", 300);
	fixture(ctx, "d.ts", 400); // simulates a bash/eval-created file: git sees it untracked
	const report = await stop(ctx);
	check("stop-strict-250", report.includes("STRICT WARNING") && report.includes("s.ts") && report.includes("250"));
	check("stop-error-350", report.includes("ERROR") && report.includes("d.ts") && report.includes("350"));
	await agentStart(ctx); // consume continuation flag
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 6. Tracked file modified during the turn is flagged
{
	const ctx = mkGitCtx();
	fixture(ctx, "t.ts", 100);
	gitIn(ctx.cwd, ["add", "t.ts"]);
	gitIn(ctx.cwd, ["commit", "-qm", "add t"]);
	await agentStart(ctx);
	fixture(ctx, "t.ts", 200);
	check("tracked-modified-flagged", (await stop(ctx)).includes("t.ts"));
	await agentStart(ctx); // consume continuation flag
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 7. File dirty BEFORE the turn and untouched -> not flagged; touched -> flagged
{
	const ctx = mkGitCtx();
	fixture(ctx, "pre.ts", 200); // dirty before the turn starts
	await agentStart(ctx);
	check("preexisting-dirty-skipped", (await stop(ctx)) === "");
	await agentStart(ctx);
	fixture(ctx, "pre.ts", 210); // agent touches it this turn
	check("preexisting-dirty-touched-flagged", (await stop(ctx)).includes("pre.ts"));
	await agentStart(ctx); // consume continuation flag
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 8. Per-file + extension exemptions suppress the report
{
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(
		path.join(ctx.cwd, ".omp/file-size-exemptions.json"),
		JSON.stringify({ files: { "a.ts": "single-piece dataset" }, extensions: { ".snap": "snapshots stay whole" } }),
	);
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	fixture(ctx, "b.snap", 300);
	check("exemptions-suppress", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 9. Malformed exemptions JSON -> no throw, flagged again
{
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), "{bad");
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	check("malformed-json-flagged", (await stop(ctx)).includes("a.ts"));
	await agentStart(ctx); // consume continuation flag
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 10. Gitignored paths (node_modules) and binaries are ignored
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	fixture(ctx, "node_modules/pkg/big.js", 400);
	writeFileSync(path.join(ctx.cwd, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	check("ignored-and-binary-skipped", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 11. Deleted file -> no crash, not flagged
{
	const ctx = mkGitCtx();
	fixture(ctx, "gone.ts", 200);
	gitIn(ctx.cwd, ["add", "gone.ts"]);
	gitIn(ctx.cwd, ["commit", "-qm", "add gone"]);
	await agentStart(ctx);
	rmSync(path.join(ctx.cwd, "gone.ts"));
	check("deleted-file-skipped", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 12. Edit estimates: small edit passes, replace_all blow-up is blocked
{
	const ctx = mkGitCtx();
	fixture(ctx, "c.ts", 340);
	const small = await call(ctx, { toolName: "edit", input: { path: "c.ts", old_string: "x", new_string: "y" } });
	check("no-block-small-edit", small === undefined);
	const big = await call(ctx, {
		toolName: "edit",
		input: { path: "c.ts", old_string: "x", new_string: "x\nx", replace_all: true },
	});
	check("block-replace-all-edit", big?.block === true && (big.reason ?? "").includes("350"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 13. Clean turn (no changes) -> nothing reported
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	check("clean-turn-quiet", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 14. Onboarding, clean project -> marker "clean", no dialog, no prompt
{
	confirmCalls = 0;
	sentPrompts.length = 0;
	const ctx = mkUiCtx(true);
	await sessionStart(ctx);
	check("onboard-clean-no-dialog", confirmCalls === 0 && sentPrompts.length === 0);
	check("onboard-clean-marker", markerOf(ctx)?.decision === "clean");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 15. Onboarding, decline -> all flagged files bulk-exempted; runs exactly once
{
	confirmCalls = 0;
	sentPrompts.length = 0;
	const ctx = mkUiCtx(false);
	fixture(ctx, "a.ts", 200);
	fixture(ctx, "s.ts", 300);
	await sessionStart(ctx);
	check("onboard-decline-dialog-once", confirmCalls === 1 && sentPrompts.length === 0);
	check("onboard-decline-marker", markerOf(ctx)?.decision === "exempted");
	const ex = exemptionsOf(ctx);
	check(
		"onboard-decline-exemptions",
		(ex?.files["a.ts"] ?? "").includes("declined onboarding fixes") &&
			(ex?.files["s.ts"] ?? "").includes("declined onboarding fixes"),
	);
	await sessionStart(ctx); // second session: marker no-op
	check("onboard-runs-once", confirmCalls === 1);
	// and the exempted files are indeed never flagged by the stop scan
	await agentStart(ctx);
	fixture(ctx, "a.ts", 210);
	check("onboard-declined-never-flagged", (await stop(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 16. Onboarding, accept -> fix prompt sent with the file list; no bulk exemption
{
	confirmCalls = 0;
	sentPrompts.length = 0;
	const ctx = mkUiCtx(true);
	fixture(ctx, "big.ts", 400);
	await sessionStart(ctx);
	check("onboard-accept-marker", markerOf(ctx)?.decision === "fix");
	check(
		"onboard-accept-prompt",
		sentPrompts.length === 1 && sentPrompts[0].includes("big.ts") && sentPrompts[0].includes("400 lines"),
	);
	check("onboard-accept-no-exemptions", exemptionsOf(ctx) === null);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 17. Onboarding skipped headless -> no marker, no prompt, no dialog
{
	sentPrompts.length = 0;
	const ctx = mkGitCtx(); // hasUI false
	fixture(ctx, "big.ts", 400);
	await sessionStart(ctx);
	check("onboard-headless-skipped", markerOf(ctx) === null && sentPrompts.length === 0);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 18. Onboarding respects existing exemptions -> exempted file not flagged
{
	confirmCalls = 0;
	const ctx = mkUiCtx(false);
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), JSON.stringify({ files: { "a.ts": "dataset" } }));
	fixture(ctx, "a.ts", 200);
	await sessionStart(ctx);
	check("onboard-respects-exemptions", confirmCalls === 0 && markerOf(ctx)?.decision === "clean");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 19. Onboarding decline with malformed existing exemptions -> fresh valid file, no throw
{
	const ctx = mkUiCtx(false);
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), "{bad");
	fixture(ctx, "a.ts", 200);
	await sessionStart(ctx);
	check("onboard-decline-malformed", (exemptionsOf(ctx)?.files["a.ts"] ?? "").includes("declined onboarding fixes"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 20. Dialog fails/times out -> postponed: NO bulk exemption, NO marker (never exempts by accident)
{
	const ctx = mkGitCtx();
	ctx.hasUI = true;
	ctx.ui = {
		confirm: async () => {
			throw new Error("handler timed out");
		},
		notify: () => {},
	};
	ctx.setTimeout = (fn) => {
		fn();
		return 0;
	};
	fixture(ctx, "a.ts", 200);
	await sessionStart(ctx);
	// the deferred async body settles on a microtask — drain it
	await new Promise((r) => setImmediate(r));
	check("onboard-failure-no-exemptions", exemptionsOf(ctx) === null);
	check("onboard-failure-no-marker", markerOf(ctx) === null);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// N. Custom limits: .omp/file-size-guard.json overrides per-project thresholds
{
	// custom error limit blocks a write the defaults would allow
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-guard.json"), '{"warn": 50, "strict": 75, "error": 100}');
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(150) } });
	check("config-custom-error-blocks", r?.block === true && (r.reason ?? "").includes("hard limit 100"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}
{
	// custom warn limit flags a file the defaults would ignore
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-guard.json"), '{"warn": 100}');
	await agentStart(ctx);
	fixture(ctx, "a.ts", 120);
	check("config-custom-warn-flags", (await stop(ctx)).includes("soft limit 100"));
	await agentStart(ctx); // consume the continuation flag for the next case
	rmSync(ctx.cwd, { recursive: true, force: true });
}
{
	// invalid ordering (warn > default strict) falls back to defaults entirely
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-guard.json"), '{"warn": 500}');
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	check("config-invalid-falls-back", (await stop(ctx)).includes("soft limit 150"));
	await agentStart(ctx); // consume the continuation flag for the next case
	rmSync(ctx.cwd, { recursive: true, force: true });
}
{
	// partial config merges: raised error limit unblocks, other tiers stay default
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-guard.json"), '{"error": 500}');
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(400) } });
	check("config-raised-error-unblocks", r === undefined);
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	check("config-partial-keeps-defaults", (await stop(ctx)).includes("soft limit 150"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed`);
