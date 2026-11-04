---
name: spec-kit
description: Spec-driven development with GitHub Spec Kit (specify CLI). Write the requirement spec first, then plan, tasks, implement, and converge, with an auditable artifact chain per feature. Includes how to install the generated /speckit-* commands as user-level agent skills.
version: 1.0.0
author: Agent Skills Toolkit contributors
license: MIT
platforms: [macos, linux, windows]
metadata:
  tags: [spec-driven-development, sdd, specify-cli, spec-kit, planning, requirements]
---

# Spec Kit — spec-driven development

Turn "let the agent write code" into "let the agent align on a spec, then write code".
Spec Kit (GitHub, MIT) gives you a fixed pipeline where every step lands a file you can review:
`constitution → spec → clarify → plan → tasks → analyze → implement → converge`.

## When to use

- The requirement does not fit in one sentence, or the change touches several files/modules.
- You want an auditable delivery chain: each step has an artifact, so a bad assumption is caught before code.
- You are handing a feature to an agent and want less rework from misread intent.

**Not for**: one-file fixes, pure Q&A, exploratory spikes — those are faster with the agent directly.

## Install

```bash
uv tool install specify-cli        # PyPI distribution, provides the `specify` binary
specify --version                  # e.g. specify 1.3.0
uv tool upgrade specify-cli        # upgrade (or: specify self upgrade)
```

Requires Python 3.10+ with `uv` (or use `pipx install specify-cli`).

## Initialize a project

```bash
cd <PROJECT_DIR>
specify init --help                       # list the supported --integration keys first
specify init --here --integration <KEY> --non-interactive --force
```

- `--integration <KEY>` decides where the `/speckit-*` commands/skills are generated
  (common keys: `claude`, `copilot`, `cursor`, `gemini`, `codex`, `generic`, plus
  agent-specific keys that appear as integrations are added — always confirm with `specify init --help`).
- Non-interactive runs **must** pass `--integration`, otherwise the default is chosen silently.
- `--force` is needed for a non-empty directory.
- If your agent CLI is not on `PATH` and you do not want the integration probe to fail, add
  `--ignore-agent-tools`.

Generated layout (structure is stable across integrations):

```
<PROJECT_DIR>/
  .specify/
    memory/constitution.md
    templates/{spec,plan,tasks,checklist,constitution}-template.md
    scripts/…                 # helper scripts for the platform
    integrations/<key>.manifest.json
  specs/NNN-<slug>/spec.md    # created per feature by /speckit-specify
  <integration skills dir>/speckit-*/SKILL.md
```

Check the wiring with `specify integration status` and `specify integration list`.

## Minimal workflow

Trigger each step from your agent (slash command or matching skill name):

1. `/speckit-constitution` — project principles and constraints → `.specify/memory/constitution.md`.
2. `/speckit-specify <feature description>` — requirements only (no implementation) → `specs/NNN-<slug>/spec.md`.
3. `/speckit-clarify` (optional) — structured questions on ambiguities, answers folded into the spec.
4. `/speckit-plan` — technical plan that cites the constitution → `plan.md`.
5. `/speckit-tasks` — checkable task list → `tasks.md`.
6. `/speckit-analyze` (optional) — cross-artifact consistency check.
7. `/speckit-implement` — implement task by task.
8. `/speckit-converge` — diff spec against implementation, append the remaining work to `tasks.md`.

Rules that make it work: each step reads the previous artifact; never skip steps; when the
requirement changes, edit the spec and re-run, never patch the code silently.

## Install the generated skills at user level (optional)

Project-level is usually enough. To get `/speckit-*` in every directory, copy the generated skill
directories into your agent's user-level skills folder:

```bash
# 1) generate in a scratch/template project first
cd <TEMPLATE_DIR> && specify init --here --integration <KEY> --non-interactive --force

# 2) copy only the speckit-* skill dirs
cp -R <TEMPLATE_DIR>/<integration skills dir>/speckit-* <AGENT_SKILL_DIR>/

# 3) frontmatter must keep a unique name (already speckit-specify, speckit-plan, …)
head -6 <AGENT_SKILL_DIR>/speckit-specify/SKILL.md
```

Notes:

- Do not keep project-level and user-level copies with the same name but different content: whichever
  the agent discovers first wins and behaviour drifts.
- Generated skills use `$ARGUMENTS` as the argument placeholder; `/speckit-specify my feature` passes
  the text after the command name.
- Put `AGENTS.md` (or the equivalent project instruction file) next to the code and document the
  `specs/` layout plus commit conventions so every agent follows the same rules.
- Generated skills are frontmatter-simple: `name` + `description` are the hard requirements.

## Other commands

```bash
specify check                     # which agent CLIs are detected on this machine
specify integration status        # current project integration state
specify integration switch <key>  # switch integration
specify preset list               # optional presets (e.g. compliance templates)
specify mcp                       # experimental MCP stdio server for external agents
```

## Rollback

- Project: remove `.specify/` and the generated `speckit-*` skill dirs (and `specs/` if you want a clean slate).
- Global: `uv tool uninstall specify-cli` and remove the copied user-level skills.

## Pitfalls

- Non-interactive init without `--integration` silently picks a default → always pass it.
- Re-running `init --force` overwrites templates; commit first so a bad init is one `git checkout` away.
- If the integration writes into a directory your agent does not scan, the skills will look "missing" —
  verify the output dir against your agent's skill discovery paths before debugging anything else.
