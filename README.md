# file-size-guard

A cross-host guard that stops oversized files from being created without justification — by AI agents **and** by humans. One shared core (`core/guard.ts`) powers:

- **Agent extensions** for **omp**, **pi**, and **opencode** — any file the agent makes or changes (file tools, shell commands, subagents) is checked against three line-count tiers, using git as the source of truth for what changed
- **The `file-size-guard` CLI** — the same check for pre-commit hooks and CI, so the whole team follows one policy

## Behavior

| Lines | Result |
|---|---|
| > 150 | `WARNING` — review the file: split it, shrink it, extract repeated literals into constants, or justify it |
| > 250 | `STRICT WARNING` — same mechanism, stronger wording |
| > 350 | **Blocked before it happens** where the host supports pre-tool interception (the call is rejected with instructions). Otherwise an `ERROR` report is delivered the moment the run settles and the agent must fix it immediately |

Warnings repeat on every run while a file stays over the limit.

## Requirements

- The project must be a **git repository** — outside one, the guard is completely inactive by design
- `git` on `PATH`
- Node.js ≥ 18 for the CLI

## Install

### Oh My Pi (omp)

Plugin package (recommended — managed, upgradeable). Requires `bun` on `PATH` (`curl -fsSL https://bun.sh/install | bash`); without it, use the single-file fallback below:

```bash
omp plugin install https://github.com/abdulrahmanch1/omp-file-size-guard
# or from a local clone:
omp plugin install ./omp-file-size-guard
```

Manage with `omp plugin list` / `omp plugin uninstall omp-file-size-guard` / `omp plugin doctor`.

Manual single-file fallback — guards every project; omp auto-discovers at startup:

```bash
mkdir -p ~/.omp/agent/extensions
curl -o ~/.omp/agent/extensions/file-size-guard.js \
  https://raw.githubusercontent.com/abdulrahmanch1/omp-file-size-guard/main/dist/omp/file-size-guard.js
```

### pi

Package install (the full tree keeps `core/` resolvable):

```bash
pi install https://github.com/abdulrahmanch1/omp-file-size-guard
```

Manual single-file fallback:

```bash
mkdir -p ~/.pi/agent/extensions
curl -o ~/.pi/agent/extensions/file-size-guard.cjs \
  https://raw.githubusercontent.com/abdulrahmanch1/omp-file-size-guard/main/dist/pi/file-size-guard.cjs
```

### opencode

Copy the bundle into the global plugin directory:

```bash
mkdir -p ~/.config/opencode/plugin
curl -o ~/.config/opencode/plugin/file-size-guard.js \
  https://raw.githubusercontent.com/abdulrahmanch1/omp-file-size-guard/main/dist/opencode/file-size-guard.js
```

## CLI — same policy for humans and CI

`file-size-guard check` scans **every authored file** in the repository (tracked + untracked, `.gitignore` respected, exemptions applied) and exits non-zero when files are over the limits:

```bash
# no install needed — npx runs it straight from npm:
npx --yes omp-file-size-guard check                  # scan current repo; exit 1 if anything is over 150 lines
npx --yes omp-file-size-guard check --fail-on=error  # fail only on the 350-line hard limit
# or globally: npm i -g omp-file-size-guard && file-size-guard check
```

Exit codes: `0` clean · `1` violations at or above `--fail-on` · `2` not a git repository.

Pre-commit hook (`.git/hooks/pre-commit`):

```bash
#!/bin/sh
exec file-size-guard check
```

GitHub Action:

```yaml
- name: File size guard
  run: npx --yes omp-file-size-guard check --fail-on=strict
```

## How it works

1. **Pre-execution block** — for `write`/`edit`, the resulting content is computed (including `replace_all` edits) and the call is blocked if it would exceed 350 lines, unless exempted.
2. **End-of-run scan** — the guard diffs the working tree against a baseline snapshot (`git diff HEAD` + `git ls-files --others`). Every file that appeared or changed during the run is line-counted (streamed, memory-bounded, binary-safe) and over-limit files are handed back to the agent:
   - omp: as an immediate continuation within the same prompt (core caps consecutive continuations at 8)
   - pi: stashed at `agent_end` and delivered as the next prompt's injected message
   - opencode: injected as a user prompt into the session at `session.idle`, which starts the fix run on its own
3. Files dirty *before* the run are only flagged if the agent touched them. `.gitignore`d paths (`node_modules/`, build output, …) are excluded natively by git. The exemption file is re-read on every check.

The CLI runs the same full-tree scan used by agent onboarding.

## First run in a project (onboarding)

The first time an agent session runs in a git repository, the guard scans **every** authored file (tracked + untracked, `.gitignore` respected) for pre-existing violations:

- **omp** — shows an interactive dialog with per-tier counts. **Yes**: the agent starts fixing each file immediately (the end-of-run scan supervises the work). **No**: every flagged file is added to the exemptions file and never flagged again. Headless sessions are skipped; a dialog that fails or times out postpones onboarding.
- **pi** — a deferred headless-safe confirm dialog offers the same two choices, delivered via `sendUserMessage`.
- **opencode** — no plugin UI exists, so the result is injected as a prompt and the agent settles the choice with you (fix now vs bulk-exempt).

Onboarding runs **exactly once per project**, recorded in `.omp/file-size-guard-onboarded.json`; a clean project writes the marker silently. It never bulk-exempts without an affirmative choice. Delete the marker file to re-run onboarding.

## Exemptions — per project

Each project keeps its **own** exemption file at `<project>/.omp/file-size-exemptions.json`. Exempted files are never flagged again — by the agents, the CLI, or CI:

```json
{
  "files": {
    "src/data/word-list.ts": "Static dataset; splitting would force dynamic imports and hurt readability."
  },
  "extensions": {
    ".snap": "Snapshot files must stay single-piece to match test output atomically."
  }
}
```

- `files` keys: repo-root-relative paths (`/` separators), exact filename including extension
- `extensions` keys: extensions including the dot — exempts every file of that type
- Either key may be omitted; a missing or malformed file simply means no exemptions

## Limitations (by design)

- Only active inside git repositories.
- A run aborted by the user (Esc) skips its scan; its changes count as pre-existing for the next prompt.
- Files outside the repository are not scanned.

## Repository layout

- `core/guard.ts` — all host-agnostic logic: line counting, git diffing, tiering, exemptions, onboarding scans, report formatting
- `adapters/omp/` — Oh My Pi adapter (extension events: `tool_call`, `session_stop`, `before_agent_start`, `agent_end`)
- `adapters/pi/` — pi adapter (extension events: `tool_call`, `before_agent_start`, `agent_end`, `session_start`)
- `adapters/opencode/` — opencode adapter (plugin hooks: `tool.execute.before`, `event`/`session.idle`)
- `bin/fsg.ts` — the `file-size-guard` CLI entry point
- `build.mjs` — esbuild script producing the standalone bundles in `dist/` (`npm run build`)

## Development

```bash
npm install
npm run build   # esbuild -> dist/omp + dist/pi + dist/opencode + dist/bin
```

## License

MIT — see [LICENSE](LICENSE).
