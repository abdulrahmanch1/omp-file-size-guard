import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import fileSizeGuard from "../adapters/pi/file-size-guard.ts";

interface MockCtx {
	cwd: string;
	hasUI: boolean;
	ui?: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (msg: string, kind?: string) => void;
	};
}
interface MockEvent {
	toolName: string;
	input: Record<string, unknown>;
}
interface Blocked {
	block: boolean;
	reason?: string;
}
interface Injected {
	message: { customType: string; content: string; display: boolean };
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
for (const e of ["tool_call", "before_agent_start", "agent_end", "session_start"]) {
	assert.equal(handlers[e]?.length, 1, `handler registered: ${e}`);
}

const gitIn = (cwd: string, args: string[]) =>
	spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

function mkGitCtx(): MockCtx {
	const cwd = mkdtempSync(path.join(tmpdir(), "fsg-pi-"));
	gitIn(cwd, ["init", "-q"]);
	writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
	gitIn(cwd, ["add", ".gitignore"]);
	gitIn(cwd, ["commit", "-qm", "init"]);
	return { cwd, hasUI: false };
}
const plainCtx = () => ({ cwd: mkdtempSync(path.join(tmpdir(), "fsg-pi-")), hasUI: false });
let confirmCalls = 0;
function mkUiCtx(answer: boolean | "throw"): MockCtx {
	const ctx = mkGitCtx();
	ctx.hasUI = true;
	ctx.ui = {
		confirm: async () => {
			confirmCalls++;
			if (answer === "throw") throw new Error("dialog failed");
			return answer;
		},
		notify: () => {},
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
async function agentStart(ctx: MockCtx): Promise<string> {
	// pi contract: before_agent_start returns {message: {content: string}} | undefined.
	const r = (await handlers.before_agent_start[0]({}, ctx)) as Injected | undefined;
	return r?.message.content ?? "";
}
const agentEnd = (ctx: MockCtx) => handlers.agent_end[0]({}, ctx);
const sessionStart = (ctx: MockCtx) => handlers.session_start[0]({}, ctx);
// Onboarding runs on a real 300ms plain timer (pi has no managed timers);
// the wait is part of the implementation under test, not a guessed race.
const waitOnboarding = () => new Promise((r) => setTimeout(r, 450));

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

// 1. No git repo -> fully inactive
{
	const ctx = plainCtx();
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(400) } });
	check("no-git-no-block", r === undefined);
	await agentStart(ctx);
	fixture(ctx, "big.ts", 400);
	await agentEnd(ctx);
	check("no-git-no-report", (await agentStart(ctx)) === "");
}

