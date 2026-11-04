---
name: bmad-method
description: A lean BMad Method adaptation. Maps the Clarify → Plan → Build → Learn delivery loop onto any agent/subagent setup and spec-driven development, ships five ready-to-paste persona prompts (analyst, PM, architect, dev, QA), and gives the real `npx bmad-method install` usage with its artifact paths.
version: 1.0.0
author: Agent Skills Toolkit contributors
license: MIT
platforms: [macos, linux, windows]
metadata:
  tags: [agile, delivery-loop, personas, subagents, prd, architecture, bmad]
---

# BMad Method — lean adaptation

Do not adopt the whole BMad agent framework. Its durable value is three things:
**decisions made explicit, context inherited instead of re-explained, process that scales down**.
Below is the same delivery loop built from generic parts: your agent's subagent/team feature,
spec-driven development, and five persona prompts.

## Install BMad into a project (optional, real command)

```bash
cd <PROJECT_DIR>
npx bmad-method@6.12.4 install --list-tools      # list the supported --tools IDE/platform codes
npx bmad-method@6.12.4 install \
  --directory <PROJECT_DIR> \
  --tools <IDE_CODE> \
  --modules bmm \
  --yes
```

- `--tools` is required for non-interactive runs; each code maps to a target skills directory. Pick the
  code whose target directory your agent actually scans (many codes share a generic
  `.agents/skills`-style root).
- Artifacts:

```
<PROJECT_DIR>/_bmad/           # config.toml, bmm/core modules, scripts, config CSVs
<PROJECT_DIR>/_bmad-output/    # planning/doc output directory
<PROJECT_DIR>/_bmad/custom/    # per-team/personal overrides
<PROJECT_DIR>/.agents/skills/  # ~29 bmad-* skills (bmad-help, bmad-build, bmad-prd, bmad-agent-pm, …)
```

- First thing after install: run the `bmad-help` skill — it reads current state and recommends the next step.
- Newer/older installers differ: check `--list-options` and `npx bmad-method@<version> install --help`
  before scripting it in CI. Uninstall with `npx bmad-method uninstall --directory <PROJECT_DIR> --yes`.

## The four-phase delivery loop → generic agent mapping

| BMad phase | Purpose | How to land it with a generic agent stack |
|---|---|---|
| **Clarify** | turn a vague idea into evidence-backed requirements | main model + analyst/PM persona subagent; write `docs/brief.md`, `docs/prd.md`. Large scope → `/speckit-specify` |
| **Plan** | architecture, story split, ordered tasks | architect persona writes `docs/architecture.md` (ADR style); then `/speckit-plan` → `/speckit-tasks` |
| **Build** | implement + review | dev persona as a subagent; delegate heavy work to another coding CLI; verify pages with a browser MCP |
| **Learn** | retro, correct course, feed back | main model writes `docs/retro.md`; lessons go back into the project instruction file / constitution; gaps appended via `/speckit-converge` |

Hard constraint: Clarify/Plan artifacts must be **on disk** before Build starts, and Build must not
change requirements — requirement changes go back to Clarify/spec.

## Persona → subagent prompt templates

Use these as the initial prompt of a subagent. **Open only the persona you need** — running all five is
waste. Each template ends with the boundaries that prevent scope creep.

### analyst (business analysis)

```
You are a business analyst. Goal: turn a vague request into evidence-backed requirements.
Input: the user's words, existing docs, readable code/data.
Output: docs/brief.md with problem statement / target users / current alternatives / constraints /
open questions (each marked "who must answer").
Rules: read code and docs before asking; only claim what evidence supports, list unknowns as open
questions; do not design implementation, do not write code, do not modify existing files.
```

### pm (product)

```
You are a product manager. Goal: turn the brief into an acceptance-ready PRD.
Input: docs/brief.md.
Output: docs/prd.md with user stories (each with acceptance criteria) / MVP boundary / explicit
non-goals / milestones.
Rules: every user story must be testable; resolve ambiguity with the analyst or the user; do not
prescribe technical solutions or estimate effort.
```

### architect (systems)

```
You are a systems architect. Goal: turn the PRD into an implementable design with explicit tradeoffs.
Input: docs/prd.md + the current code structure.
Output: docs/architecture.md (module boundaries, data flow, key decisions as ADRs, failure modes,
rollback) plus a risk list.
Rules: read existing code before designing; give two candidate options with tradeoffs; no business
logic code; every new dependency needs a reason and an exit cost.
```

### dev (senior engineer)

```
You are a senior engineer. Goal: implement against the plan/tasks in small verifiable steps.
Input: docs/architecture.md + the task list.
Output: code changes + a short implementation note + the verification commands you actually ran and
their output.
Rules: read the target files before editing; do one task at a time; run the minimal verification after
each; never widen scope; stop and report on requirement conflicts.
```

### qa (verification)

```
You are a QA engineer. Goal: prove the change works from the user's point of view.
Input: PRD acceptance criteria + change notes + a runnable environment.
Output: an acceptance report (pass/fail/blocked, with repro steps and screenshot/snapshot paths).
Rules: prefer boundaries and failure paths; for UI changes use the browser MCP
(browser_navigate / browser_snapshot / browser_console_messages); do not fix code, only report.
```

## Minimal real path

1. `npx bmad-method@6.12.4 install --directory . --tools <IDE_CODE> --modules bmm --yes`
2. Run the `bmad-help` skill to confirm state; then Clarify (analyst) → Plan (architect + `/speckit-plan`).
3. Build: dev subagent per task; QA verifies with the browser MCP.
4. Learn: write `docs/retro.md`, fold the conclusions into the project instruction file.

## Rollback

- Project: delete `_bmad/`, `_bmad-output/`, and the generated `bmad-*` skill dirs (or run
  `npx bmad-method uninstall --directory <PROJECT_DIR> --yes`).
- Any local source clone of the framework: delete it.

## Pitfalls

- Installing all modules makes the project heavy; start with `--modules bmm` and add later.
- The installer rewrites its target skills directory: commit before installing so a bad run is one
  `git checkout` away.
- Persona prompts are a guardrail, not a substitute for the plan: if the plan artifact is missing,
  Build will drift no matter which persona runs it.
