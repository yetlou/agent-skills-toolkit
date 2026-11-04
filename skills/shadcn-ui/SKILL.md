---
name: shadcn-ui
description: Install shadcn/ui components into a React project with the shadcn CLI (init/add/view/docs/search), including Tailwind v4 compatibility, the copy-into-repo model instead of an npm dependency, and when this stack is the wrong choice.
version: 1.0.0
author: Agent Skills Toolkit contributors
license: MIT
platforms: [macos, linux, windows]
metadata:
  tags: [shadcn, react, tailwind, ui-components, cli, radix]
---

# shadcn/ui — copy-in components

shadcn/ui is not a component library you install; it is a CLI that **copies component source into your
repo** (`components/ui/*.tsx`) so you own and edit it. Dependencies it needs (Radix, `lucide-react`,
`class-variance-authority`, …) are added for you.

Official docs: <https://ui.shadcn.com/docs/cli> · Tailwind v4: <https://ui.shadcn.com/docs/tailwind-v4>

## When to use

- A React + Tailwind project needs a solid, editable UI base (button, form, dialog, table, chart).
- You want full control of component source: edit it freely, no upstream breaking changes.
- You want a decent admin/form/login screen fast, then let an agent iterate on styling and behaviour.

**Not for**: Vue/Svelte projects; projects that do not want Tailwind; one-off styles where a plain div
is cheaper.

## Initialize

```bash
cd <PROJECT_DIR>
npx shadcn@latest init
```

Non-interactive / scaffolding variants:

```bash
npx shadcn@latest init -d              # defaults (template + preset)
npx shadcn@latest init -t vite -b radix -y
npx shadcn@latest init --no-css-variables --rtl --monorepo   # flags as needed
```

A global CLI (`npm i -g shadcn@latest`) is fine for experiments, but prefer `npx shadcn@latest` per
project so each repo locks its own CLI version.

Requirements for an existing project: React + Tailwind installed, a path alias (`@/`), and
`tsconfig.json`. `init` writes/updates `components.json`, `lib/utils.ts` (`cn()`), and the global CSS variables.

**Tailwind v4**: the CLI supports v4's CSS-first config (`@import "tailwindcss"`, no
`tailwind.config.js` needed) and still works on v3 projects. In a monorepo mixing v3 and v4, unify the
Tailwind version before running `init`.

## Add components

```bash
npx shadcn@latest add button
npx shadcn@latest add dialog form table tabs
npx shadcn@latest add --all                    # everything
npx shadcn@latest add button --dry-run         # show planned changes only
npx shadcn@latest add button -o                # overwrite existing files
npx shadcn@latest add button -p components/ui-legacy   # custom target directory
npx shadcn@latest add https://example.com/r/foo.json   # third-party registry item
```

- Component source lands in the repo (default `components/ui/*.tsx`); it is **not** an npm dependency,
  so `npm update` never overwrites your edits.
- `npx shadcn@latest view <item>` shows source, `docs <item>` shows documentation/examples,
  `search` queries the registry, `info` dumps the project config.

## Working with an agent

1. Commit `components.json`, the global CSS, and `lib/utils.ts` after `init` — that is the UI baseline.
2. Add components with `add`, then let the agent edit only your own layer (`app/`, non-`ui`
   components). Treat `components/ui/` as vendored code.
3. Verify in a real browser after changes: run the dev server, then drive it with a browser MCP
   (`browser_navigate` → `browser_snapshot` → `browser_console_messages`). Do not stop at reading static code.
4. For an internal component library / private registry: `npx shadcn@latest build`, then consume it
   elsewhere with `add <url>`; `shadcn mcp` can expose a registry as MCP tools.

## Pitfalls and boundaries

- `init` edits global CSS and path aliases: commit before running so `git checkout -- .` is a clean rollback.
- `add --all` pulls dozens of files — `--dry-run` first; existing files are skipped by default, pass `-o`
  only when you really want to overwrite.
- A globally installed `shadcn` can drift from a project's needs; per-project `npx shadcn@latest` is the
  source of truth.
- `shadcn eject` inlines the runtime styles if you want to remove the CLI dependency entirely; otherwise
  manual removal means deleting `components.json` plus the generated `components/ui/` files.
