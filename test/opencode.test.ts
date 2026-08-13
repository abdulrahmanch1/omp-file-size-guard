import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSizeGuard } from "../adapters/opencode/file-size-guard.ts";

interface Injected {
	texts: string[];
}
interface HooksLike {
	"tool.execute.before": (input: unknown, output: { args: Record<string, unknown> }) => Promise<void>;
	event: (input: { event: { type: string; properties: { sessionID: string } } }) => Promise<void>;
}

// opencode runs one plugin factory per server/project; each test gets a fresh
// instance so the load-time baseline matches the scenario.
async function instance(cwd: string): Promise<{ hooks: HooksLike; injected: Injected }> {
	const injected: Injected = { texts: [] };
	const input = {
		directory: cwd,
		client: {
			session: {
				prompt: async (opts: { body: { parts: Array<{ text: string }> } }) => {
					injected.texts.push(opts.body.parts[0].text);
				},
			},
		},
	};
	// Mock boundary: PluginInput/client SDK surface is far wider than this usage.
	const hooks = (await FileSizeGuard(input as never, undefined)) as HooksLike;
	return { hooks, injected };
}

const gitIn = (cwd: string, args: string[]) =>
	spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

function mkGitDir(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "fsg-oc-"));
	gitIn(cwd, ["init", "-q"]);
	writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
	gitIn(cwd, ["add", ".gitignore"]);
	gitIn(cwd, ["commit", "-qm", "init"]);
	return cwd;
}
const fixture = (cwd: string, name: string, lines: number) => {
	const abs = path.join(cwd, name);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, "x\n".repeat(lines));
};
// Non-onboarding cases pre-seed the marker so the first idle takes the normal
// scan path instead of the onboarding branch.
const markOnboarded = (cwd: string) => {
	mkdirSync(path.join(cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(cwd, ".omp/file-size-guard-onboarded.json"), '{"version":1,"decision":"prompted"}');
};

async function before(hooks: HooksLike, tool: string, args: Record<string, unknown>): Promise<string | null> {
	try {
		await hooks["tool.execute.before"]({ tool, sessionID: "s1", callID: "c1" }, { args });
		return null; // no block
	} catch (e) {
		return e instanceof Error ? e.message : String(e); // blocked: throw is the contract
	}
}
const idle = (hooks: HooksLike) => hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
const nonIdle = (hooks: HooksLike) => hooks.event({ event: { type: "session.updated", properties: { sessionID: "s1" } } });

interface Marker {
	decision?: string;
}
function markerOf(cwd: string): Marker | null {
	try {
		return JSON.parse(readFileSync(path.join(cwd, ".omp/file-size-guard-onboarded.json"), "utf8")) as Marker;
	} catch {
		return null;
	}
}
function exemptionsOf(cwd: string): Record<string, Record<string, string>> | null {
	try {
		return JSON.parse(readFileSync(path.join(cwd, ".omp/file-size-exemptions.json"), "utf8")) as Record<
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
	const cwd = mkdtempSync(path.join(tmpdir(), "fsg-oc-"));
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	const blocked = await before(hooks, "write", { filePath: "big.ts", content: "x\n".repeat(400) });
	check("no-git-no-block", blocked === null);
	fixture(cwd, "big.ts", 400);
	await idle(hooks);
	check("no-git-no-inject", injected.texts.length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

// 2. Pre-execution block (>350 write) via thrown error
{
	const cwd = mkGitDir();
	const { hooks } = await instance(cwd);
	markOnboarded(cwd);
	const blocked = await before(hooks, "write", { filePath: "big.ts", content: "x\n".repeat(400) });
	check("git-block-350-write", blocked !== null && blocked.includes("BLOCKED") && blocked.includes("350"));
	rmSync(cwd, { recursive: true, force: true });
}

// 3. 200-line file in window -> WARNING injected at idle; next window quiet if untouched
{
	const cwd = mkGitDir();
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "a.ts", 200);
	await idle(hooks);
	check(
		"warn-150-injected",
		injected.texts.length === 1 && injected.texts[0].includes("WARNING") && injected.texts[0].includes("a.ts"),
	);
	await idle(hooks);
	check("next-window-quiet", injected.texts.length === 1);
	fixture(cwd, "a.ts", 210); // touched again -> flagged again
	await idle(hooks);
	check("touched-reflagged", injected.texts.length === 2);
	rmSync(cwd, { recursive: true, force: true });
}

// 4. STRICT 300 + ERROR 400 (untracked)
{
	const cwd = mkGitDir();
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "s.ts", 300);
	fixture(cwd, "d.ts", 400);
	await idle(hooks);
	const text = injected.texts.join("\n");
	check("strict-250", text.includes("STRICT WARNING") && text.includes("s.ts") && text.includes("250"));
	check("error-350", text.includes("ERROR") && text.includes("d.ts") && text.includes("350"));
	rmSync(cwd, { recursive: true, force: true });
}

// 5. Tracked file modified in window
{
	const cwd = mkGitDir();
	fixture(cwd, "t.ts", 100);
	gitIn(cwd, ["add", "t.ts"]);
	gitIn(cwd, ["commit", "-qm", "add t"]);
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "t.ts", 200);
	await idle(hooks);
	check("tracked-modified-flagged", injected.texts.join("\n").includes("t.ts"));
	rmSync(cwd, { recursive: true, force: true });
}

// 6. Pre-existing dirty at plugin load: untouched -> quiet; touched -> flagged
{
	const cwd = mkGitDir();
	fixture(cwd, "pre.ts", 200); // dirty before the plugin (and its baseline) loads
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	await idle(hooks);
	check("preexisting-dirty-skipped", injected.texts.length === 0);
	fixture(cwd, "pre.ts", 210);
	await idle(hooks);
	check("preexisting-dirty-touched-flagged", injected.texts.join("\n").includes("pre.ts"));
	rmSync(cwd, { recursive: true, force: true });
}

// 7. Exemptions suppress; malformed JSON re-flags
{
	const cwd = mkGitDir();
	mkdirSync(path.join(cwd, ".omp"), { recursive: true });
	writeFileSync(path.join(cwd, ".omp/file-size-exemptions.json"), JSON.stringify({ files: { "a.ts": "dataset" } }));
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "a.ts", 200);
	await idle(hooks);
	check("exempt-file-quiet", injected.texts.length === 0);
	writeFileSync(path.join(cwd, ".omp/file-size-exemptions.json"), "{bad");
	fixture(cwd, "a.ts", 210);
	await idle(hooks);
	check("malformed-json-flagged", injected.texts.join("\n").includes("a.ts"));
	rmSync(cwd, { recursive: true, force: true });
}

