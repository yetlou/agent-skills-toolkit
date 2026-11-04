#!/usr/bin/env node
/**
 * github-radar — 每日 GitHub 涨星雷达（确定性、零依赖、无 LLM）
 *
 * 三个数据源（任一失败只告警，不中断）：
 *   ① GitHub Trending HTML  https://github.com/trending?since=daily
 *   ② GitHub Search API     近 30 天新建高星仓库 + 5 个主题检索
 *   ③ Hacker News Algolia   points>150 的 mcp/agent/skill/open-source 讨论（“等网站”补充）
 *
 * 产出（全部在 tools/github-radar/ 内）：
 *   out/<date>/radar.json | radar.md | media-briefs.md | digest.txt
 *   out/<date>/candidates/<owner>__<repo>.md
 *   state/seen.json（上次 stars，用于算日增量）| state/history.jsonl（append-only）
 *
 * 用法：
 *   node tools/github-radar/radar.mjs                       # 抓今天并输出
 *   node tools/github-radar/radar.mjs --date 2026-11-04     # 指定输出日期目录
 *   node tools/github-radar/radar.mjs --offline             # 用 test/fixtures/ 跑，不发网络请求
 *   node tools/github-radar/radar.mjs --limit 20 --no-hn --force
 *
 * 令牌：默认从 GITHUB_TOKEN / GH_TOKEN 环境变量取；都没有时尝试 macOS keychain
 * （git credential-osxkeychain）。令牌只存在于内存，绝不打印、不落盘、不写进 URL。
 *
 * 退出码：0 = 成功（含部分源失败的降级成功）；1 = 参数错误/写文件失败。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/* ------------------------------------------------------------------ *
 * 常量 / 配置（想改口径改这里）
 * ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 1;
export const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TRENDING_URL = 'https://github.com/trending?since=daily';
export const GITHUB_API = 'https://api.github.com';
export const HN_API = 'https://hn.algolia.com/api/v1/search';

/** 主题检索（源②） */
export const SEARCH_TOPICS = ['mcp', 'ai-agents', 'claude-code', 'agent-skill', 'llm-tools'];
/** 近 30 天新建的高星仓库检索（源②） */
export const SEARCH_CREATED_QUERY = 'created:>{{DAYS}}d stars:>150';
export const SEARCH_CREATED_DAYS = 30;
/** HN 关键词（源③） */
export const HN_KEYWORDS = ['mcp', 'agent', 'skill', 'open-source'];

/** 许可证：宽松 = 本地可直接用；copyleft = 本地可用但再分发要注意；其余 = 有风险 */
export const PERMISSIVE_LICENSES = new Set([
  'mit', 'apache-2.0', 'bsd-3-clause', 'bsd-2-clause', 'isc', '0bsd', 'unlicense',
  'cc0-1.0', 'mpl-2.0', 'blueoak-1.0.0', 'wtfpl', 'zlib',
]);
export const COPYLEFT_LICENSES = new Set([
  'gpl-2.0', 'gpl-3.0', 'agpl-3.0', 'lgpl-2.1', 'lgpl-3.0', 'epl-2.0', 'eupl-1.2',
]);

/** 分类常量 */
export const CATEGORIES = ['mcp', 'skill', 'dsh-plugin', 'agent-tool', 'content-ref', 'other'];
export const ACTIONS = ['install-mcp', 'draft-skill', 'watch', 'media-content', 'skip'];

/** 视频号口径（一行可改；不编造真实账号名） */
export const ACCOUNTS = {
  main: '主号 · 技术深挖（8–12 分钟）',
  shorts: '短视频号 · 60 秒速览',
  roundup: '合集号 · 周报/工具盘点',
};

const DEFAULTS = { limit: 20, probe: 12, searchPerPage: 15, hnPerPage: 8 };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const round1 = (n) => Math.round(n * 10) / 10;

