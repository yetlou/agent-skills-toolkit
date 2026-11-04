/**
 * github-radar 测试：node --test tools/github-radar/test/
 *
 * 覆盖：三个源解析 / 去重合并 / 打分 / 分类 / 建议动作 / 日增量 / 状态 /
 *       digest 字数与结构 / 幂等（当日第二次运行不重复推送）/ 离线降级 / 写入边界。
 * 全部用 test/fixtures/ 里的真实 API 快照，不发网络请求。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rad from '../radar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const readJson = (name) => JSON.parse(readFixture(name));

const NOW = new Date('2026-11-04T00:00:00+09:00');
const DATE = '2026-11-04';

/* ---------------------------------------------------------------- */
describe('源码解析 · GitHub Trending HTML', () => {
  test('解析出全部 8 个仓库（6 真实 + 2 边界样本）', () => {
    const list = rad.parseTrendingHtml(readFixture('trending.html'));
    assert.equal(list.length, 8);
    const first = list[0];
    assert.equal(first.fullName, 'thedotmack/claude-mem');
    assert.equal(first.owner, 'thedotmack');
    assert.equal(first.name, 'claude-mem');
    assert.equal(first.url, 'https://github.com/thedotmack/claude-mem');
    assert.equal(first.starsToday, 1139);
    assert.equal(first.stars, 111928);
    assert.equal(first.language, 'TypeScript');
    assert.match(first.description, /Persistent Context/);
    assert.equal(first.trendingRank, 1);
    assert.deepEqual(first.sources, ['trending']);
  });

  test('边界：缺简介 / 缺语言 / 缺今日涨星都返回 null，不编造', () => {
    const list = rad.parseTrendingHtml(readFixture('trending.html'));
    const noDesc = list.find((c) => c.fullName === 'acme/unnamed-lab');
    assert.ok(noDesc);
    assert.equal(noDesc.description, null);
    assert.equal(noDesc.starsToday, 87);
    const noToday = list.find((c) => c.fullName === 'acme/no-today-repo');
    assert.equal(noToday.starsToday, null);
    assert.equal(noToday.language, 'Go');
  });

  test('脏输入不崩：空串 / 只有外壳 / 非 HTML', () => {
    for (const bad of ['', '<html></html>', 'not html at all', null, undefined]) {
      assert.deepEqual(rad.parseTrendingHtml(bad), []);
    }
  });

  test('不会把 sponsors/login 之类链接当仓库', () => {
    const html = readFixture('trending.html');
    const list = rad.parseTrendingHtml(html);
    assert.ok(list.every((c) => !/^(sponsors|login)$/i.test(c.owner)));
  });
});

describe('源码解析 · GitHub Search API', () => {
  test('解析 items 并映射 license/topics/created_at', () => {
    const list = rad.parseSearchResponse(readJson('search-topic-ai-agents.json'), 'search-topic-ai-agents');
    assert.equal(list.length, 3);
    const harness = list.find((c) => c.fullName === 'deepseek-ai/deepseek-harness');
    assert.ok(harness, 'fixture 里应有 deepseek-harness');
    assert.equal(harness.license, 'MIT');
    assert.ok(harness.topics.includes('dsh-plugin'));
    assert.match(harness.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(harness.kind, 'repo');
    assert.deepEqual(harness.sources, ['search-topic-ai-agents']);
    assert.equal(harness.starsToday, null, 'search 源没有今日涨星，必须是 null');
  });

  test('没有 items / 脏 items 不崩', () => {
    assert.deepEqual(rad.parseSearchResponse({}, 'x'), []);
    assert.deepEqual(rad.parseSearchResponse({ items: [null, { name: 'bad' }] }, 'x'), []);
    const mixed = rad.parseSearchResponse({ items: [{ full_name: 'a/b' }, null] }, 'x');
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0].fullName, 'a/b');
    assert.equal(mixed[0].stars, null);
  });

  test('NOASSERTION 许可证归一化成“未知”', () => {
    assert.equal(rad.normalizeLicense('NOASSERTION'), null);
    assert.equal(rad.licenseClass('NOASSERTION'), 'unknown');
    assert.equal(rad.licenseClass('MIT'), 'permissive');
    assert.equal(rad.licenseClass('AGPL-3.0'), 'copyleft');
    assert.equal(rad.licenseClass(null), 'unknown');
  });
});

