---
name: codex-delegation
description: Delegate coding work non-interactively to the Codex CLI with `codex exec`. Covers -C/--cd, -s/--sandbox, --json, -o, --output-schema, the real approval-policy differences (why -a is interactive-only), plus quota, timeout and rollback guidance.
version: 1.0.0
author: Agent Skills Toolkit contributors
license: MIT
platforms: [macos, linux, windows]
metadata:
  tags: [codex, delegation, cli, sandbox, automation, codex-exec]
---

# Codex delegation — `codex exec`

`codex exec` is the **non-interactive** entry point: give it a task description, it reads code, edits
files and runs commands inside the directory you name, then prints a conclusion. Calling it from your
agent's shell tool gives you "a second model plus a sandbox" as a coding double.

## When to use it (and when not)

**Use Codex** when:

- The change is a broad mechanical refactor (rename across 10+ files, API migration, type backfill) and
  it can iterate in its own sandbox.
- You want a second opinion: same task implemented or reviewed by another model, then compared.
- The boundary is clear and verifiable by command (`npm test`, `tsc --noEmit`, `pytest`) — safe unattended.
- Your own agent context is nearly full, or the current model is weak at long tool chains.

**Do not use it** for:

- One or two small edits (faster to do directly, and delegation adds variance).
- Work that needs your private agent context (MCP tools, skills, account state).
- Operations that require logging into third-party accounts — the sandbox is restricted and it must not
  hold your credentials.
- When your Codex quota is exhausted (a `429` means wait, not retry).

## 1. Preflight

```bash
codex --version                    # e.g. codex-cli 0.160.0
codex login status                 # account/quota state
codex doctor                       # endpoint reachability, disk, optional warnings
```

If `codex exec` fails immediately with `429`, the quota is not back: switch to your own implementation
or another provider instead of retrying in a loop.

## 2. Core usage (verified flags)

```bash
# read-only analysis: it may read code and answer, must not touch files
codex exec --cd <REPO_DIR> --sandbox read-only "Analyse the auth flow in src/ and list 3 risks; do not change code"

# allow writes inside the workspace (recommended default for real work)
codex exec --cd <REPO_DIR> --sandbox workspace-write "Replace every fetch under src/api with request() from src/lib/http.ts, keep behaviour identical, then run npm test"

# machine-readable: JSONL event stream + last message written to a file
codex exec --cd <REPO_DIR> --sandbox workspace-write --json -o /tmp/codex-last.txt "Implement X and run the tests"

# structured final answer (JSON Schema constrained)
codex exec --cd <REPO_DIR> --sandbox read-only --output-schema /tmp/schema.json "Emit the review verdict per schema"

# outside a git repository
codex exec --skip-git-repo-check --cd /tmp/scratch "Generate a README"

# continue / fork an existing session
codex exec resume --last "Keep going and finish the tests"
```

Key flags (`codex exec --help`):

| flag | effect |
|---|---|
| `-C, --cd <DIR>` | working root (it can only modify files there) |
| `-s, --sandbox <mode>` | `read-only` / `workspace-write` / `danger-full-access` |
| `-m, --model <model>` | override the model |
| `-c key=value` | override config (e.g. `-c approval_policy=never`) |
| `--json` | JSONL event stream on stdout, script-friendly |
| `-o, --output-last-message <file>` | write the final message to a file |
| `--output-schema <file>` | constrain the final answer to a JSON shape |
| `--ephemeral` | do not persist a session (one-shot tasks) |
| `--add-dir <DIR>` | extra writable dir (only meaningful with workspace-write) |
| `--skip-git-repo-check` | run outside a git repo |
| `--approve-for-me` | approval requests go through automatic review (with workspace-write) |
| `--dangerously-bypass-approvals-and-sandbox` | **do not use by default**, only in already-isolated environments |

### Approval policy gotcha

`-a/--ask-for-approval` (`on-request` / `never`) belongs to the **interactive** `codex` command;
`codex exec` rejects it:

```
$ codex exec -a never "hi"
error: unexpected argument '-a' found
```

For non-interactive runs control capability with `-s/--sandbox`, and when a model should ask for
approval autonomously use `--approve-for-me`. Equivalent to the interactive policy for automation:
`--sandbox workspace-write` + `-c approval_policy=never`.

## 3. Standard delegation pattern

1. **Recon yourself first**: read the key files, confirm the repo is clean (`git status --short`), and
   put the current state into the task description.
2. **Hard-code the boundary**: allowed dirs, forbidden dirs, the exact verification commands, and how to
   roll back on failure.
3. **Probe with read-only** (optional): let it propose a plan, review it, then run with `workspace-write`.
4. **Execute**: run `codex exec` from your shell tool and keep stdout/stderr verbatim.
5. **Verify yourself**: `git diff --stat` plus re-running the acceptance commands — never trust
   "tests passed" in the agent's own summary.
6. **Record**: changed files, verification commands and results, remaining risks.

Task template:

```text
In <REPO_DIR> complete <goal>.
Allowed to modify: <whitelist>
Do not modify: <blacklist, e.g. migrations/, .env, lockfiles unless required>
Verification commands: <cmd1>; <cmd2>
Constraints: no new dependencies; keep the public API compatible; justify every change.
When done output: files changed, actual verification output, remaining risks.
```

## 4. Verification

```bash
codex --version
codex exec --cd <REPO_DIR> --sandbox read-only "Reply OK only; do not modify any file"   # connectivity probe
git -C <REPO_DIR> status --short && git -C <REPO_DIR> diff --stat                       # always after delegation
```

## 5. Pitfalls and rollback

- **429 quota exhausted**: switch provider/model or wait; do not treat it as a task failure and re-run
  in a loop.
- **Sandbox too tight** (cannot read external deps): add `--add-dir` or use `workspace-write`; do not jump
  to `danger-full-access` or bypass flags.
- **Claims tests ran but they did not**: re-run the acceptance commands yourself; trust only real output.
- **Session bleed**: use `--ephemeral` for one-shot tasks so later `resume` is not polluted.
- **Timeout**: `codex exec` has no built-in timeout flag. Wrap it, e.g.
  `python3 -c 'import subprocess,sys;sys.exit(subprocess.run(sys.argv[1:],timeout=900).returncode)' codex exec …`,
  and on timeout continue with `codex exec resume --last "continue"` rather than restarting from scratch.
- **Rollback**: `git -C <REPO_DIR> checkout -- .` after confirming there is no local work to keep, or
  revert precisely from `git diff`. Only ever delegate write-mode work inside a git repo.
