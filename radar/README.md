# GitHub trend radar

A daily "what's exploding on GitHub" radar: **pure Node, zero dependencies, no LLM, deterministic**.
It aggregates three public sources, dedupes, scores, classifies, and writes a machine-readable report
plus a short human digest and video/content briefs.

```
radar.mjs          single-file script (~1.6k lines, node: built-ins only)
test/              51 unit tests + offline fixtures (real API snapshots)
```

## Sources

1. **GitHub Trending HTML** (`https://github.com/trending?since=daily`) — repo, stars today, language, description.
2. **GitHub Search API** — recently created high-star repos (`created:>30d stars:>150`) plus topic searches
   (`mcp`, `ai-agents`, `claude-code`, `agent-skill`, `llm-tools`).
3. **Hacker News Algolia API** — high-point stories for `mcp` / `agent` / `skill` / `open-source`, as a
   "beyond GitHub" signal.

Then: enrich with repo metadata (stars, license, pushed_at, archived, topics), optionally probe the repo
root for `SKILL.md` / Dockerfile / package.json, merge and dedupe.

Any source may fail — it logs a warning and the run still exits `0` (degraded success).

## Usage

```bash
cd radar

node radar.mjs                       # fetch today, write out/<today>/
node radar.mjs --date 2026-11-04     # explicit output date directory
node radar.mjs --limit 10            # rows in the top table / number of candidate drafts (default 20)
node radar.mjs --probe 20            # how many repos get a root probe (default 12, 0 disables)
node radar.mjs --no-hn               # skip the Hacker News source
node radar.mjs --offline             # replay test/fixtures only, no network at all
node radar.mjs --force               # ignore "already delivered today", re-emit the digest
node radar.mjs --no-token            # anonymous API (60 req/h), debugging only
node radar.mjs --quiet               # minimal stderr
node radar.mjs --fixtures <dir>      # custom fixture directory
```

- **Exit codes**: source failures are not fatal (`exit 0`); only bad arguments or write failures exit `1`.
- **stdout**: one line of JSON summary (`ok/date/candidates/digestChars/suppressed/outDir/files/top5/sources`)
  so a cron wrapper can parse it; human logs go to stderr.
- **Authentication**: `GITHUB_TOKEN` → `GH_TOKEN` → macOS keychain (`git credential-osxkeychain`).
  The token lives only in memory and is never printed, persisted, or put in a URL; error text is passed
  through `redact()`. Without a token the GitHub API allows 60 requests/hour (about one full run).

## Outputs (`out/<date>/`)

| File | Content |
|---|---|
| `radar.json` | Full machine-readable result: every candidate with its score breakdown and source status |
| `radar.md` | Top-20 table + category sections + recommended actions + warnings |
| `media-briefs.md` | 3 content briefs from the most "video-worthy" items (title / 30s hook / 3-part structure / visuals / tags / channel fit) |
| `digest.txt` | Chinese digest, ≤1200 characters — drop-in for a chat/Discord delivery |
| `candidates/<owner>__<repo>.md` | One draft per candidate: what it is / why it matters / real install command / risks / recommendation |
| `.delivered.json` | Idempotency marker: a second run on the same date will not re-emit the digest (use `--force`) |

`state/seen.json` stores previous star counts (for day-over-day deltas) and `state/history.jsonl` is an
append-only run log. Both are gitignored. `assertWithin()` guarantees the script never writes outside
its own directory (covered by tests).

## Scoring (explainable, deterministic)

`score = clamp(heat + freshness + local-availability + risk, 0, 100)`, and `radar.json` keeps the full
`breakdown` so you can see why an item ranked where it did.

- **Heat** (≤60): `log10(stars)*9` + stars today (≤22) + HN points (≤12) + trending bonus (+6).
- **Freshness** (≤20): ≤7d → 20, ≤30d → 16, ≤90d → 11, ≤180d → 7, ≤365d → 3, older → 0.
- **Local availability**: permissive license +12 (copyleft +4, no license −6), no Docker +8, no API key
  +6, has install script +5, `SKILL.md` at repo root +6, archived −25.
- **Risk**: archived −15, no description −5, <50 stars −5, experimental/alpha −6, awesome-list −4,
  needs API key −4, no license −3.
- **Unknown stays `null`**: Docker/API-key/install-script signals are only set when there is positive
  evidence (description/topics/root listing); otherwise `null` and it does not score.

Classification priority: `plugin > content-ref (awesome/HN) > mcp > skill > agent-tool > other`.
A "skill" classification requires structural evidence (root `SKILL.md`, a `skills/` dir, "skill" in the
name/topic), not just the word in a description. Recommended action: `skip` / `install-mcp` /
`draft-skill` / `media-content` / `watch`.

## Tests

```bash
node --test test/                  # 51 tests, ~120 ms (uses fixtures, no network)
node --test test/radar.test.mjs    # same file, explicit — recommended for CI
```

Coverage: trending regex parsing (missing description/language/stars-today), search JSON mapping, HN
parsing, cross-source dedupe, license normalisation, Docker/API-key/install-script/SKILL.md signals,
classification priority, score monotonicity and determinism, action routing, day-over-day delta,
`wasDelivered` idempotency, digest length cap, artifact rendering, write-boundary assertions, token redaction.

> Note for Node ≥26: `node --test <dir>` loads the directory as a module instead of discovering files,
> so `test/index.js` re-exports the real test file. Running `test/radar.test.mjs` directly also works.

## Limitations (honest list)

1. Trending is parsed from HTML with regexes; a GitHub redesign breaks that source (others keep working).
2. Only Trending provides "stars today"; search-derived candidates have `starsToday = null`.
3. Root probing only looks at the repo root of the first `--probe` repos — nested `skills/**/SKILL.md` is not seen.
4. Docker/API-key/install-script detection is heuristic; unknown values stay `null`.
5. Search takes 15 results per query, so long-tail small repos are missed; `--limit` only affects output.
6. Date defaults to local time; pass `--date` explicitly when running across time zones.
7. Star counts drift by a star or two between runs; the script never estimates missing numbers.
8. `media-briefs.md` is a template (structure, visuals, quotable facts), not finished copy.

## Maintenance / rollback

| Need | Action |
|---|---|
| Re-fetch today | `node radar.mjs --force` |
| Drop one day's outputs | `rm -rf out/<date>/` (recreated next run) |
| Reset the delta baseline | `rm state/seen.json` → all deltas become `null` (not zero) |
| Re-emit the digest | delete `out/<date>/.delivered.json` or pass `--force` |
| Change scoring/classification | edit the constants and `heatScore/freshnessScore/usabilityScore/riskScore/classifyCandidate` in `radar.mjs` |
| Full rollback | delete this directory — the script installs nothing and writes only inside it |