describe('源码解析 · Hacker News Algolia', () => {
  test('解析 title/points/url，并识别 GitHub 链接', () => {
    const stories = rad.parseHnResponse(readJson('hn-mcp.json'), 'mcp');
    assert.ok(stories.length >= 3);
    const first = stories[0];
    assert.equal(typeof first.title, 'string');
    assert.ok(first.points > 150, 'fixture 用 points>150 过滤过');
    assert.deepEqual(first.keywords, ['mcp']);
    assert.equal(first.kind, 'hn');
  });

  test('repoFromUrl：只认仓库地址，跳过非仓库路径', () => {
    assert.equal(rad.repoFromUrl('https://github.com/thedotmack/claude-mem'), 'thedotmack/claude-mem');
    assert.equal(rad.repoFromUrl('https://github.com/thedotmack/claude-mem/tree/main/x'), 'thedotmack/claude-mem');
    assert.equal(rad.repoFromUrl('https://github.com/foo/bar.git'), 'foo/bar');
    assert.equal(rad.repoFromUrl('https://github.com/topics/mcp'), null);
    assert.equal(rad.repoFromUrl('https://example.com/foo/bar'), null);
    assert.equal(rad.repoFromUrl(null), null);
  });
});

describe('去重合并', () => {
  test('同一仓库出现在 trending + 多个主题检索时合并成一个', () => {
    const trending = rad.parseTrendingHtml(readFixture('trending.html'));
    const searchA = rad.parseSearchResponse(readJson('search-topic-ai-agents.json'), 'search-topic-ai-agents');
    const searchB = rad.parseSearchResponse(readJson('search-created.json'), 'search-created');
    // 人为让 search 里也出现 claude-mem（真实场景很常见）
    searchA.push({ ...searchA[0], fullName: 'TheDotMack/Claude-Mem', owner: 'thedotmack', name: 'claude-mem', stars: 999999 });
    const merged = rad.mergeCandidates([trending, searchA, searchB]);
    const keys = merged.map((c) => c.fullName.toLowerCase());
    assert.equal(new Set(keys).size, keys.length, '不应该有重复 key');
    const cm = merged.find((c) => c.fullName.toLowerCase() === 'thedotmack/claude-mem');
    assert.equal(cm.stars, 999999, '取更大的星数（API 更权威）');
    assert.equal(cm.starsToday, 1139, '今日涨星只有 trending 有，合并后保留');
    assert.equal(cm.trendingRank, 1);
    assert.ok(cm.sources.includes('trending'));
    assert.ok(cm.sources.length >= 2);
  });

  test('空输入 / 脏输入返回空数组', () => {
    assert.deepEqual(rad.mergeCandidates([]), []);
    assert.deepEqual(rad.mergeCandidates([[], undefined, null]), []);
    assert.equal(rad.mergeCandidates([[{ fullName: 'a/b' }, { nope: 1 }, null]]).length, 1);
  });
});