// 2. Pre-execution block in git repo
{
	const ctx = mkGitCtx();
	const r = await call(ctx, { toolName: "write", input: { path: "big.ts", content: "x\n".repeat(400) } });
	check("git-block-350-write", r?.block === true && (r.reason ?? "").includes("BLOCKED"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 3. 200-line file -> WARNING delivered at the NEXT run start; exactly once
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	await agentEnd(ctx);
	const report = await agentStart(ctx);
	check("warn-150-next-run", report.includes("WARNING") && report.includes("a.ts") && report.includes("150"));
	check("report-delivered-once", (await agentStart(ctx)) === "");
	// not re-stashed: a.ts is now pre-existing for the fresh baseline
	await agentEnd(ctx);
	check("no-restash-untouched", (await agentStart(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 4. 300-line STRICT + 400-line ERROR (untracked, as bash would create)
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	fixture(ctx, "s.ts", 300);
	fixture(ctx, "d.ts", 400);
	await agentEnd(ctx);
	const report = await agentStart(ctx);
	check("strict-250", report.includes("STRICT WARNING") && report.includes("s.ts") && report.includes("250"));
	check("error-350", report.includes("ERROR") && report.includes("d.ts") && report.includes("350"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 5. Tracked file modified during the run
{
	const ctx = mkGitCtx();
	fixture(ctx, "t.ts", 100);
	gitIn(ctx.cwd, ["add", "t.ts"]);
	gitIn(ctx.cwd, ["commit", "-qm", "add t"]);
	await agentStart(ctx);
	fixture(ctx, "t.ts", 200);
	await agentEnd(ctx);
	check("tracked-modified-flagged", (await agentStart(ctx)).includes("t.ts"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 6. Pre-existing dirty: untouched -> quiet; touched -> flagged
{
	const ctx = mkGitCtx();
	fixture(ctx, "pre.ts", 200);
	await agentStart(ctx);
	fixture(ctx, "unrelated.ts", 10);
	await agentEnd(ctx);
	check("preexisting-dirty-skipped", (await agentStart(ctx)) === "");
	await agentEnd(ctx); // quiet run; baseline for next
	fixture(ctx, "pre.ts", 210);
	await agentEnd(ctx);
	check("preexisting-dirty-touched-flagged", (await agentStart(ctx)).includes("pre.ts"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 7. Exemptions suppress; malformed JSON re-flags
{
	const ctx = mkGitCtx();
	mkdirSync(path.join(ctx.cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), JSON.stringify({ files: { "a.ts": "dataset" } }));
	await agentStart(ctx);
	fixture(ctx, "a.ts", 200);
	await agentEnd(ctx);
	check("exempt-file-quiet", (await agentStart(ctx)) === "");
	writeFileSync(path.join(ctx.cwd, ".omp/file-size-exemptions.json"), "{bad");
	await agentStart(ctx);
	fixture(ctx, "a.ts", 210);
	await agentEnd(ctx);
	check("malformed-json-flagged", (await agentStart(ctx)).includes("a.ts"));
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 8. Gitignored + binary skipped; deleted file safe
{
	const ctx = mkGitCtx();
	fixture(ctx, "gone.ts", 200);
	gitIn(ctx.cwd, ["add", "gone.ts"]);
	gitIn(ctx.cwd, ["commit", "-qm", "add gone"]);
	await agentStart(ctx);
	fixture(ctx, "node_modules/pkg/big.js", 400);
	writeFileSync(path.join(ctx.cwd, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	rmSync(path.join(ctx.cwd, "gone.ts"));
	await agentEnd(ctx);
	check("ignored-binary-deleted-skipped", (await agentStart(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 9. Edit estimates: small passes, replace_all blow-up blocked
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

// 10. Clean run -> quiet
{
	const ctx = mkGitCtx();
	await agentStart(ctx);
	await agentEnd(ctx);
	check("clean-run-quiet", (await agentStart(ctx)) === "");
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 11. Onboarding clean project -> marker clean, no dialog
{
	confirmCalls = 0;
	sentPrompts.length = 0;
	const ctx = mkUiCtx(true);
	await sessionStart(ctx);
	await waitOnboarding();
	check("onboard-clean", confirmCalls === 0 && markerOf(ctx)?.decision === "clean" && sentPrompts.length === 0);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 12. Onboarding decline -> bulk exempt + marker; runs once
{
	confirmCalls = 0;
	sentPrompts.length = 0;
	const ctx = mkUiCtx(false);
	fixture(ctx, "a.ts", 200);
	await sessionStart(ctx);
	await waitOnboarding();
	check(
		"onboard-decline",
		confirmCalls === 1 &&
			markerOf(ctx)?.decision === "exempted" &&
			(exemptionsOf(ctx)?.files["a.ts"] ?? "").includes("declined onboarding fixes"),
	);
	await sessionStart(ctx);
	await waitOnboarding();
	check("onboard-runs-once", confirmCalls === 1);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 13. Onboarding accept -> prompt sent, marker fix, no exemptions
{
	sentPrompts.length = 0;
	const ctx = mkUiCtx(true);
	fixture(ctx, "big.ts", 400);
	await sessionStart(ctx);
	await waitOnboarding();
	check(
		"onboard-accept",
		markerOf(ctx)?.decision === "fix" && sentPrompts.length === 1 && sentPrompts[0].includes("big.ts") && exemptionsOf(ctx) === null,
	);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

// 14. Onboarding skipped headless; dialog failure postpones without marker/exemptions
{
	sentPrompts.length = 0;
	const headless = mkGitCtx();
	fixture(headless, "big.ts", 400);
	await sessionStart(headless);
	await waitOnboarding();
	check("onboard-headless-skipped", markerOf(headless) === null && sentPrompts.length === 0);
	rmSync(headless.cwd, { recursive: true, force: true });

	const ctx = mkUiCtx("throw");
	fixture(ctx, "a.ts", 200);
	await sessionStart(ctx);
	await waitOnboarding();
	check("onboard-failure-postpones", markerOf(ctx) === null && exemptionsOf(ctx) === null);
	rmSync(ctx.cwd, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed`);
