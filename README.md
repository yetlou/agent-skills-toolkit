# Agent Skills Toolkit

Portable, self-contained **agent skills** plus a deterministic **GitHub trend radar**.
Every skill is a single `SKILL.md`: when to use it, the real commands, the traps, and how to roll back.
Written to be read by an agent, not just by a human.

MIT licensed. No credentials, no personal paths, no vendor lock-in: everything uses `<PLACEHOLDER>`
or `~` / `$HOME` conventions — substitute your own values.

## What's inside

| Path | What it is |
|---|---|
| `skills/spec-kit/` | Spec-driven development with GitHub Spec Kit (`specify` CLI): constitution → spec → plan → tasks → implement → converge |
| `skills/bmad-method/` | A lean BMad Method adaptation: Clarify → Plan → Build → Learn mapped onto subagents/agent teams, with 5 persona prompts (analyst, PM, architect, dev, QA) and the real `npx bmad-method install` usage |
| `skills/shadcn-ui/` | shadcn/ui CLI in a React project: `init`/`add`, Tailwind v4 notes, copy-into-repo component model |
| `skills/codex-delegation/` | Non-interactive delegation to the Codex CLI (`codex exec`): flags, sandbox modes, approval-policy gotchas, quota/timeout handling |
| `skills/playwright-mcp/` | Playwright MCP for browser QA: `browser_*` tool flow, screenshots, console/network evidence, saved login state |
| `radar/` | Daily GitHub trend radar: pure Node, no dependencies, deterministic scoring, fixtures + tests, digest and content briefs |

## Use a skill

Skills are discovered by agents from a directory of `<name>/SKILL.md`. Copy the ones you want into your
host's user-level or project-level skills directory (for most agents this is a documented path under your
home directory, or `.agents/skills/` inside a project):

```bash
cp -R skills/spec-kit skills/bmad-method skills/shadcn-ui \
      skills/codex-delegation skills/playwright-mcp <YOUR_SKILLS_DIR>/
```

Skills are loaded at session start: open a new session after copying.

Each skill also lists the CLI it needs, for example:

```bash
uv tool install specify-cli        # spec-kit
npm i -g shadcn@latest             # shadcn/ui
npm i -g @playwright/mcp@latest    # playwright-mcp
npm i -g @openai/codex@latest      # codex-delegation (then: codex login)
```

## Run the radar

```bash
cd radar
node radar.mjs --limit 20      # -> out/<date>/{radar.json,radar.md,digest.txt,media-briefs.md}
node radar.mjs --offline       # replay fixtures, no network
node --test test/              # unit tests
```

It aggregates GitHub Trending, the GitHub Search API and Hacker News, dedupes, scores, classifies
(mcp / skill / agent-tool / content-ref / other) and emits a short digest plus content briefs.
`state/` and `out/` are gitignored; nothing is written outside the repo.

## Principles

- **No secrets in the repo.** Skills tell the agent *how* to use an authenticated CLI; they never
  contain a token, cookie or password. Login state files stay outside version control, `chmod 600`.
- **Rollback is part of the instructions.** Every skill ends with how to undo what it set up.
- **Read-only by default.** Browser automation defaults to headless + isolated (anonymous). Platform
  write actions are explicitly out of scope.
- **Deterministic tooling.** The radar has no LLM dependency; tests run against fixtures.

## License

MIT — see [LICENSE](LICENSE).