describe('信号提取 + 分类', () => {
  test('dsh-plugin / mcp / skill / agent-tool 各自归类', () => {
    const searchItems = [
      ...rad.parseSearchResponse(readJson('search-topic-ai-agents.json'), 's1'),
      ...rad.parseSearchResponse(readJson('search-topic-mcp.json'), 's2'),
      ...rad.parseSearchResponse(readJson('search-topic-agent-skill.json'), 's3'),
    ];
    const byName = Object.fromEntries(searchItems.map((c) => [c.fullName, c]));
    assert.equal(rad.classifyCandidate(byName['deepseek-ai/deepseek-harness']), 'dsh-plugin');
    assert.equal(rad.classifyCandidate(byName['affaan-m/ECC']), 'mcp');
    assert.equal(rad.classifyCandidate(byName['wheresryan22/anatomy']), 'skill');
    assert.equal(rad.classifyCandidate(byName['NousResearch/hermes-agent']), 'agent-tool');
  });

  test('优先级：dsh-plugin > mcp > skill > agent-tool', () => {
    assert.equal(rad.classifyCandidate({ fullName: 'a/b', description: 'dsh plugin with mcp server and agent skills' }), 'dsh-plugin');
    assert.equal(rad.classifyCandidate({ fullName: 'a/b', description: 'an mcp server for agent skills' }), 'mcp');
    assert.equal(rad.classifyCandidate({ fullName: 'a/b', description: 'a skill pack for agents' }), 'skill');
    assert.equal(rad.classifyCandidate({ fullName: 'a/b', description: 'an agent runner' }), 'agent-tool');
    assert.equal(rad.classifyCandidate({ fullName: 'a/b', description: 'a fast json parser' }), 'other');
  });

  test('awesome 列表 / HN 条目 → content-ref', () => {
    assert.equal(rad.classifyCandidate({ fullName: 'a/awesome-mcp', description: 'A curated list of mcp thingies' }), 'content-ref');
    assert.equal(rad.classifyCandidate({ kind: 'hn', title: 'x' }), 'content-ref');
  });

  test('从根目录文件推出 SKILL.md / 需要 Docker / 安装脚本', () => {
    const files = readJson('contents-mattpocock__skills.json').map((e) => e.name);
    const sig = rad.extractSignals({ fullName: 'mattpocock/skills', description: 'Skills for Real Engineers', files });
    assert.equal(sig.hasSkillsDir, true);
    assert.equal(sig.hasSkillFile, false, '根目录没有 SKILL.md');
    assert.equal(sig.hasInstallScript, true, '有 package.json');

    const cmFiles = readJson('contents-thedotmack__claude-mem.json').map((e) => e.name);
    const cmSig = rad.extractSignals({ fullName: 'thedotmack/claude-mem', description: 'x', files: cmFiles });
    assert.equal(cmSig.requiresDocker, true, '有 docker-compose.yml');
    assert.equal(cmSig.hasSkillsDir, false, '.claude/.agents 是插件配置目录，不算技能包');
  });

  test('判不出来的信号保持 null（不猜）', () => {
    const sig = rad.extractSignals({ fullName: 'x/y' });
    assert.equal(sig.requiresDocker, null);
    assert.equal(sig.requiresApiKey, null);
    assert.equal(sig.hasSkillFile, null);
  });
});

describe('打分', () => {
  const base = {
    fullName: 'a/b',
    stars: 1000,
    starsToday: 10,
    language: 'TypeScript',
    description: 'A tool for agents',
    createdAt: '2026-10-20T00:00:00Z',
    pushedAt: '2026-11-03T00:00:00Z',
    license: 'MIT',
    archived: false,
    topics: ['agent'],
  };

  test('确定：同样输入永远同样的分', () => {
    const a = rad.scoreCandidate(base, { now: NOW });
    const b = rad.scoreCandidate(base, { now: NOW });
    assert.deepEqual(a, b);
  });

  test('星越多分越高（热度单调）', () => {
    const low = rad.scoreCandidate({ ...base, stars: 500 }, { now: NOW });
    const high = rad.scoreCandidate({ ...base, stars: 50000 }, { now: NOW });
    assert.ok(high.score > low.score, `${high.score} 应大于 ${low.score}`);
    assert.ok(high.breakdown.heat > low.breakdown.heat);
  });

  test('今日涨星和 HN 分也加分', () => {
    const plain = rad.scoreCandidate({ ...base, starsToday: 0 }, { now: NOW });
    const hot = rad.scoreCandidate({ ...base, starsToday: 900 }, { now: NOW });
    assert.ok(hot.score > plain.score);
    const hn = rad.scoreCandidate({ ...base, hnPoints: 800 }, { now: NOW });
    assert.ok(hn.score > plain.score);
  });

  test('归档 / 无许可证 / 需要 Docker+Key 的分数明显更低', () => {
    const good = rad.scoreCandidate(base, { now: NOW });
    const archived = rad.scoreCandidate({ ...base, archived: true }, { now: NOW });
    const noLicense = rad.scoreCandidate({ ...base, license: null }, { now: NOW });
    const heavy = rad.scoreCandidate({ ...base, requiresDocker: true, requiresApiKey: true }, { now: NOW });
    assert.ok(archived.score < good.score);
    assert.ok(noLicense.score < good.score);
    assert.ok(heavy.score < good.score);
    assert.ok(archived.breakdown.usability < good.breakdown.usability);
  });

  test('新鲜度：新仓库 > 老仓库', () => {
    const fresh = rad.scoreCandidate({ ...base, createdAt: '2026-11-01T00:00:00Z' }, { now: NOW });
    const old = rad.scoreCandidate({ ...base, createdAt: '2020-01-01T00:00:00Z' }, { now: NOW });
    assert.ok(fresh.breakdown.freshness > old.breakdown.freshness);
    assert.ok(fresh.score > old.score);
  });

  test('分数恒在 0..100，breakdown 里带着观察值便于核对', () => {
    const weird = rad.scoreCandidate({ fullName: 'x/y', stars: 10 ** 9, starsToday: 10 ** 6, license: 'MIT' }, { now: NOW });
    assert.ok(weird.score >= 0 && weird.score <= 100);
    assert.equal(weird.breakdown.observed.stars, 10 ** 9);
    assert.equal(weird.breakdown.observed.licenseClass, 'permissive');
  });
});