// 8. Gitignored + binary + deleted skipped; non-idle events ignored
{
	const cwd = mkGitDir();
	fixture(cwd, "gone.ts", 200);
	gitIn(cwd, ["add", "gone.ts"]);
	gitIn(cwd, ["commit", "-qm", "add gone"]);
	const { hooks, injected } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "node_modules/pkg/big.js", 400);
	writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	rmSync(path.join(cwd, "gone.ts"));
	await nonIdle(hooks);
	await idle(hooks);
	check("ignored-binary-deleted-skipped", injected.texts.length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

// 9. Edit estimates: small passes, replace-all blow-up blocked
{
	const cwd = mkGitDir();
	const { hooks } = await instance(cwd);
	markOnboarded(cwd);
	fixture(cwd, "c.ts", 340);
	check("no-block-small-edit", (await before(hooks, "edit", { filePath: "c.ts", oldString: "x", newString: "y" })) === null);
	const blocked = await before(hooks, "edit", { filePath: "c.ts", oldString: "x", newString: "x\nx", replaceAll: true });
	check("block-replace-all-edit", blocked !== null && blocked.includes("350"));
	rmSync(cwd, { recursive: true, force: true });
}

// 10. Onboarding: first idle prompts the agent to settle the decision; marker written
{
	const cwd = mkGitDir();
	const { hooks, injected } = await instance(cwd);
	fixture(cwd, "old.ts", 200);
	await idle(hooks);
	check("onboard-marker", markerOf(cwd)?.decision === "prompted");
	check(
		"onboard-prompt-injected",
		injected.texts.length === 1 && injected.texts[0].includes("old.ts") && injected.texts[0].includes("Ask the user"),
	);
	await idle(hooks); // marker exists now -> normal quiet path (baseline was reset)
	check("onboard-runs-once", injected.texts.length === 1);
	rmSync(cwd, { recursive: true, force: true });
}

// 11. Onboarding clean project -> marker clean, nothing injected
{
	const cwd = mkGitDir();
	const { hooks, injected } = await instance(cwd);
	await idle(hooks);
	check("onboard-clean", markerOf(cwd)?.decision === "clean" && injected.texts.length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed`);
