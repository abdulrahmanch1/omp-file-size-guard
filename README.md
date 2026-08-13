# omp-file-size-guard

An [Oh My Pi (omp)](https://github.com/badlogic/oh-my-pi) extension that stops the AI agent from creating oversized files without justification. Any file the agent makes or changes — through `write`, `edit`, `ast_edit`, `bash`, `eval`, or task subagents — is checked against three line-count tiers, using git as the source of truth for what changed.

## Behavior

| Lines | Result |
|---|---|
| > 150 | `WARNING` — review the file: split it, shrink it, extract repeated literals into constants, or justify it |
| > 250 | `STRICT WARNING` — same mechanism, stronger wording |
| > 350 | **Blocked before it happens** for `write`/`edit` (the tool call is rejected with instructions). For changes made any other way, an `ERROR` report is delivered the moment the run settles and the agent must fix it immediately |

Warnings repeat on every run while a file stays over the limit.

## Requirements

- omp (extension auto-discovery; tested on v17.3)
- The project must be a **git repository** — outside one, the guard is completely inactive by design
- `git` on `PATH`

## Install

User level (guards every project, every session):

```bash
mkdir -p ~/.omp/agent/extensions
curl -o ~/.omp/agent/extensions/file-size-guard.ts \
  https://raw.githubusercontent.com/abdulrahmanch1/omp-file-size-guard/main/file-size-guard.ts
```

Or project level (only this repository): copy `file-size-guard.ts` into `<project>/.omp/extensions/`.

No configuration entry is needed — omp auto-discovers `extensions/` directories at startup. The guard activates on the next session.

## How it works

1. **Pre-execution block (`tool_call`)** — for `write`/`edit`, the resulting content is computed (including `replace_all` edits) and the call is blocked if it would exceed 350 lines, unless exempted.
2. **End-of-run scan (`session_stop`)** — when the agent finishes a prompt, the guard diffs the working tree against a baseline snapshot taken when the run started (`git diff HEAD` + `git ls-files --others`). Every file that appeared or changed during the run is line-counted (streamed, memory-bounded, binary-safe) and over-limit files are handed back to the agent immediately as a continuation, so it fixes or exempts them within the same prompt. Core caps consecutive continuations at 8.
3. Files dirty *before* the run are only flagged if the agent touched them. `.gitignore`d paths (`node_modules/`, build output, …) are excluded natively by git. The exemption file itself is re-read on every check.

## Exemptions — per project

Each project keeps its **own** exemption file at `<project>/.omp/file-size-exemptions.json`. Exempted files are never flagged again:

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

## License

MIT — see [LICENSE](LICENSE).