describe('建议动作', () => {
  const mcpReady = {
    fullName: 'o/mcp', category: 'mcp', stars: 4000, starsToday: 3, license: 'MIT',
    description: 'mcp server', score: 80, archived: false, createdAt: '2026-09-01T00:00:00Z',
  };

  test('install-mcp / draft-skill / media-content / skip 都走得到', () => {
    assert.equal(rad.recommendAction(mcpReady), 'install-mcp');
    assert.equal(rad.recommendAction({ ...mcpReady, category: 'skill', hasSkillFile: true, hasSkillsDir: true }), 'draft-skill');
    assert.equal(rad.recommendAction({ ...mcpReady, starsToday: 900 }), 'media-content');
    assert.equal(rad.recommendAction({ ...mcpReady, archived: true }), 'skip');
    assert.equal(rad.recommendAction({ ...mcpReady, score: 10 }), 'skip');
  });

  test('没有许可证的 MCP 不给 install-mcp（别照着装）', () => {
    assert.equal(rad.recommendAction({ ...mcpReady, license: null }), 'watch');
  });

  test('isVideoWorthy 只认“当下在爆”，不认老牌大仓', () => {
    assert.equal(rad.isVideoWorthy({ stars: 100000, starsToday: null, createdAt: '2019-01-01T00:00:00Z' }), false);
    assert.equal(rad.isVideoWorthy({ stars: 100000, starsToday: 300 }), true);
    assert.equal(rad.isVideoWorthy({ stars: 25000, createdAt: '2026-10-01T00:00:00Z' }), true);
  });

  test('安装命令不编造包名（只给 clone + 读 README 的诚实说明）', () => {
    const cmd = rad.installCommandFor({ ...mcpReady, url: 'https://github.com/o/mcp' });
    assert.match(cmd, /git clone https:\/\/github\.com\/o\/mcp\.git/);
    assert.doesNotMatch(cmd, /\bnpx\s+\S+/);
    const skillCmd = rad.installCommandFor({ ...mcpReady, category: 'skill', name: 'mcp', hasSkillFile: true });
    assert.match(skillCmd, /SKILL\.md/);
  });
});