/** 安全转数字：抓不到就是 null，绝不编造 */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export const stripHtml = (s = '') =>
  String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function slugify(s = '') {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** 生成文件系统安全的仓库文件名：owner/repo → owner__repo */
export function repoSafeName(fullName = '') {
  return String(fullName).trim().replace(/[\\/:*?"<>|\s]+/g, '__').replace(/^_+|_+$/g, '') || 'unknown';
}

export function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function daysBetween(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.max(0, Math.floor((t2 - t1) / 86400000));
}

/** 截断到 n 个码点（中文按字算） */
export function truncate(s, n) {
  const arr = [...String(s ?? '')];
  return arr.length <= n ? arr.join('') : arr.slice(0, Math.max(0, n - 1)).join('') + '…';
}

export const codePointLength = (s) => [...String(s ?? '')].length;

/** 从任意文本里抹掉疑似 token，防止意外泄露 */
export function redact(text, token) {
  let out = String(text ?? '');
  if (token && token.length > 8) out = out.split(token).join('[REDACTED]');
  return out
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]');
}

/** 确保目标路径在 base 之内（脚本不许写工作区/自身目录之外） */
export function assertWithin(base, target) {
  const b = path.resolve(base) + path.sep;
  const t = path.resolve(target);
  if (!(t + path.sep).startsWith(b) && t !== path.resolve(base)) {
    throw new Error(`拒绝写入工具目录之外的路径: ${target}`);
  }
  return t;
}

/* ------------------------------------------------------------------ *
 * ① Trending HTML 解析
 * ------------------------------------------------------------------ */

/**
 * 解析 GitHub Trending 页面。
 * 每块结构：<article class="Box-row"> … <h2><a href="/owner/repo"> …
 *          <p class="col-9 color-fg-muted …">简介</p> … "1,139 stars today"
 * 解析不到的字段一律 null，不猜。
 */
export function extractCountFromAnchor(block, pathSegment) {
  const re = new RegExp(`<a\\b[^>]*\\/${pathSegment}"[^>]*>([\\s\\S]*?)<\\/a>`, 'i');
  const inner = block.match(re)?.[1];
  if (!inner) return null;
  const digits = stripHtml(inner).replace(/[^\d]/g, '');
  return digits ? num(digits) : null;
}

export function parseTrendingHtml(html) {
  const text = String(html || '');
  const parts = text.split(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>/i).slice(1);
  const out = [];
  parts.forEach((chunk, i) => {
    const block = chunk.split(/<\/article>/i)[0] || '';
    const h2 = block.match(/<h2\b[\s\S]*?<\/h2>/i)?.[0] || '';
    const repoHref =
      h2.match(/href="\/([^/"?#]+)\/([^/"?#]+)"/) ||
      block.match(/href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/);
    if (!repoHref) return;
    const owner = repoHref[1];
    const name = repoHref[2];
    if (!owner || !name || /^(login|sponsors|orgs|features|topics)$/i.test(owner)) return;

    const starsToday = num((block.match(/([\d,]+)\s+stars?\s+today/i) || [])[1]);
    const stars = extractCountFromAnchor(block, 'stargazers');
    const forks = extractCountFromAnchor(block, 'forks');
    const language = stripHtml((block.match(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)</i) || [])[1] || '') || null;
    const descRaw = (block.match(/<p\b[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
    const description = descRaw ? stripHtml(descRaw) : null;

    out.push({
      fullName: `${owner}/${name}`,
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      starsToday: starsToday === null ? null : Math.round(starsToday),
      stars: stars === null ? null : Math.round(stars),
      forks: forks === null ? null : Math.round(forks),
      language,
      description: description || null,
      trendingRank: i + 1,
      sources: ['trending'],
      kind: 'repo',
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * ② GitHub Search API 解析
 * ------------------------------------------------------------------ */

export function parseSearchResponse(json, sourceLabel = 'search') {
  const items = Array.isArray(json?.items) ? json.items : [];
  return items
    .filter((it) => it && typeof it.full_name === 'string')
    .map((it) => ({
      fullName: it.full_name,
      owner: it.owner?.login || it.full_name.split('/')[0],
      name: it.name || it.full_name.split('/')[1],
      url: it.html_url || `https://github.com/${it.full_name}`,
      stars: num(it.stargazers_count),
      forks: num(it.forks_count),
      starsToday: null,
      language: it.language || null,
      description: it.description || null,
      topics: Array.isArray(it.topics) ? it.topics : [],
      license: it.license?.spdx_id || it.license?.key || null,
      createdAt: it.created_at || null,
      pushedAt: it.pushed_at || null,
      archived: typeof it.archived === 'boolean' ? it.archived : null,
      homepage: it.homepage || null,
      openIssues: num(it.open_issues_count),
      trendingRank: null,
      sources: [sourceLabel],
      kind: 'repo',
    }));
}

/* ------------------------------------------------------------------ *
 * ③ Hacker News 解析
 * ------------------------------------------------------------------ */

export function parseHnResponse(json, keyword = '') {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  return hits
    .filter((h) => h && h.title)
    .map((h) => ({
      objectID: String(h.objectID ?? ''),
      title: stripHtml(h.title),
      url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null),
      points: num(h.points),
      comments: num(h.num_comments),
      author: h.author || null,
      createdAt: h.created_at || null,
      keywords: keyword ? [keyword] : [],
      kind: 'hn',
    }));
}

/** 从 HN 链接里识别 GitHub 仓库（owner/repo） */
export function repoFromUrl(url) {
  const m = String(url || '').match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#]|$)/i);
  if (!m) return null;
  const owner = m[1], name = m[2].replace(/\.git$/i, '');
  if (!owner || !name) return null;
  if (/^(topics|login|features|sponsors|orgs|apps|marketplace|search|collections|trending|about)$/i.test(owner)) return null;
  return `${owner}/${name}`;
}

/* ------------------------------------------------------------------ *
 * 合并 / 去重
 * ------------------------------------------------------------------ */

const nullableMax = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : Math.max(a, b));
const nullableMin = (a, b) => (a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : Math.min(a, b));
const pickNonEmpty = (a, b) => (a && String(a).trim() ? a : b ?? a ?? null);

/**
 * 按 fullName（大小写不敏感）合并去重。
 * 同一仓库可能同时出现在 trending 和多个主题检索里。
 */
export function mergeCandidates(lists = []) {
  const byKey = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      if (!raw?.fullName) continue;
      const key = raw.fullName.toLowerCase();
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          ...raw,
          sources: [...new Set(raw.sources || [])],
          topics: [...new Set(raw.topics || [])],
          hnUrls: [...new Set(raw.hnUrls || [])],
        });
        continue;
      }
      byKey.set(key, {
        ...prev,
        // 优先保留更权威的 GitHub 元数据
        stars: nullableMax(prev.stars, raw.stars),
        forks: nullableMax(prev.forks, raw.forks),
        starsToday: nullableMax(prev.starsToday, raw.starsToday),
        license: prev.license || raw.license || null,
        createdAt: prev.createdAt || raw.createdAt || null,
        pushedAt: prev.pushedAt || raw.pushedAt || null,
        archived: prev.archived ?? raw.archived ?? null,
        language: prev.language || raw.language || null,
        description: pickNonEmpty(prev.description, raw.description),
        homepage: prev.homepage || raw.homepage || null,
        trendingRank: nullableMin(prev.trendingRank, raw.trendingRank),
        topics: [...new Set([...(prev.topics || []), ...(raw.topics || [])])],
        sources: [...new Set([...(prev.sources || []), ...(raw.sources || [])])],
        hnPoints: nullableMax(prev.hnPoints, raw.hnPoints),
      });
    }
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ *
 * 许可证 / 可用性信号
 * ------------------------------------------------------------------ */

export function normalizeLicense(license) {
  if (!license) return null;
  const l = String(license).trim().toLowerCase();
  if (!l || l === 'noassertion' || l === 'other' || l === 'none') return null;
  return l;
}

export function licenseClass(license) {
  const l = normalizeLicense(license);
  if (!l) return 'unknown';
  if (PERMISSIVE_LICENSES.has(l)) return 'permissive';
  if (COPYLEFT_LICENSES.has(l)) return 'copyleft';
  return 'other';
}

const DOCKER_RE = /\b(docker|docker-compose|container|k8s|kubernetes|helm chart|self-host(ed)? server)\b/i;
const APIKEY_RE = /\b(api[ _-]?key|openai_api_key|anthropic_api_key|requires? (an )?api key|bring your own key|byok)\b/i;
const INSTALL_RE = /\b(npx|npm i(nstall)?|pnpm|yarn|brew install|pip install|uvx|uv pip|cargo install|go install|curl -fsSL)\b/i;
const EXPERIMENTAL_RE = /\b(experimental|alpha|beta|wip|work in progress|proof of concept|poc|unstable)\b/i;
const AWESOME_RE = /\b(awesome[- ]|curated list|collection of|papers?|reading list|cheat ?sheet)\b/i;

/** 从 description/topics/根目录文件列表里提取可用性信号；判不出来给 null（不猜） */
export function extractSignals(candidate = {}) {
  const topics = (candidate.topics || []).map((t) => String(t).toLowerCase());
  const desc = String(candidate.description || '');
  const name = String(candidate.name || '');
  const files = (candidate.files || []).map((f) => String(f).toLowerCase());
  const hay = `${desc} ${topics.join(' ')} ${name}`;

  const fileHas = (re) => files.some((f) => re.test(f));
  const hasListing = files.length > 0; // 只有拿到根目录清单才敢说“没有”
  let requiresDocker = null;
  if (DOCKER_RE.test(desc) || topics.some((t) => /docker|kubernetes|self-?host/.test(t))) requiresDocker = true;
  else if (hasListing) requiresDocker = fileHas(/^dockerfile$/) || fileHas(/^docker-compose\.ya?ml$/) || fileHas(/^compose\.ya?ml$/);

  let requiresApiKey = null;
  if (APIKEY_RE.test(hay)) requiresApiKey = true;
  else if (hasListing) requiresApiKey = fileHas(/^\.env\.example$/) || fileHas(/^\.env\.sample$/);

  let hasInstallScript = null;
  if (INSTALL_RE.test(desc) || (hasListing && (fileHas(/^package\.json$/) || fileHas(/^pyproject\.toml$/) || fileHas(/^install\.sh$/)))) hasInstallScript = true;
  else if (hasListing) hasInstallScript = false;

  return {
    requiresDocker: candidate.requiresDocker ?? requiresDocker,
    requiresApiKey: candidate.requiresApiKey ?? requiresApiKey,
    hasInstallScript: candidate.hasInstallScript ?? hasInstallScript,
    isExperimental: EXPERIMENTAL_RE.test(hay),
    looksLikeAwesome: AWESOME_RE.test(hay) || topics.some((t) => /^awesome/.test(t)),
    hasSkillFile: candidate.hasSkillFile ?? skillSignalsFromFiles(files).rootSkill,
    hasSkillsDir: candidate.hasSkillsDir ?? skillSignalsFromFiles(files).skillsDir,
  };
}

function skillSignalsFromFiles(files = []) {
  const lower = files.map((f) => String(f).toLowerCase());
  return {
    rootSkill: lower.length ? lower.includes('skill.md') : null,
    skillsDir: lower.length ? lower.includes('skills') : null,
  };
}

/* ------------------------------------------------------------------ *
 * 分类
 * ------------------------------------------------------------------ */

const SKILL_RE = /\b(skill|skills|skill\.md|agent skill)\b/i;
const MCP_RE = /\b(mcp|model context protocol|mcp server)\b/i;
const DSH_RE = /\b(dsh|deepseek[- ]harness|cordis|dsh-plugin|agent preset|bundle patch)\b/i;
const AGENT_RE = /\b(agent|agents|ai-agent|claude[- ]code|codex|cursor|opencode|copilot|llm|gpt|subagent|autonomous)\b/i;

/**
 * 分类优先级：dsh-plugin > mcp > skill > agent-tool > content-ref > other
 * （越具体的生态信号越优先）
 */
export function classifyCandidate(c = {}) {
  const topics = (c.topics || []).map((t) => String(t).toLowerCase());
  const desc = String(c.description || '');
  const name = String(c.name || '');
  const hay = `${name} ${c.fullName || ''} ${desc} ${topics.join(' ')}`;
  // “是技能包”的证据要结构性：根目录 SKILL.md、skills 目录、名字带 skill、
  // 明确的 skill 主题，或描述里“a skill for / skill pack”这种句式。
  const skillTopic = topics.some((t) => /^(agent-skills?|ai-skills?|skills?)$/.test(t));
  const skillName = /skill/i.test(name);
  const skillDesc = /\b(agent skills?|skills? (?:pack|collection|for)|a skill (?:that|to|for))\b/i.test(desc);
  const hasSkill = c.hasSkillFile === true || c.hasSkillsDir === true || skillTopic || skillName || skillDesc;
  const awesome = c.looksLikeAwesome === true || AWESOME_RE.test(hay) || topics.some((t) => /^awesome/.test(t));
  const mcpish = MCP_RE.test(hay) || topics.includes('mcp') || topics.some((t) => /^mcp[-_]/.test(t)) || /mcp/i.test(name);
  const dshish = DSH_RE.test(hay) || topics.some((t) => /dsh|cordis/.test(t));
  const agentish = AGENT_RE.test(hay) || topics.some((t) => /agent|llm|claude|codex/.test(t));

  if (dshish) return 'dsh-plugin';
  // “清单/合集”（awesome-*、HN 讨论）本质是内容参考，不是能直接装的东西
  if (c.kind === 'hn' || awesome) return 'content-ref';
  if (mcpish) return 'mcp';
  if (hasSkill) return 'skill';
  if (agentish) return 'agent-tool';
  return 'other';
}

/* ------------------------------------------------------------------ *
 * 打分（确定性，可测）
 * ------------------------------------------------------------------ */

export function heatScore(c = {}) {
  let h = 0;
  const stars = num(c.stars);
  if (stars !== null && stars > 0) h += clamp(Math.log10(stars + 1) * 9, 0, 40);
  const today = num(c.starsToday);
  if (today !== null && today > 0) h += clamp(today / 12, 0, 22);
  const hn = num(c.hnPoints);
  if (hn !== null && hn > 0) h += clamp(hn / 30, 0, 12);
  if (c.trendingRank !== null && c.trendingRank !== undefined) h += 6;
  return clamp(h, 0, 60);
}

export function freshnessScore(c = {}, now = new Date()) {
  const days = daysBetween(c.createdAt, now);
  if (days === null) return 6;
  if (days <= 7) return 20;
  if (days <= 30) return 16;
  if (days <= 90) return 11;
  if (days <= 180) return 7;
  if (days <= 365) return 3;
  return 0;
}

export function usabilityScore(c = {}) {
  let u = 0;
  const lc = licenseClass(c.license);
  if (lc === 'permissive') u += 12;
  else if (lc === 'copyleft' || lc === 'other') u += 4;
  else u -= 6; // 无许可证 = 不能用/不可再分发
  if (c.requiresDocker === true) u -= 8; else if (c.requiresDocker === false) u += 8;
  if (c.requiresApiKey === true) u -= 10; else if (c.requiresApiKey === false) u += 6;
  if (c.archived === true) u -= 25;
  if (c.hasInstallScript === true) u += 5;
  if (c.hasSkillFile === true) u += 6;
  return u;
}

export function riskScore(c = {}) {
  let r = 0;
  if (c.archived === true) r -= 15;
  if (!c.description) r -= 5;
  if ((num(c.stars) ?? 0) < 50 && (c.trendingRank ?? null) === null) r -= 5;
  if (c.isExperimental) r -= 6;
  if (c.looksLikeAwesome) r -= 4;
  if (c.requiresApiKey === true) r -= 4; // 有 key 就有成本/合规风险
  if (c.license === null || c.license === undefined) r -= 3;
  return r;
}

/**
 * 总分 = 热度 + 新鲜度 + 本地可用性 + 风险，clamp 到 0..100。
 * 返回 breakdown 方便排查“为什么它排第一”。
 */
export function scoreCandidate(c = {}, opts = {}) {
  const now = opts.now || new Date();
  const enriched = { ...c, ...extractSignals(c) };
  const heat = heatScore(enriched);
  const freshness = freshnessScore(enriched, now);
  const usability = usabilityScore(enriched);
  const risk = riskScore(enriched);
  const score = clamp(Math.round(heat + freshness + usability + risk), 0, 100);
  return {
    score,
    breakdown: {
      heat: round1(heat),
      freshness,
      usability,
      risk,
      // 便于人工核对：分数由哪些观察值算出
      observed: {
        stars: num(enriched.stars),
        starsToday: num(enriched.starsToday),
        hnPoints: num(enriched.hnPoints),
        trendingRank: enriched.trendingRank ?? null,
        license: enriched.license ?? null,
        licenseClass: licenseClass(enriched.license),
        ageDays: daysBetween(enriched.createdAt, now),
        archived: enriched.archived ?? null,
        requiresDocker: enriched.requiresDocker,
        requiresApiKey: enriched.requiresApiKey,
        hasInstallScript: enriched.hasInstallScript,
        hasSkillFile: enriched.hasSkillFile,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 建议动作
 * ------------------------------------------------------------------ */

/**
 * “值得做一期视频”的判定：只认“当下正在爆”的信号，不认单纯的历史星数。
 *   - 单日涨星 ≥ 250（trending 给的今日新增）
 *   - HN 讨论 ≥ 400 分
 *   - 90 天内新建且已 ≥ 2 万星（真爆发，而不是老牌大仓）
 */
export function isVideoWorthy(c = {}) {
  const today = num(c.starsToday) ?? 0;
  const stars = num(c.stars) ?? 0;
  const hn = num(c.hnPoints) ?? 0;
  const ageDays = c.breakdown?.observed?.ageDays ?? daysBetween(c.createdAt, new Date());
  const freshBreakout = ageDays !== null && ageDays <= 90 && stars >= 20000;
  return today >= 250 || hn >= 400 || freshBreakout;
}

export function recommendAction(c = {}) {
  const cats = c.category || classifyCandidate(c);
  const stars = num(c.stars) ?? 0;
  const hn = num(c.hnPoints) ?? 0;
  if (c.archived === true) return 'skip';
  if ((c.score ?? 0) < 25) return 'skip';

  const videoWorthy = isVideoWorthy(c);
  if (cats === 'mcp') {
    if (c.license === null || c.license === undefined) return videoWorthy ? 'media-content' : 'watch'; // 无许可证别照着装
    return videoWorthy ? 'media-content' : 'install-mcp';
  }
  if (cats === 'skill') {
    const skillish = c.hasSkillFile === true || c.hasSkillsDir === true;
    if (skillish) return videoWorthy ? 'media-content' : 'draft-skill';
    return videoWorthy ? 'media-content' : 'watch';
  }
  if (cats === 'content-ref') return hn >= 300 || videoWorthy ? 'media-content' : 'watch';
  if (cats === 'dsh-plugin') return videoWorthy ? 'media-content' : 'watch'; // 兼容性要人工评估
  if (cats === 'agent-tool') return videoWorthy ? 'media-content' : (stars >= 3000 ? 'watch' : 'watch');
  if (cats === 'other') return videoWorthy ? 'media-content' : 'watch';
  return 'watch';
}

/** 诚实版的安装/试用命令：只用观察得到的事实，不猜包名 */
export function installCommandFor(c = {}) {
  if (!c.fullName) return null;
  const url = c.url || `https://github.com/${c.fullName}`;
  if (c.category === 'skill' && (c.hasSkillFile === true || c.hasSkillsDir === true)) {
    return [
      `git clone ${url}.git`,
      c.hasSkillFile === true
        ? `# 仓库根目录含 SKILL.md：把仓库目录放进你的 skills 路径（如 ~/.claude/skills/${c.name}/，按你实际配置调整）`
        : '# 仓库含 skills 目录：进入子目录挑具体技能，按你的 skills 路径挂载',
    ].join('\n');
  }
  if (c.category === 'mcp') {
    return [
      `git clone ${url}.git`,
      c.hasInstallScript === true
        ? '# 仓库含 package.json / install 脚本：按 README 安装后，把 MCP server 配置加进客户端'
        : '# 按 README 将 MCP server 配置加进客户端',
    ].join('\n');
  }
  return [`git clone ${url}.git`, '# 先读 README 的安装段；本项目没有给出可验证的一键安装命令'].join('\n');
}

/* ------------------------------------------------------------------ *
 * 日增量 / 状态
 * ------------------------------------------------------------------ */

/** 没有历史就返回 null（第一次见），否则返回 max(0, 当前-上次) */
export function computeStarsDelta(candidate, seen = {}) {
  const key = String(candidate.fullName || '').toLowerCase();
  const prev = seen[key] ?? seen[candidate.fullName];
  const cur = num(candidate.stars);
  if (!prev || num(prev.stars) === null || cur === null) return null;
  return Math.max(0, cur - num(prev.stars));
}

/**
 * 用本次结果更新 seen 状态：返回新 seen 与每人 delta。
 * 结构：{ "owner/repo": { stars, starsToday, firstSeen, lastSeen, pushedOn, score } }
 */
export function updateSeen(seen = {}, candidates = [], date, opts = {}) {
  const markPushed = opts.markPushed !== false;
  const next = { ...seen };
  const deltas = {};
  for (const c of candidates) {
    const key = String(c.fullName || '').toLowerCase();
    if (!key) continue;
    const prev = next[key] || {};
    const delta = computeStarsDelta(c, next);
    deltas[key] = delta;
    next[key] = {
      stars: num(c.stars),
      starsToday: num(c.starsToday),
      firstSeen: prev.firstSeen || date,
      lastSeen: date,
      pushedOn: markPushed && opts.pushed ? date : prev.pushedOn ?? null,
      score: c.score ?? null,
      category: c.category ?? null,
    };
  }
  return { seen: next, deltas };
}

/** 当日是否已经推送过（幂等：cron 一天跑两次不该推两遍） */
export function wasDelivered(deliveryState, date) {
  return Boolean(deliveryState && deliveryState.date === date && deliveryState.deliveredAt);
}

/* ------------------------------------------------------------------ *
 * 媒体选题包
 * ------------------------------------------------------------------ */

export function videoScore(c = {}) {
  const heat = heatScore(c);
  const today = num(c.starsToday) ?? 0;
  const stars = num(c.stars) ?? 0;
  const hn = num(c.hnPoints) ?? 0;
  let v = heat;
  v += clamp(today / 20, 0, 15);
  v += clamp(hn / 50, 0, 10);
  if (c.trendingRank !== null && c.trendingRank !== undefined && c.trendingRank <= 5) v += 5;
  if (c.requiresApiKey === false) v += 3;
  if (c.hasSkillFile === true) v += 2;
  if (c.archived === true) v -= 30;
  return round1(v);
}

const CATEGORY_LABEL = {
  mcp: 'MCP 生态',
  skill: 'Skill / 技能包',
  'dsh-plugin': 'DSH 插件',
  'agent-tool': 'Agent 工具',
  'content-ref': '内容参考',
  other: '其他',
};

const pickAccount = (c) => {
  const today = num(c.starsToday) ?? 0;
  const stars = num(c.stars) ?? 0;
  if (today >= 400 || (c.hnPoints ?? 0) >= 500) return { id: 'shorts', label: ACCOUNTS.shorts, reason: '单日涨星/讨论热度极高，适合 60 秒速览抢时效' };
  if (stars >= 20000 || c.category === 'dsh-plugin' || c.category === 'mcp') {
    return { id: 'main', label: ACCOUNTS.main, reason: '有生态位/可深挖原理与接入方式' };
  }
  return { id: 'roundup', label: ACCOUNTS.roundup, reason: '单点信息量不足以撑长视频，适合并进工具盘点' };
};

function tagsFor(c = {}) {
  const t = new Set(['#GitHub', '#开源']);
  const byCat = { mcp: '#MCP', skill: '#Skill', 'dsh-plugin': '#DSH', 'agent-tool': '#AIAgent', 'content-ref': '#技术趋势', other: '#工具' };
  if (byCat[c.category]) t.add(byCat[c.category]);
  if (c.language) t.add('#' + String(c.language).replace(/[^\w+#.-]/g, ''));
  for (const topic of (c.topics || []).slice(0, 3)) {
    const tag = String(topic).replace(/[^\w-]/g, '');
    if (tag) t.add('#' + tag);
  }
  return [...t].join(' ');
}

const nOr = (v, fallback) => (v === null || v === undefined || v === '' ? fallback : v);

/** 生成一条选题包（纯模板，不编造数字；未知就写“未取到”） */
export function buildMediaBrief(c = {}, index = 1) {
  const stars = num(c.stars);
  const today = num(c.starsToday);
  const hn = num(c.hnPoints) ?? 0;
  const account = pickAccount(c);
  const starsTxt = stars === null ? '未取到' : stars.toLocaleString('en-US');
  const todayTxt = today === null ? '未取到' : `+${today.toLocaleString('en-US')}/天`;
  const desc = c.description ? truncate(c.description, 110) : '（仓库无简介，拍摄前先读 README）';

  const angle =
    today !== null && today >= 300
      ? `一天涨 ${today.toLocaleString('en-US')} 星`
      : hn >= 400
        ? `HN ${hn} 分讨论`
        : stars !== null && stars >= 20000
          ? `${starsTxt} 星的成熟项目`
          : `${CATEGORY_LABEL[c.category] || '新品'}里冒出来的新东西`;

  const title = truncate(
    `GitHub 上${angle}：${c.fullName} 到底是什么，普通人能用吗？`,
    56,
  );

  const hook =
    `“${c.fullName}” ${starsTxt} 星、${todayTxt}，${desc} ` +
    `但它到底解决你什么问题？我用 ${c.category === 'skill' ? '一份技能目录' : '一条命令'} 说清楚。`;

  const structure = [
    {
      at: '0–8 秒',
      what: `抛出反差：${angle}，但多数人装完并不会用 —— 先给结论：${c.category === 'mcp' ? '它给你的 AI 客户端加一个可调用的工具口' : c.category === 'skill' ? '它是给 agent 的一份可复用技能说明' : '它把一件重复的事情自动化了'}`,
    },
    {
      at: '8–40 秒',
      what: `现场演示：${c.requiresDocker === true ? 'docker 起服务 → 配置 → 第一次调用' : c.requiresApiKey === true ? '填 key → 配置 → 第一次调用（顺带说清成本）' : '克隆 → 配置 → 第一次调用'}；只展示真实抓到的数字：${starsTxt} 星 / ${todayTxt}`,
    },
    {
      at: '40–60 秒',
      what: `结论 + 门槛：${c.requiresDocker === true ? '需要 Docker' : c.requiresDocker === false ? '不需要 Docker' : 'Docker 需求未确认'}、${c.requiresApiKey === true ? '需要 API Key（有成本）' : c.requiresApiKey === false ? '不需要外部 Key' : 'Key 需求未确认'}、许可证 ${nOr(c.license, '未取到')}；建议动作：${c.action}`,
    },
  ];

  const shots = [
    `仓库首页（${c.url}）录屏 3 秒：星标数、最近提交时间`,
    `README 里「安装 / Quick start」那一段的放大特写`,
    c.hasSkillFile === true ? '仓库根目录 SKILL.md 的文件树镜头' : '仓库根目录文件树（确认有没有 Dockerfile / package.json）',
    `终端里真实执行：${(installCommandFor(c) || 'git clone …').split('\n')[0]}`,
    '最终效果对比镜头（用之前 / 用之后）',
  ];

  return {
    rank: index,
    fullName: c.fullName,
    url: c.url,
    category: c.category,
    action: c.action,
    score: c.score,
    videoScore: videoScore(c),
    account,
    title,
    hook,
    structure,
    shots,
    tags: tagsFor(c),
    facts: {
      stars,
      starsToday: today,
      starsDelta: c.starsDelta ?? null,
      language: nOr(c.language, null),
      license: nOr(c.license, null),
      pushedAt: nOr(c.pushedAt, null),
      archived: c.archived ?? null,
      hnPoints: hn || null,
    },
    note: '所有数字来自本次抓取；未取到的字段写 null，不要口播未取到的数字。',
  };
}

export function buildMediaBriefs(candidates = [], limit = 3) {
  return candidates
    .filter((c) => c.kind !== 'hn')
    .slice()
    .sort((a, b) => (b.videoScore ?? videoScore(b)) - (a.videoScore ?? videoScore(a)) || (num(b.stars) ?? 0) - (num(a.stars) ?? 0))
    .slice(0, limit)
    .map((c, i) => buildMediaBrief(c, i + 1));
}

export function renderMediaBriefs(briefs = [], meta = {}) {
  const lines = [];
  lines.push(`# 媒体选题包 · ${meta.date || ''}`);
  lines.push('');
  lines.push(`> 自动生成（无 LLM）。候选池 ${meta.candidateCount ?? '?'} 个，按“视频感”取前 ${briefs.length} 个。`);
  lines.push('> 规则：只允许口播本文件中 `facts` 里的数字；`null` 表示未取到，不要编。');
  lines.push('');
  if (!briefs.length) {
    lines.push('_本次没有可用候选，未生成选题。_');
    return lines.join('\n') + '\n';
  }
  for (const b of briefs) {
    lines.push(`## ${b.rank}. [${b.fullName}](${b.url})`);
    lines.push('');
    lines.push(`- **分类**：${CATEGORY_LABEL[b.category] || b.category} ｜ **评分** ${b.score} ｜ **视频感** ${b.videoScore} ｜ **建议动作** ${b.action}`);
    lines.push(`- **标题**：${b.title}`);
    lines.push(`- **30 秒钩子**：${b.hook}`);
    lines.push('- **三段结构**：');
    for (const s of b.structure) lines.push(`  - \`${s.at}\` ${s.what}`);
    lines.push('- **需要的画面素材**：');
    for (const s of b.shots) lines.push(`  - ${s}`);
    lines.push(`- **标签**：${b.tags}`);
    lines.push(`- **适合账号**：${b.account.label} —— ${b.account.reason}`);
    lines.push(`- **事实核对（只能引用这些）**：stars=${b.facts.stars ?? 'null'} / starsToday=${b.facts.starsToday ?? 'null'} / starsDelta=${b.facts.starsDelta ?? 'null'} / language=${b.facts.language ?? 'null'} / license=${b.facts.license ?? 'null'} / pushedAt=${b.facts.pushedAt ?? 'null'} / archived=${b.facts.archived ?? 'null'} / hnPoints=${b.facts.hnPoints ?? 'null'}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(`_账号口径在 \`radar.mjs\` 的 \`ACCOUNTS\` 常量里，一行可改。_`);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Markdown / Digest
 * ------------------------------------------------------------------ */

const fmtStars = (v) => (num(v) === null ? '—' : num(v).toLocaleString('en-US'));
const fmtDelta = (v) => (v === null || v === undefined ? '—' : `+${v.toLocaleString('en-US')}`);
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');

export function renderRadarMarkdown(radar) {
  const { date, candidates = [], sources = {}, stats = {}, hn = [] } = radar;
  const top = candidates.slice(0, radar.limit || 20);
  const L = [];
  L.push(`# GitHub 涨星雷达 · ${date}`);
  L.push('');
  L.push(`> 生成：${radar.generatedAt} ｜ 候选 ${candidates.length} 个 ｜ 本表 Top ${top.length}`);
  L.push(`> 源状态：${Object.entries(sources).map(([k, v]) => `${k}=${v.ok ? 'ok' : v.skipped ? 'skip' : 'fail'}(${v.count ?? 0})`).join(' · ')}`);
  L.push('');
  L.push('## Top ' + top.length);
  L.push('');
  L.push('| # | 仓库 | 语言 | 总星 | 今日 + | 较上次 | 分数 | 分类 | 建议动作 |');
  L.push('|---:|---|---|---:|---:|---:|---:|---|---|');
  top.forEach((c, i) => {
    L.push(`| ${i + 1} | [${c.fullName}](${c.url}) | ${c.language || '—'} | ${fmtStars(c.stars)} | ${fmtDelta(c.starsToday)} | ${fmtDelta(c.starsDelta)} | ${c.score} | ${c.category} | ${c.action} |`);
  });
  L.push('');
  L.push('## 分类小节');
  L.push('');
  for (const cat of CATEGORIES) {
    const group = candidates.filter((c) => c.category === cat).slice(0, 8);
    if (!group.length) continue;
    L.push(`### ${CATEGORY_LABEL[cat]}（${candidates.filter((c) => c.category === cat).length}）`);
    L.push('');
    for (const c of group) {
      const bits = [
        c.stars === null ? null : `⭐ ${fmtStars(c.stars)}`,
        c.starsToday === null ? null : `今日 ${fmtDelta(c.starsToday)}`,
        c.starsDelta === null ? null : `较上次 ${fmtDelta(c.starsDelta)}`,
        c.license ? `license ${c.license}` : 'license 未知',
        c.pushedAt ? `最近推送 ${fmtDate(c.pushedAt)}` : null,
        c.archived ? '**已归档**' : null,
        c.hasSkillFile ? '含 SKILL.md' : null,
        c.requiresDocker === true ? '需要 Docker' : null,
        c.requiresApiKey === true ? '需要 API Key' : null,
      ].filter(Boolean).join(' · ');
      L.push(`- **${c.fullName}** — ${c.description ? truncate(c.description, 150) : '（无简介）'}`);
      L.push(`  - ${bits} ｜ 分数 ${c.score} ｜ 建议 **${c.action}**`);
    }
    L.push('');
  }
  if (hn.length) {
    L.push('## HN 讨论热点（源③，站点/文章补充）');
    L.push('');
    for (const h of hn.slice(0, 8)) {
      L.push(`- [${truncate(h.title, 100)}](${h.url || 'https://news.ycombinator.com/item?id=' + h.objectID}) — ${nOr(h.points, '?')} 分 / ${nOr(h.comments, '?')} 评论${h.linkedRepo ? ` ｜ 关联仓库 ${h.linkedRepo}` : ''}`);
    }
    L.push('');
  }
  L.push('## 推荐动作汇总');
  L.push('');
  for (const action of ACTIONS) {
    const group = candidates.filter((c) => c.action === action);
    if (!group.length) continue;
    L.push(`- **${action}**（${group.length}）：${group.slice(0, 6).map((c) => c.fullName).join('、')}`);
  }
  L.push('');
  L.push('## 数据源与告警');
  L.push('');
  for (const [k, v] of Object.entries(sources)) {
    L.push(`- \`${k}\`：${v.ok ? '✅ ok' : v.skipped ? '⏭ 跳过' : '❌ 失败'}，条数 ${v.count ?? 0}${v.note ? ` — ${v.note}` : ''}${v.error ? ` — ${v.error}` : ''}`);
  }
  if (stats.notes?.length) {
    L.push('');
    for (const n of stats.notes) L.push(`- ${n}`);
  }
  L.push('');
  L.push('## 文件');
  L.push('');
  L.push(`- \`out/${date}/radar.json\` 机器可读全量（含 score breakdown）`);
  L.push(`- \`out/${date}/radar.md\` 本文件`);
  L.push(`- \`out/${date}/media-briefs.md\` 视频选题包`);
  L.push(`- \`out/${date}/digest.txt\` Discord 推送摘要`);
  L.push(`- \`out/${date}/candidates/<owner>__<repo>.md\` 单仓库草稿（${stats.candidateDocs ?? 0} 个）`);
  return L.join('\n') + '\n';
}

/**
 * Discord 用的中文摘要：≤1200 码点，纯文本（no-agent cron 直接投递）。
 */
export function buildDigest(radar, opts = {}) {
  const maxChars = opts.maxChars ?? 1200;
  const { date, candidates = [], sources = {}, stats = {} } = radar;
  const mediaBriefs = opts.mediaBriefs ?? radar.mediaBriefs ?? [];
  const delivered = opts.delivered ?? radar.delivered ?? false;
  const failed = Object.entries(sources).filter(([, v]) => !v.ok && !v.skipped).map(([k]) => k);
  const skipped = Object.entries(sources).filter(([, v]) => v.skipped).map(([k]) => k);

  const head = `【GitHub 涨星雷达 ${date}】`;
  if (delivered) {
    return [
      head,
      `今日已推送过，本次不重复推送。候选 ${candidates.length} 个（Top5 与上次一致）。`,
      `如需强制重发：node tools/github-radar/radar.mjs --date ${date} --force`,
    ].join('\n');
  }

  const top = candidates.slice(0, 5);
  const L = [];
  L.push(head);
  L.push(`候选 ${candidates.length} 个 ｜ 源 ${Object.keys(sources).length - failed.length - skipped.length}/${Object.keys(sources).length} 正常${failed.length ? ` ｜ 失败：${failed.join('/')}` : ''}${skipped.length ? ` ｜ 跳过：${skipped.join('/')}` : ''}`);

  if (!top.length) {
    L.push('本次没有抓到可用候选（所有源都失败？看 radar.md 的告警段）。');
    return truncate(L.join('\n'), maxChars);
  }

  L.push('');
  L.push('Top5：');
  top.forEach((c, i) => {
    const today = c.starsToday === null || c.starsToday === undefined ? '' : `（今日+${c.starsToday.toLocaleString('en-US')}）`;
    const delta = c.starsDelta === null || c.starsDelta === undefined ? '' : `（较上次+${c.starsDelta.toLocaleString('en-US')}）`;
    const stars = c.stars === null ? '星数未取到' : `${c.stars.toLocaleString('en-US')}星`;
    L.push(`${i + 1}. ${c.fullName} ${stars}${today}${delta}｜${c.category}｜${c.action}`);
    if (c.description) L.push(`   ${truncate(c.description, 60)}`);
  });

  const byAction = new Map();
  for (const c of candidates) {
    if (!byAction.has(c.action)) byAction.set(c.action, []);
    byAction.get(c.action).push(c);
  }
  L.push('');
  L.push('建议动作：');
  const actionLine = (a, label) => {
    const g = byAction.get(a);
    if (!g?.length) return null;
    return `- ${label} ${g.length} 个：${g.slice(0, 4).map((c) => c.fullName).join('、')}${g.length > 4 ? ' 等' : ''}`;
  };
  const actionLines = [
    actionLine('install-mcp', '试装 MCP'),
    actionLine('draft-skill', '起草 Skill'),
    actionLine('media-content', '可直接做视频'),
    actionLine('watch', '先观察'),
    actionLine('skip', '跳过'),
  ].filter(Boolean);
  L.push(...(actionLines.length ? actionLines : ['- 无']));

  const briefs = (mediaBriefs || []).slice(0, 3);
  if (briefs.length) {
    L.push('');
    L.push('媒体选题线索：');
    for (const b of briefs) L.push(`- ${b.fullName}｜${truncate(b.title, 42)}｜${b.account.label}`);
  }

  if (stats.notes?.length) {
    L.push('');
    for (const n of stats.notes.slice(0, 3)) L.push(`· ${n}`);
  }
  L.push('');
  L.push(`明细：tools/github-radar/out/${date}/radar.md`);

  let text = L.join('\n');
  if (codePointLength(text) > maxChars) {
    // 先删描述行，再删明细行，保证结构（Top5+动作+选题）优先
    const lines = L.filter((l) => !/^   /.test(l));
    text = lines.join('\n');
  }
  if (codePointLength(text) > maxChars) text = truncate(text, maxChars);
  return text;
}

/** 单仓库草稿文档（供后续人工/DSH 会话升级学习） */
export function renderCandidateDoc(c = {}, meta = {}) {
  const L = [];
  L.push(`# ${c.fullName}`);
  L.push('');
  L.push(`- 链接：${c.url}`);
  L.push(`- 抓取日期：${meta.date || ''} ｜ 来源：${(c.sources || []).join(', ')}`);
  L.push(`- 分类：${c.category} ｜ 建议动作：**${c.action}** ｜ 评分：${c.score}（热度 ${c.breakdown?.heat} / 新鲜 ${c.breakdown?.freshness} / 可用 ${c.breakdown?.usability} / 风险 ${c.breakdown?.risk}）`);
  L.push('');
  L.push('## 是什么');
  L.push('');
  L.push(c.description ? c.description : '（仓库无简介，需要人工读 README）');
  L.push('');
  L.push('## 观察到的数据');
  L.push('');
  L.push('| 字段 | 值 |');
  L.push('|---|---|');
  const rows = [
    ['stars', fmtStars(c.stars)],
    ['今日新增', fmtDelta(c.starsToday)],
    ['较上次', fmtDelta(c.starsDelta)],
    ['forks', fmtStars(c.forks)],
    ['语言', c.language ?? '—'],
    ['license', c.license ?? '未取到'],
    ['创建', fmtDate(c.createdAt)],
    ['最近推送', fmtDate(c.pushedAt)],
    ['archived', c.archived === null || c.archived === undefined ? '未知' : String(c.archived)],
    ['topics', (c.topics || []).join(', ') || '—'],
    ['SKILL.md', c.hasSkillFile === null || c.hasSkillFile === undefined ? '未确认' : String(c.hasSkillFile)],
    ['需要 Docker', c.requiresDocker === null || c.requiresDocker === undefined ? '未确认' : String(c.requiresDocker)],
    ['需要 API Key', c.requiresApiKey === null || c.requiresApiKey === undefined ? '未确认' : String(c.requiresApiKey)],
    ['HN 讨论分', c.hnPoints ?? '—'],
  ];
  for (const [k, v] of rows) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## 为什么值得看');
  L.push('');
  const why = [];
  if (c.starsToday) why.push(`今天上了 trending，单日 +${c.starsToday.toLocaleString('en-US')} 星，是当下正在被讨论的东西。`);
  if (c.stars && c.stars >= 10000) why.push(`总星 ${fmtStars(c.stars)}，说明不是三天热度的玩具。`);
  if (c.createdAt) why.push(`创建于 ${fmtDate(c.createdAt)}（${c.breakdown?.observed?.ageDays ?? '?'} 天前），新鲜度分 ${c.breakdown?.freshness}。`);
  if (c.hasSkillFile) why.push('仓库自带 SKILL.md，可以直接当技能包评估。');
  if (c.category === 'mcp') why.push('属于 MCP 生态，能直接接进支持 MCP 的客户端。');
  if (!why.length) why.push('数据有限，先观察。');
  L.push(...why.map((w) => `- ${w}`));
  L.push('');
  L.push('## 真实安装/试用命令');
  L.push('');
  L.push('```bash');
  L.push(installCommandFor(c) || `git clone ${c.url}.git`);
  L.push('```');
  L.push('');
  L.push('## 风险');
  L.push('');
  const risks = [];
  if (c.archived) risks.push('仓库已归档，可能不再维护。');
  if (!c.license) risks.push('没有可识别的许可证 —— 默认不能合法复用代码，先确认 LICENSE。');
  if (c.license && licenseClass(c.license) === 'copyleft') risks.push(`许可证 ${c.license} 是 copyleft，公司内部使用前确认合规。`);
  if (c.requiresDocker) risks.push('需要 Docker/容器环境。');
  if (c.requiresApiKey) risks.push('需要外部 API Key，有成本/合规问题。');
  if (c.isExperimental) risks.push('描述里出现 experimental/alpha 之类字样，接口可能变。');
  if ((c.breakdown?.observed?.ageDays ?? 999) < 30) risks.push('非常新的仓库，star 数可能含推广水分。');
  if (!risks.length) risks.push('未发现明显风险信号（但也说明没做深度审查）。');
  L.push(...risks.map((r) => `- ${r}`));
  L.push('');
  L.push('## 建议');
  L.push('');
  L.push(`- 动作：**${c.action}**（分类 ${c.category}，分数 ${c.score}）`);
  L.push(`- 下一步：${c.action === 'install-mcp' ? '本地装一次，确认能连上客户端再决定是否写进工具库。' : c.action === 'draft-skill' ? '读 SKILL.md，抽成本地 skill 草稿。' : c.action === 'media-content' ? '优先做视频：素材见 media-briefs.md。' : c.action === 'skip' ? '本轮跳过，理由见风险段。' : '先观察 3–7 天，看 star 曲线是否持续。'}`);
  L.push('');
  L.push(`<!-- generated by tools/github-radar/radar.mjs · schema ${SCHEMA_VERSION} -->`);
  return L.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * 令牌（只在内存里）
 * ------------------------------------------------------------------ */

/**
 * 令牌优先级：GITHUB_TOKEN → GH_TOKEN → macOS keychain(git credential-osxkeychain)。
 * 任何时候都不打印、不写文件、不拼进 URL。
 */
export function loadToken(env = process.env, opts = {}) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (opts.noKeychain) return null;
  try {
    const out = execFileSync('git', ['credential-osxkeychain', 'get'], {
      input: 'host=github.com\n\n',
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = String(out).match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 抓取层（网络 / fixture 双通道）
 * ------------------------------------------------------------------ */

export class RateLimitError extends Error {}
export class SourceError extends Error {}

const FIXTURE_FILE_RE = /^[A-Za-z0-9._-]+$/;

export function createFetcher(opts = {}) {
  const { offline = false, fixturesDir, token = null, timeoutMs = 20000, logger = () => {} } = opts;
  const stats = { requests: 0, failures: 0, rateLimited: false, cacheHits: 0 };
  const cache = new Map();

  function fixturePath(name) {
    if (!FIXTURE_FILE_RE.test(name)) throw new Error(`非法 fixture 名: ${name}`);
    return path.join(fixturesDir, name);
  }

  async function readFixture(name, { binary = false } = {}) {
    const p = fixturePath(name);
    try {
      const buf = await fsp.readFile(p, binary ? undefined : 'utf8');
      return buf;
    } catch (err) {
      throw new SourceError(`fixture 缺失: ${path.basename(p)}`);
    }
  }

  async function httpGet(url, headers = {}) {
    if (cache.has(url)) {
      stats.cacheHits += 1;
      return cache.get(url);
    }
    const attempts = 3;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        stats.requests += 1;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'github-radar/1.0 (+node)', ...headers },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'follow',
        });
        const text = await res.text();
        if (res.status === 403 || res.status === 429) {
          const remaining = res.headers.get('x-ratelimit-remaining');
          if (remaining === '0' || /rate limit/i.test(text)) {
            stats.rateLimited = true;
            throw new RateLimitError(`HTTP ${res.status} 限流（remaining=${remaining ?? '?'}）`);
          }
        }
        if (res.status >= 500 && i < attempts - 1) {
          lastErr = new SourceError(`HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 250 * (i + 1)));
          continue;
        }
        if (!res.ok) throw new SourceError(`HTTP ${res.status} ${truncate(text.replace(/\s+/g, ' '), 140)}`);
        const result = { text, status: res.status, headers: res.headers };
        cache.set(url, result);
        return result;
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        lastErr = err;
        if (i < attempts - 1 && !/HTTP 4\d\d/.test(String(err.message))) {
          await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        } else break;
      }
    }
    stats.failures += 1;
    throw lastErr instanceof Error ? lastErr : new SourceError(String(lastErr));
  }

  const githubHeaders = () => {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) h.Authorization = `token ${token}`;
    return h;
  };

  return {
    stats,
    offline,
    /** 源①：trending HTML */
    async trending() {
      if (offline) return readFixture('trending.html');
      const { text } = await httpGet(TRENDING_URL, { Accept: 'text/html' });
      return text;
    },
    /** 源②：search API（q 决定 fixture 名） */
    async searchRepos(query, { label = 'search-created', perPage = DEFAULTS.searchPerPage } = {}) {
      if (offline) {
        const name = `search-${label.replace(/^search-/, '')}.json`;
        return JSON.parse(String(await readFixture(name)));
      }
      const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
      const { text } = await httpGet(url, githubHeaders());
      return JSON.parse(text);
    },
    /** 源③：HN Algolia */
    async hn(keyword, { perPage = DEFAULTS.hnPerPage } = {}) {
      if (offline) return JSON.parse(String(await readFixture(`hn-${slugify(keyword)}.json`)));
      const url = `${HN_API}?query=${encodeURIComponent(keyword)}&tags=story&numericFilters=${encodeURIComponent('points>150')}&hitsPerPage=${perPage}`;
      const { text } = await httpGet(url, { Accept: 'application/json' });
      return JSON.parse(text);
    },
    /** 单仓库元数据（trending 来的候选需要补 license/pushed_at/topics 等） */
    async repo(fullName) {
      const [owner, name] = String(fullName).split('/');
      if (!owner || !name) throw new SourceError(`非法仓库名 ${fullName}`);
      if (offline) return JSON.parse(String(await readFixture(`repo-${repoSafeName(fullName)}.json`)));
      const { text } = await httpGet(`${GITHUB_API}/repos/${owner}/${name}`, githubHeaders());
      return JSON.parse(text);
    },
    /** 根目录 contents（探测 SKILL.md / Dockerfile / package.json 等；失败跳过） */
    async rootContents(fullName) {
      const [owner, name] = String(fullName).split('/');
      if (offline) return JSON.parse(String(await readFixture(`contents-${repoSafeName(fullName)}.json`)));
      const { text } = await httpGet(`${GITHUB_API}/repos/${owner}/${name}/contents/`, githubHeaders());
      return JSON.parse(text);
    },
  };
}

/** contents 响应 → 文件名列表 */
export function fileNamesFromContents(json) {
  if (!Array.isArray(json)) return [];
  return json
    .map((e) => (e && typeof e.name === 'string' ? e.name : null))
    .filter(Boolean);
}

/** repo 元数据响应 → 候选补丁 */
export function repoMetaFromApi(json = {}) {
  return {
    stars: num(json.stargazers_count),
    forks: num(json.forks_count),
    language: json.language || null,
    description: json.description || null,
    topics: Array.isArray(json.topics) ? json.topics : [],
    license: json.license?.spdx_id || json.license?.key || null,
    createdAt: json.created_at || null,
    pushedAt: json.pushed_at || null,
    archived: typeof json.archived === 'boolean' ? json.archived : null,
    homepage: json.homepage || null,
    openIssues: num(json.open_issues_count),
  };
}

/* ------------------------------------------------------------------ *
 * 采集 + 打分编排
 * ------------------------------------------------------------------ */

export function buildSearchQueries(now = new Date()) {
  const since = new Date(now.getTime() - SEARCH_CREATED_DAYS * 86400000).toISOString().slice(0, 10);
  return [
    { label: 'search-created', query: `created:>${since} stars:>150` },
    ...SEARCH_TOPICS.map((t) => ({ label: `search-topic-${t}`, query: `topic:${t} stars:>100` })),
  ];
}

/**
 * 主采集流程。任何源失败都只记入 sources 报告，不抛出。
 */
export async function collect(options = {}) {
  const {
    date = localDateString(),
    now = new Date(),
    offline = false,
    fixturesDir = path.join(BASE_DIR, 'test', 'fixtures'),
    token = null,
    noHn = false,
    probe = DEFAULTS.probe,
    limit = DEFAULTS.limit,
    logger = () => {},
  } = options;

  const fetcher = createFetcher({ offline, fixturesDir, token, logger });
  const sources = {};
  const noteList = [];

  const record = (key, patch) => {
    sources[key] = { ok: false, count: 0, note: '', error: '', skipped: false, ...(sources[key] || {}), ...patch };
  };
  const failMsg = (err) => redact(truncate(err?.message || String(err), 200), token);

  // ---- 源① trending
  let trending = [];
  record('trending', {});
  try {
    const html = await fetcher.trending();
    trending = parseTrendingHtml(html);
    record('trending', { ok: true, count: trending.length, note: `解析到 ${trending.length} 个仓库` });
    logger(`[trending] ok: ${trending.length}`);
  } catch (err) {
    record('trending', { ok: false, error: failMsg(err) });
    noteList.push(`trending 源失败：${failMsg(err)}（不影响其它源）`);
    logger(`[trending] fail: ${failMsg(err)}`);
  }

  // ---- 源② search
  const searchGroups = [];
  const queries = buildSearchQueries(now);
  for (const q of queries) {
    record(q.label, {});
    if (fetcher.stats.rateLimited) {
      record(q.label, { ok: false, skipped: true, error: '已触发 API 限流，跳过剩余检索' });
      continue;
    }
    try {
      const json = await fetcher.searchRepos(q.query, { label: q.label });
      const items = parseSearchResponse(json, q.label);
      searchGroups.push(items);
      record(q.label, { ok: true, count: items.length, note: q.query });
      logger(`[${q.label}] ok: ${items.length}`);
    } catch (err) {
      record(q.label, { ok: false, error: failMsg(err) });
      noteList.push(`${q.label} 检索失败：${failMsg(err)}`);
      logger(`[${q.label}] fail: ${failMsg(err)}`);
    }
  }

  // ---- 源③ HN
  let hnStories = [];
  record('hn', {});
  if (noHn) {
    record('hn', { ok: false, skipped: true, note: '--no-hn' });
  } else {
    const all = [];
    let hnOkCount = 0;
    for (const kw of HN_KEYWORDS) {
      try {
        const json = await fetcher.hn(kw);
        const parsed = parseHnResponse(json, kw);
        all.push(...parsed);
        hnOkCount += 1;
        record('hn', { ok: true, count: all.length, note: `关键词 ${HN_KEYWORDS.join('/')}（累计去重前 ${all.length}）` });
      } catch (err) {
        record('hn', { ok: all.length > 0, count: all.length, error: failMsg(err), note: all.length ? '部分关键词失败' : '' });
        noteList.push(`HN 关键词 ${kw} 失败：${failMsg(err)}`);
        logger(`[hn:${kw}] fail: ${failMsg(err)}`);
      }
    }
    // 同一 story 可能被多个关键词命中
    const byId = new Map();
    for (const s of all) {
      const key = s.objectID || s.title;
      const prev = byId.get(key);
      if (!prev) byId.set(key, s);
      else byId.set(key, { ...prev, keywords: [...new Set([...(prev.keywords || []), ...(s.keywords || [])])] });
    }
    hnStories = [...byId.values()].sort((a, b) => (num(b.points) ?? 0) - (num(a.points) ?? 0));
    record('hn', {
      ok: hnOkCount > 0,
      count: hnStories.length,
      note: hnOkCount > 0 ? `去重后 ${hnStories.length} 条（${hnOkCount}/${HN_KEYWORDS.length} 关键词成功）` : '全部关键词失败',
      skipped: hnOkCount === 0,
    });
  }

  // ---- 合并仓库候选（trending + search）
  // 注意：这里先不提取可用性信号 —— 要等根目录探测完再算，否则“没探测”会被误判成“没有”。
  let candidates = mergeCandidates([trending, ...searchGroups]);

  // ---- HN → 仓库关联（给对应仓库加 hnPoints）
  const hnByRepo = new Map();
  for (const story of hnStories) {
    const repo = repoFromUrl(story.url);
    story.linkedRepo = repo;
    if (!repo) continue;
    const key = repo.toLowerCase();
    const prev = hnByRepo.get(key);
    if (!prev || (num(story.points) ?? 0) > (num(prev.points) ?? 0)) hnByRepo.set(key, story);
  }
  candidates = candidates.map((c) => {
    const hit = hnByRepo.get(c.fullName.toLowerCase());
    if (!hit) return c;
    return { ...c, hnPoints: num(hit.points), hnUrls: [hit.url].filter(Boolean) };
  });

  // ---- 补元数据：trending 来的候选缺 license/pushedAt/topics
  record('metadata', {});
  const needMeta = candidates.filter((c) => c.license === undefined || c.pushedAt === undefined || c.topics === undefined || c.topics === null);
  let metaOk = 0;
  for (const c of needMeta) {
    if (fetcher.stats.rateLimited) break;
    try {
      const meta = repoMetaFromApi(await fetcher.repo(c.fullName));
      Object.assign(c, {
        ...meta,
        topics: meta.topics.length ? meta.topics : c.topics || [],
        description: c.description || meta.description,
        stars: meta.stars ?? c.stars, // API 的值更权威；trending 解析值仅兜底
      });
      metaOk += 1;
    } catch {
      /* 补不到就留 null，不致命 */
    }
  }
  record('metadata', { ok: metaOk > 0 || needMeta.length === 0, count: metaOk, note: needMeta.length ? `需补 ${needMeta.length}，成功 ${metaOk}` : '无需补全' });

  // ---- 根目录探测（SKILL.md / Dockerfile / package.json），只探前面的候选
  record('contents', {});
  const probeTargets = candidates
    .slice()
    .sort((a, b) => heatScore(b) - heatScore(a))
    .slice(0, Math.max(0, probe));
  let contentsOk = 0;
  for (const c of probeTargets) {
    if (fetcher.stats.rateLimited) break;
    try {
      c.files = fileNamesFromContents(await fetcher.rootContents(c.fullName));
      contentsOk += 1;
    } catch {
      /* 目录探测失败直接跳过 */
    }
  }
  record('contents', { ok: true, count: contentsOk, skipped: probeTargets.length === 0, note: `探测 ${contentsOk}/${probeTargets.length}` });

  // ---- 打分 + 分类 + 动作（信号在此统一提取，探测结果已在 c.files 里）
  candidates = candidates.map((c) => {
    const enriched = { ...c, ...extractSignals(c) };
    const s = scoreCandidate(enriched, { now });
    const category = classifyCandidate(enriched);
    const withScore = { ...enriched, category, score: s.score, breakdown: s.breakdown };
    return { ...withScore, action: recommendAction(withScore) };
  });

  // 稳定排序：分数高 → 星多 → 名字
  candidates.sort((a, b) => (b.score - a.score) || ((num(b.stars) ?? 0) - (num(a.stars) ?? 0)) || a.fullName.localeCompare(b.fullName));

  if (fetcher.stats.rateLimited) noteList.push('本次运行触发 GitHub API 限流，部分元数据缺失；建议配置 GITHUB_TOKEN。');

  const radar = {
    schemaVersion: SCHEMA_VERSION,
    date,
    generatedAt: new Date().toISOString(),
    offline,
    limit,
    candidates,
    hn: hnStories,
    sources,
    stats: {
      requests: fetcher.stats.requests,
      cacheHits: fetcher.stats.cacheHits,
      failures: fetcher.stats.failures,
      rateLimited: fetcher.stats.rateLimited,
      candidateCount: candidates.length,
      notes: noteList,
    },
  };
  return radar;
}

/* ------------------------------------------------------------------ *
 * 写盘（只写 BASE_DIR 之内）
 * ------------------------------------------------------------------ */

async function writeIfChanged(file, content) {
  try {
    const prev = await fsp.readFile(file, 'utf8');
    if (prev === content) return false;
  } catch {
    /* 不存在就写 */
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return true;
}

export async function persist(radar, options = {}) {
  const {
    baseDir = BASE_DIR,
    force = false,
    now = new Date(),
    logger = () => {},
  } = options;
  const date = radar.date;
  const outDir = assertWithin(baseDir, path.join(baseDir, 'out', date));
  const stateDir = assertWithin(baseDir, path.join(baseDir, 'state'));
  const candidatesDir = path.join(outDir, 'candidates');
  await fsp.mkdir(candidatesDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });

  // ---- 状态：读 seen / 算日增量
  const seenPath = path.join(stateDir, 'seen.json');
  let seen = {};
  try {
    seen = JSON.parse(await fsp.readFile(seenPath, 'utf8'))?.repos || {};
  } catch {
    seen = {};
  }
  radar.candidates = radar.candidates.map((c) => ({ ...c, starsDelta: computeStarsDelta(c, seen) }));

  // ---- 当日是否已推送（幂等）
  const deliveryPath = path.join(outDir, '.delivered.json');
  let delivery = null;
  try {
    delivery = JSON.parse(await fsp.readFile(deliveryPath, 'utf8'));
  } catch {
    delivery = null;
  }
  const delivered = !force && wasDelivered(delivery, date);

  // ---- 选题包
  const mediaBriefs = buildMediaBriefs(radar.candidates, 3);
  radar.mediaBriefs = mediaBriefs;

  // ---- digest
  const digest = buildDigest(radar, { delivered });
  radar.digestSuppressed = delivered;

  // ---- 候选草稿（Top N）
  const docTargets = radar.candidates.slice(0, radar.limit || 20);
  let candidateDocs = 0;
  const keep = new Set();
  for (const c of docTargets) {
    const file = assertWithin(baseDir, path.join(candidatesDir, `${repoSafeName(c.fullName)}.md`));
    keep.add(path.basename(file));
    await writeIfChanged(file, renderCandidateDoc(c, { date }));
    candidateDocs += 1;
  }
  // 清理当日 stale 草稿（仓库名变化/候选减少时不留残骸）
  try {
    for (const f of await fsp.readdir(candidatesDir)) {
      if (f.endsWith('.md') && !keep.has(f)) await fsp.unlink(path.join(candidatesDir, f));
    }
  } catch {
    /* ignore */
  }
  radar.stats.candidateDocs = candidateDocs;

  // ---- 正文文件
  const radarJson = { ...radar };
  const files = {
    'radar.json': JSON.stringify(radarJson, null, 2) + '\n',
    'radar.md': renderRadarMarkdown(radar),
    'media-briefs.md': renderMediaBriefs(mediaBriefs, { date, candidateCount: radar.candidates.length }),
    'digest.txt': digest + '\n',
  };
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const file = assertWithin(baseDir, path.join(outDir, name));
    if (await writeIfChanged(file, content)) written.push(name);
  }

  // ---- 更新 seen + history
  const updated = updateSeen(seen, radar.candidates, date, { markPushed: true, pushed: !delivered });
  await writeIfChanged(seenPath, JSON.stringify({ updatedAt: new Date().toISOString(), repos: updated.seen }, null, 2) + '\n');
  const historyLine = JSON.stringify({
    date,
    generatedAt: radar.generatedAt,
    candidateCount: radar.candidates.length,
    top: radar.candidates.slice(0, 5).map((c) => ({ repo: c.fullName, stars: c.stars, score: c.score })),
    sources: Object.fromEntries(Object.entries(radar.sources).map(([k, v]) => [k, v.ok ? 'ok' : v.skipped ? 'skip' : 'fail'])),
  }) + '\n';
  const historyPath = path.join(stateDir, 'history.jsonl');
  // 同一天重跑不重复 append 同一条：先看尾部
  let alreadyLogged = false;
  try {
    const hist = await fsp.readFile(historyPath, 'utf8');
    const last = hist.trim().split('\n').filter(Boolean).pop();
    if (last) alreadyLogged = JSON.parse(last).date === date;
  } catch {
    alreadyLogged = false;
  }
  if (!alreadyLogged) await fsp.appendFile(historyPath, historyLine);

  // ---- 投递标记
  if (!delivered) {
    await fsp.writeFile(deliveryPath, JSON.stringify({ date, deliveredAt: new Date().toISOString(), candidates: radar.candidates.length, digest: digest }, null, 2) + '\n');
  }

  radar.digest = digest;
  radar.written = { written, candidateDocs, outDir, stateDir, suppressed: delivered };
  return radar;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseArgs(argv = []) {
  const out = {
    date: localDateString(),
    limit: DEFAULTS.limit,
    probe: DEFAULTS.probe,
    offline: false,
    noHn: false,
    force: false,
    quiet: false,
    noKeychain: false,
    fixturesDir: path.join(BASE_DIR, 'test', 'fixtures'),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [, flag, inline] = arg.match(/^(--[a-z-]+)(?:=(.*))?$/i) || [];
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--date': out.date = String(val() || ''); break;
      case '--limit': out.limit = num(val()); break;
      case '--probe': out.probe = num(val()); break;
      case '--offline': out.offline = true; break;
      case '--no-hn': out.noHn = true; break;
      case '--force': out.force = true; break;
      case '--quiet': out.quiet = true; break;
      case '--no-token': out.noKeychain = true; out.noToken = true; break;
      case '--fixtures': out.fixturesDir = String(val() || ''); break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (arg === '--help') out.help = true;
        else throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!isValidDateStr(out.date)) throw new Error(`--date 需要 YYYY-MM-DD，收到: ${out.date}`);
  if (out.limit === null || out.limit < 1 || out.limit > 200) throw new Error('--limit 需要在 1..200');
  if (out.probe === null || out.probe < 0 || out.probe > 200) throw new Error('--probe 需要在 0..200');
  return out;
}

const HELP = `github-radar — 每日 GitHub 涨星雷达（零依赖）

用法: node radar.mjs [选项]
  --date YYYY-MM-DD   输出日期目录（默认今天，本地时区）
  --limit N           radar.md Top 表与候选草稿数量（默认 20）
  --probe N           根目录 contents 探测的候选数（默认 12）
  --offline           用 test/fixtures/ 跑，不发任何网络请求
  --fixtures DIR      指定 fixture 目录（默认 test/fixtures）
  --no-hn             跳过 Hacker News 源
  --force             忽略“今天已推送”标记，强制重发 digest
  --no-token          不读 keychain 令牌（匿名 API，60/h）
  --quiet             只在出错时打印
  -h, --help          本帮助
`;

export async function main(argv = [], deps = {}) {
  const cli = parseArgs(argv);
  const logger = deps.logger || ((msg) => { if (!cli.quiet) process.stderr.write(msg + '\n'); });
  if (cli.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const started = Date.now();
  const token = cli.offline || cli.noToken ? null : loadToken(process.env, { noKeychain: cli.noKeychain });
  const radar = await collect({
    date: cli.date,
    offline: cli.offline,
    fixturesDir: cli.offline ? cli.fixturesDir : undefined,
    token,
    noHn: cli.noHn,
    probe: cli.probe,
    limit: cli.limit,
    logger,
  });
  await persist(radar, { force: cli.force, logger, baseDir: deps.baseDir || BASE_DIR });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!cli.quiet) {
    process.stderr.write(
      `\ngithub-radar ${radar.date}: 候选 ${radar.candidates.length} 个，请求 ${radar.stats.requests} 次，耗时 ${elapsed}s\n` +
      `  out/${radar.date}/radar.json|radar.md|media-briefs.md|digest.txt + candidates/${radar.stats.candidateDocs} 个草稿\n` +
      `  digest ${codePointLength(radar.digest)} 字${radar.digestSuppressed ? '（今日已推送过，本次抑制）' : ''}\n` +
      (radar.stats.notes.length ? `  告警: ${radar.stats.notes.join(' ｜ ')}\n` : ''),
    );
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    date: radar.date,
    candidates: radar.candidates.length,
    digestChars: codePointLength(radar.digest),
    suppressed: Boolean(radar.digestSuppressed),
    outDir: path.relative(process.cwd(), radar.written.outDir) || radar.written.outDir,
    files: radar.written.written,
    candidateDocs: radar.stats.candidateDocs,
    elapsedSec: Number(elapsed),
    sources: Object.fromEntries(Object.entries(radar.sources).map(([k, v]) => [k, { ok: v.ok, count: v.count ?? 0, skipped: Boolean(v.skipped), error: v.error || undefined }])),
    top5: radar.candidates.slice(0, 5).map((c) => ({ repo: c.fullName, stars: c.stars, starsToday: c.starsToday, score: c.score, category: c.category, action: c.action })),
  }, null, 2) + '\n');
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`radar 失败: ${redact(err?.stack || err?.message || String(err))}\n`);
      process.exit(1);
    });
}
