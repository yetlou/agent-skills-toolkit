---
name: playwright-mcp
description: Drive a real browser through Playwright MCP's structured browser_* tools for web QA and acceptance — navigate, snapshot, click, fill, wait, screenshots, console errors, network response bodies, and reuse of a saved login state. Includes the npm package/bin layout, the --isolated vs --storage-state tradeoff, and known flag traps.
version: 1.0.0
author: Agent Skills Toolkit contributors
license: MIT
platforms: [linux, macos, windows]
metadata:
  tags: [playwright, mcp, browser, e2e, acceptance-test, screenshot, network]
---

# Playwright MCP — structured browser QA

Wire Playwright into your agent as an MCP server and the agent stops writing throwaway Playwright
scripts: it calls `browser_*` tools to navigate, click, fill forms, wait, screenshot and read network
responses. Ideal for pre-release smoke tests, public-state read-back, and turning page evidence into files.

## When to use

- After a front-end change you need **acceptance**: page loads, buttons click, forms submit, API payloads right.
- You need screenshots/snapshots as delivery evidence (harder to dispute than prose).
- You need real network detail (status codes, response bodies) rather than rendered text.
- You need read-back of a site you are already logged into (with a saved storage state).

**Not for**: bulk scraping (use search/fetch tools), static pages with no interaction, operations that
need human-like mouse trajectories.

## 1. Install and configure

```bash
npm i -g @playwright/mcp@latest            # provides the `playwright-mcp` bin
npx @playwright/mcp@latest --help          # all flags for your version
# browsers are downloaded on demand; if your machine already has a Playwright cache the launch reuses it
```

Register it with your MCP host (config file, per-host file name and restart semantics vary):

```yaml
mcp_servers:
  playwright:
    command: <NPM_GLOBAL_BIN>/playwright-mcp
    args:
      - --headless
      - --isolated
    enabled: true
```

- `--isolated`: a throwaway profile per session, no cookies persisted. Drop it when you need a session to
  survive, and use `--user-data-dir=<dir>` or `--storage-state=<file>` instead.
- Tool names are `browser_navigate`, `browser_click`, … — some hosts add a server prefix
  (e.g. `playwright_browser_navigate`); check the tool list your host exposes.
- Verify with your host's MCP status command; a healthy server reports ~25 tools.

## 2. Standard acceptance flow

1. `browser_navigate {url}`
2. `browser_snapshot` — accessibility tree with element refs (**better than a screenshot as a click target**);
   on large pages use `browser_find {text|regex}` to locate just the nodes you need.
3. Interact:
   - `browser_click {target, element}` (target = snapshot ref or a unique CSS selector)
   - `browser_type {target, text, submit}` / `browser_fill_form {fields:[...]}`
   - `browser_select_option {target, values}`, `browser_press_key {key}`, `browser_hover`
4. Assert: `browser_wait_for {text}` for key copy, then `browser_snapshot` again for state.
5. Evidence:
   - `browser_take_screenshot {filename:"/tmp/evidence.png", fullPage:true, scale:"css"}`
   - `browser_console_messages {level:"error"}` for front-end errors
   - `browser_network_requests {static:false}` → `browser_network_request {index, part:"response-body"}`
     to inspect a specific call (status, JSON fields, slow requests)
6. Finish with `browser_close` (explicit even for isolated sessions).

## 3. Login state (storage state)

```bash
# one-off manual login that saves state (opens a headed browser)
npx playwright codegen --save-storage=<AUTH_STATE_JSON> https://example.com
```

Point the server at it and restart the MCP host so the config takes effect:

```yaml
  playwright:
    command: <NPM_GLOBAL_BIN>/playwright-mcp
    args:
      - --headless
      - --storage-state=<AUTH_STATE_JSON>
    enabled: true
```

The state file holds cookies/session credentials: keep it outside the repo (e.g. `~/.config/...`),
`chmod 600`, never commit it, never paste it into a shared doc.

## 4. Headless / isolated vs headed

| Need | args change | To take effect |
|---|---|---|
| Default headless acceptance | `--headless --isolated` | current setup |
| See the window (debug / manual takeover) | drop `--headless` (leave `--browser` unset) | edit config → restart MCP host |
| Keep cookies / login | drop `--isolated`, add `--storage-state=<file>` or `--user-data-dir=<dir>` | restart MCP host |
| Reuse an installed Chrome channel | `--browser=chrome` (needs Chrome installed) | restart MCP host |

Headed mode opens a real window — always `browser_close` afterwards, and do not run unattended batches headed.

## 5. Activation: restart matters

MCP config is read when the host process starts, so a running host will **not** hot-reload it. Test the
server standalone first (spawning a one-off process is enough), and restart the host only when you need
the new tools inside an existing session.

## 6. Pitfalls and rollback

- **Do not pass `--browser=chromium`** on current versions: it is resolved as the `chrome-for-testing`
  channel, and if only the bundled chromium is installed, navigation fails with
  `Browser "chrome-for-testing" is not installed`. Omitting `--browser` uses the bundled browser and works.
- The upstream npm bin is **`playwright-mcp`**; if you create a `mcp-server-playwright` alias, that is your
  own compatibility shim, not the official bin name.
- Clicks that do nothing: re-take `browser_snapshot` first — refs become stale as the page changes.
- Screenshot paths resolve relative to the server's working directory; write evidence to absolute paths.
- Avoid `browser_run_code_unsafe` (it is RCE-equivalent) for normal work — only when the structured tools
  genuinely cannot express the action.
- **Rollback**: delete the `playwright:` block from the config, restore the backup
  (`cp -p <config>.bak-<ts> <config>`), restart the host, and confirm the server is gone from the MCP list;
  remove the package with `npm -g rm @playwright/mcp`.