describe('日增量 + 状态', () => {
  test('第一次见到 → null；之后按差值算；掉了算 0', () => {
    assert.equal(rad.computeStarsDelta({ fullName: 'a/b', stars: 100 }, {}), null);
    const seen = { 'a/b': { stars: 100 } };
    assert.equal(rad.computeStarsDelta({ fullName: 'a/b', stars: 150 }, seen), 50);
    assert.equal(rad.computeStarsDelta({ fullName: 'a/b', stars: 90 }, seen), 0);
    assert.equal(rad.computeStarsDelta({ fullName: 'A/B', stars: 130 }, seen), 30, '大小写不敏感');
    assert.equal(rad.computeStarsDelta({ fullName: 'a/b', stars: null }, seen), null);
  });

  test('updateSeen：保留 firstSeen，更新 lastSeen，pushedOn 只在真推送时写', () => {
    const first = rad.updateSeen({}, [{ fullName: 'a/b', stars: 100, score: 50, category: 'mcp' }], '2026-11-03', { pushed: true });
    assert.equal(first.seen['a/b'].firstSeen, '2026-11-03');
    assert.equal(first.seen['a/b'].pushedOn, '2026-11-03');
    assert.equal(first.deltas['a/b'], null);

    const second = rad.updateSeen(first.seen, [{ fullName: 'a/b', stars: 160, score: 60, category: 'mcp' }], '2026-11-04', { pushed: false });
    assert.equal(second.seen['a/b'].firstSeen, '2026-11-03', 'firstSeen 不能被覆盖');
    assert.equal(second.seen['a/b'].lastSeen, '2026-11-04');
    assert.equal(second.seen['a/b'].pushedOn, '2026-11-03', '抑制投递时保留上次推送日');
    assert.equal(second.deltas['a/b'], 60);
    assert.equal(second.seen['a/b'].stars, 160);
  });

  test('wasDelivered 只认同一天', () => {
    assert.equal(rad.wasDelivered({ date: '2026-11-04', deliveredAt: 'x' }, '2026-11-04'), true);
    assert.equal(rad.wasDelivered({ date: '2026-11-03', deliveredAt: 'x' }, '2026-11-04'), false);
    assert.equal(rad.wasDelivered(null, '2026-11-04'), false);
  });
});

/* ---------------------------------------------------------------- */
describe('离线端到端 collect', () => {
  let radar;
  before(async () => {
    radar = await rad.collect({
      offline: true,
      fixturesDir: FIXTURES,
      date: DATE,
      now: NOW,
      limit: 20,
      probe: 12,
    });
  });

  test('三个源都成功，metadata/contents 也跑起来了', () => {
    assert.equal(radar.sources.trending.ok, true);
    assert.equal(radar.sources.trending.count, 8);
    assert.equal(radar.sources['search-topic-mcp'].ok, true);
    assert.equal(radar.sources.hn.ok, true);
    assert.equal(radar.sources.metadata.count, 3, '有 3 个 repo fixture 可补元数据');
    assert.ok(radar.sources.contents.count >= 1, '内容探测至少跑成功一个');
  });

  test('候选是合并去重后的，全部有分类/分数/动作', () => {
    assert.ok(radar.candidates.length >= 10);
    const ids = radar.candidates.map((c) => c.fullName.toLowerCase());
    assert.equal(new Set(ids).size, ids.length);
    for (const c of radar.candidates) {
      assert.ok(rad.CATEGORIES.includes(c.category), `${c.fullName} 分类非法: ${c.category}`);
      assert.ok(rad.ACTIONS.includes(c.action), `${c.fullName} 动作非法: ${c.action}`);
      assert.ok(Number.isInteger(c.score) && c.score >= 0 && c.score <= 100);
      assert.ok(c.breakdown && typeof c.breakdown.heat === 'number');
    }
  });

  test('排序稳定：分数从高到低', () => {
    const scores = radar.candidates.map((c) => c.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  test('trending 的今日涨星在合并后仍在（视频信号来源）', () => {
    const cm = radar.candidates.find((c) => c.fullName === 'thedotmack/claude-mem');
    assert.equal(cm.starsToday, 1139);
    assert.equal(cm.category, 'agent-tool', 'claude-mem 是跨 agent 的记忆层，不是 mcp server');
    assert.equal(cm.action, 'media-content', '单日 +1139 星 → 值得做视频');
  });

  test('HN 条目带 linkedRepo 时给对应仓库加 hnPoints', () => {
    const linked = radar.hn.filter((h) => h.linkedRepo);
    assert.ok(linked.length > 0, 'fixture 里应有指向 github 的 HN 链接');
    const target = radar.candidates.find((c) => c.fullName.toLowerCase() === linked[0].linkedRepo.toLowerCase());
    if (target) assert.equal(target.hnPoints, linked[0].points);
  });

  test('同参数两次 collect 结果一致（除 generatedAt）', async () => {
    const again = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20, probe: 12 });
    const strip = (r) => JSON.stringify({ ...r, generatedAt: 'X' });
    assert.equal(strip(again), strip(radar));
  });

  test('--no-hn：HN 源标记跳过而不是报错', async () => {
    const noHn = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, noHn: true });
    assert.equal(noHn.sources.hn.skipped, true);
    assert.equal(noHn.sources.hn.ok, false);
    assert.ok(noHn.candidates.length > 0, 'HN 挂了也不影响仓库候选');
  });
});

describe('离线模式不发网络请求', () => {
  test('--offline 期间 fetch 一次都不该被调用', async () => {
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = () => { called += 1; throw new Error('offline 模式不该发网络请求'); };
    try {
      const radar = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW });
      assert.equal(called, 0);
      assert.ok(radar.candidates.length > 0);
      assert.equal(radar.offline, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('离线降级：fixture 缺一半也不能崩', () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-partial-'));
    // 只放 trending.html，其余源都会缺 fixture
    await fsp.copyFile(path.join(FIXTURES, 'trending.html'), path.join(tmpDir, 'trending.html'));
  });
  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test('search/HN/metadata 失败 → 只告警，候选仍来自 trending', async () => {
    const radar = await rad.collect({ offline: true, fixturesDir: tmpDir, date: DATE, now: NOW });
    assert.equal(radar.sources.trending.ok, true);
    assert.equal(radar.sources['search-topic-mcp'].ok, false);
    assert.match(radar.sources['search-topic-mcp'].error, /fixture 缺失/);
    assert.equal(radar.sources.hn.ok, false);
    assert.ok(radar.candidates.length >= 6, 'trending 的候选仍在');
    assert.ok(radar.stats.notes.length > 0, '要有告警记录');
  });
});

/* ---------------------------------------------------------------- */
describe('digest（Discord 摘要）', () => {
  let radar;
  before(async () => {
    radar = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20 });
  });

  test('≤1200 字，且包含 Top5 / 建议动作 / 媒体选题线索', () => {
    const digest = rad.buildDigest(radar, { mediaBriefs: rad.buildMediaBriefs(radar.candidates, 3) });
    assert.ok(rad.codePointLength(digest) <= 1200, `digest 超长: ${rad.codePointLength(digest)}`);
    assert.match(digest, /GitHub 涨星雷达 2026-11-04/);
    const top = radar.candidates.slice(0, 5);
    for (const c of top) assert.ok(digest.includes(c.fullName), `digest 缺 Top5 成员 ${c.fullName}`);
    assert.match(digest, /建议动作/);
    assert.match(digest, /媒体选题线索/);
    assert.match(digest, /明细：tools\/github-radar\/out\/2026-11-04\/radar\.md/);
    assert.doesNotMatch(digest, /\u001b\[/, '不能带 ANSI 颜色码');
  });

  test('当天第二次运行 → 抑制文案（不重复推同一批）', () => {
    const suppressed = rad.buildDigest(radar, { delivered: true });
    assert.match(suppressed, /已推送过/);
    assert.match(suppressed, /不重复推送/);
    assert.ok(rad.codePointLength(suppressed) < 300);
  });

  test('候选为空时也有兜底文案，不是崩', () => {
    const empty = rad.buildDigest({ date: DATE, candidates: [], sources: { trending: { ok: false, count: 0, error: 'boom' } }, stats: {} });
    assert.match(empty, /没有抓到可用候选/);
    assert.match(empty, /trending/);
  });

  test('候选很多 / 描述很长时仍压到 1200 字以内', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...radar.candidates[i % radar.candidates.length],
      fullName: `owner${i}/repo-with-a-really-long-name-${i}`,
      description: '很长的描述'.repeat(30),
      action: 'watch',
      category: 'other',
    }));
    const digest = rad.buildDigest({ ...radar, candidates: many }, { mediaBriefs: [] });
    assert.ok(rad.codePointLength(digest) <= 1200, `超长: ${rad.codePointLength(digest)}`);
  });
});

describe('三个产物渲染', () => {
  let radar;
  before(async () => {
    radar = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20 });
  });

  test('radar.md：Top 表 + 分类小节 + 推荐动作 + 源状态', () => {
    const md = rad.renderRadarMarkdown(radar);
    assert.match(md, /^# GitHub 涨星雷达 · 2026-11-04/m);
    assert.match(md, /\| # \| 仓库 \| 语言 \| 总星 \|/);
    assert.match(md, /## 分类小节/);
    assert.match(md, /### MCP 生态/);
    assert.match(md, /## 推荐动作汇总/);
    assert.match(md, /## 数据源与告警/);
    assert.ok(md.includes(radar.candidates[0].fullName));
  });

  test('media-briefs.md：3 个选题包，字段齐全，数字与候选一致', async () => {
    const briefs = rad.buildMediaBriefs(radar.candidates, 3);
    assert.equal(briefs.length, 3);
    const md = rad.renderMediaBriefs(briefs, { date: DATE, candidateCount: radar.candidates.length });
    for (const label of ['标题', '30 秒钩子', '三段结构', '需要的画面素材', '标签', '适合账号', '事实核对']) {
      assert.ok(md.includes(label), `选题包缺字段: ${label}`);
    }
    for (const b of briefs) {
      assert.ok(b.title.length > 0);
      assert.ok(b.structure.length === 3);
      assert.ok(b.shots.length >= 3);
      assert.ok(b.tags.startsWith('#'));
      assert.ok(Object.values(rad.ACCOUNTS).includes(b.account.label));
    }
    // 数字必须来自候选，不许编
    const top = briefs[0];
    const src = radar.candidates.find((c) => c.fullName === top.fullName);
    assert.equal(top.facts.stars, src.stars);
    assert.equal(top.facts.starsToday, src.starsToday);
    assert.equal(top.facts.license, src.license);
  });

  test('candidates/<repo>.md：是什么/为什么/安装命令/风险/建议', () => {
    const doc = rad.renderCandidateDoc(radar.candidates[0], { date: DATE });
    for (const label of ['## 是什么', '## 为什么值得看', '## 真实安装/试用命令', '## 风险', '## 建议']) {
      assert.ok(doc.includes(label), `候选草稿缺: ${label}`);
    }
    assert.match(doc, /git clone https:\/\/github\.com\//);
  });
});

/* ---------------------------------------------------------------- */
describe('落盘 + 幂等', () => {
  let baseDir;
  before(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-out-'));
  });
  after(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  test('写出 4 个文件 + 候选草稿 + state，且第二次运行抑制 digest', async () => {
    const radar = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20 });
    await rad.persist(radar, { baseDir, now: NOW });

    const outDir = path.join(baseDir, 'out', DATE);
    for (const name of ['radar.json', 'radar.md', 'media-briefs.md', 'digest.txt']) {
      assert.ok(fs.existsSync(path.join(outDir, name)), `缺 ${name}`);
    }
    const docs = await fsp.readdir(path.join(outDir, 'candidates'));
    assert.ok(docs.length >= 5);
    assert.ok(docs.every((d) => d.endsWith('.md')));

    const json = JSON.parse(await fsp.readFile(path.join(outDir, 'radar.json'), 'utf8'));
    assert.equal(json.date, DATE);
    assert.equal(json.schemaVersion, rad.SCHEMA_VERSION);
    assert.ok(json.candidates.length > 0);
    assert.ok(json.mediaBriefs.length === 3);
    assert.equal(json.digestSuppressed, false);

    const seen = JSON.parse(await fsp.readFile(path.join(baseDir, 'state', 'seen.json'), 'utf8'));
    assert.ok(Object.keys(seen.repos).length > 0);
    assert.ok(json.candidates.every((c) => c.starsDelta !== null || seen.repos[c.fullName.toLowerCase()]));

    // 第二次运行同一天：digest 变抑制文案，且 history 不重复 append
    const radar2 = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20 });
    await rad.persist(radar2, { baseDir, now: NOW });
    const digest2 = await fsp.readFile(path.join(outDir, 'digest.txt'), 'utf8');
    assert.match(digest2, /已推送过/);
    const hist = (await fsp.readFile(path.join(baseDir, 'state', 'history.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(hist.length, 1, '同一天不该重复 append history');

    // 第三次加 --force：恢复真实 digest
    const radar3 = await rad.collect({ offline: true, fixturesDir: FIXTURES, date: DATE, now: NOW, limit: 20 });
    await rad.persist(radar3, { baseDir, now: NOW, force: true });
    const digest3 = await fsp.readFile(path.join(outDir, 'digest.txt'), 'utf8');
    assert.doesNotMatch(digest3, /已推送过/);
    assert.match(digest3, /GitHub 涨星雷达 2026-11-04/);

    // 日增量：第二次的 starsDelta 应全是 0（星数没变）
    const json3 = JSON.parse(await fsp.readFile(path.join(outDir, 'radar.json'), 'utf8'));
    assert.ok(json3.candidates.every((c) => c.starsDelta === null || c.starsDelta === 0));
  });
});

describe('CLI 与写入边界', () => {
  test('parseArgs 默认值与校验', () => {
    const a = rad.parseArgs(['--offline', '--date', '2026-11-04']);
    assert.equal(a.offline, true);
    assert.equal(a.date, '2026-11-04');
    assert.equal(a.limit, 20);
    assert.equal(a.noHn, false);
    assert.throws(() => rad.parseArgs(['--date', '2026-13-99']), /--date/);
    assert.throws(() => rad.parseArgs(['--limit', '0']), /--limit/);
    assert.throws(() => rad.parseArgs(['--nope']), /未知参数/);
    assert.equal(rad.parseArgs(['--no-hn']).noHn, true);
    assert.equal(rad.parseArgs(['--help']).help, true);
  });

  test('assertWithin 拒绝写到工具目录之外', () => {
    const base = path.join(os.tmpdir(), 'radar-base');
    assert.equal(rad.assertWithin(base, path.join(base, 'out', 'x')), path.join(base, 'out', 'x'));
    assert.throws(() => rad.assertWithin(base, '/tmp/elsewhere/evil.json'), /拒绝写入/);
    assert.throws(() => rad.assertWithin(base, path.join(base, '..', 'escape')), /拒绝写入/);
  });

  test('main --offline --date 能端到端跑，退出码 0，只写 baseDir 之内', async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'radar-main-'));
    const before = new Set(fs.readdirSync(baseDir));
    const code = await rad.main(['--offline', '--date', '2026-11-04', '--quiet', '--limit', '10'], { baseDir, logger: () => {} });
    assert.equal(code, 0);
    const outDir = path.join(baseDir, 'out', '2026-11-04');
    assert.ok(fs.existsSync(path.join(outDir, 'digest.txt')));
    const after = new Set(fs.readdirSync(baseDir));
    assert.deepEqual([...after].sort(), ['out', 'state'], '只应产生 out/ 和 state/（无其它文件）');
    assert.ok(before.size === 0);
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  test('已知 token 永远不出现在产物里（redact）', () => {
    const fake = 'ghp_' + 'a'.repeat(36);
    assert.equal(rad.redact(`token=${fake} boom`, fake), 'token=[REDACTED] boom');
    assert.equal(rad.redact('ghp_' + 'b'.repeat(36)), '[REDACTED]');
  });

  test('loadToken：env 优先，绝不返回空串', () => {
    assert.equal(rad.loadToken({ GITHUB_TOKEN: 't1' }), 't1');
    assert.equal(rad.loadToken({ GH_TOKEN: 't2' }), 't2');
    assert.equal(rad.loadToken({}, { noKeychain: true }), null);
  });
});
