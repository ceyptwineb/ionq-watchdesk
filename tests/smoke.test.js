const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadHelpers(relativePath, names, env = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  const sandboxProcess = { env: { ...env } };
  const expose = `\nmodule.exports.__test = { ${names.join(", ")} };`;
  vm.runInNewContext(source + expose, {
    AbortController,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process: sandboxProcess,
    setTimeout
  }, { filename });
  return module.exports;
}

test("Cronは1時間間隔", () => {
  const config = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.match(config, /schedule\s*=\s*"0 \* \* \* \*"/);
});

test("公開URLは現在のNetlifyサイトに統一されている", () => {
  const files = [
    "index.html",
    "netlify/functions/watch-ionq.js",
    "netlify/functions/report.js"
  ].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  assert.match(files, /https:\/\/ionqnews\.netlify\.app/);
  assert.doesNotMatch(files, /https:\/\/ionqwatchdesk\.netlify\.app/);
});

test("初回同期キューはinitより先に初期化される", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const queue = html.indexOf("const pendingOps = new Map()");
  const init = html.indexOf("\n    init();");
  assert.ok(queue >= 0);
  assert.ok(init > queue);
});

test("初期表示期間は説明どおり48時間", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /const DEFAULT_MAX_AGE_HOURS = 48;/);
  assert.match(html, /id="age48" class="primary"/);
});

test("PC表示ではヘッダーと2カラムの作業画面を配置する", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(
    html,
    /\.app\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(330px, 390px\);/s
  );
  assert.match(html, /\.main\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
  assert.match(html, /class="toolbar-row"/);
  assert.match(html, /\.age-tabs\s*\{[^}]*flex-wrap:\s*wrap;/s);
});

test("検索・フィルター後は表示中の記事へ詳細を同期する", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /const selectionVisible = items\.some/);
  assert.match(html, /if \(!selectionVisible && items\.length\) \{\s*selectItem\(items\[0\]\.id\);/s);
  assert.match(html, /表示対象の記事がありません/);
});

test("古いキャッシュと軽量収集をIDでマージする", () => {
  const { __test } = loadHelpers("netlify/functions/latest-ionq.js", ["mergeWithCached"]);
  const cached = [
    { id: "old", title: "専門媒体", publishedAt: "2026-07-13T00:00:00Z" },
    { id: "same", title: "古い題名", titleJa: "保存済み訳", publishedAt: "2026-07-13T01:00:00Z" }
  ];
  const live = [
    { id: "same", title: "新しい題名", publishedAt: "2026-07-14T01:00:00Z" },
    { id: "new", title: "新着", publishedAt: "2026-07-14T02:00:00Z" }
  ];
  const result = __test.mergeWithCached(live, cached);
  assert.deepEqual(Array.from(result, (item) => item.id), ["new", "same", "old"]);
  assert.equal(result[1].title, "新しい題名");
  assert.equal(result[1].titleJa, "保存済み訳");
});

test("キャッシュは1時間Cronに余裕を持たせ、未来時刻は拒否する", () => {
  const { __test } = loadHelpers("netlify/functions/latest-ionq.js", ["isCacheFresh"]);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() - 130 * 60 * 1000).toISOString() }), true);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() - 160 * 60 * 1000).toISOString() }), false);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), false);
});

test("ローカルプレビューからlatest APIを読めるCORS設定がある", async () => {
  const latest = loadHelpers("netlify/functions/latest-ionq.js", ["isCacheFresh"]);
  const response = await latest.handler({ httpMethod: "OPTIONS" });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.match(response.headers["access-control-allow-methods"], /GET/);
});

test("通知は既定6時間以内に限定し、環境変数で短縮できる", () => {
  const base = loadHelpers(
    "netlify/functions/watch-ionq.js",
    ["effectiveLookbackMinutes", "shouldNotifyByTime"]
  ).__test;
  assert.equal(base.effectiveLookbackMinutes(), 360);

  const shortened = loadHelpers(
    "netlify/functions/watch-ionq.js",
    ["effectiveLookbackMinutes"],
    { WATCH_LOOKBACK_MINUTES: "90" }
  ).__test;
  assert.equal(shortened.effectiveLookbackMinutes(), 90);

  const now = "2026-07-17T12:00:00+09:00";
  assert.equal(base.shouldNotifyByTime({ publishedAt: "2026-07-17T07:00:00+09:00" }, now), true);
  assert.equal(base.shouldNotifyByTime({ publishedAt: "2026-07-17T05:00:00+09:00" }, now), false);
  assert.equal(base.shouldNotifyByTime({ publishedAt: "" }, now), false);
});

test("収集時に日時不明・未来日・8日超の記事を除外する", () => {
  const { __test } = loadHelpers(
    "netlify/functions/watch-ionq.js",
    ["isCollectableItemTime"]
  );
  const now = Date.parse("2026-07-17T12:00:00+09:00");
  assert.equal(__test.isCollectableItemTime({ publishedAt: "2026-07-17T11:00:00+09:00" }, now), true);
  assert.equal(__test.isCollectableItemTime({ publishedAt: "2026-07-08T11:00:00+09:00" }, now), false);
  assert.equal(__test.isCollectableItemTime({ publishedAt: "2026-07-17T12:10:00+09:00" }, now), false);
  assert.equal(__test.isCollectableItemTime({ publishedAt: "" }, now), false);
});

test("DiscordはIonQ直結の重要材料を優先し、薄い株価記事を除外する", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", [
    "newsPriorityScore", "isNotificationWorthy", "compareNewsPriority", "priorityReasonLabels"
  ]);
  const now = "2026-07-17T12:00:00+09:00";
  const contract = {
    title: "IonQ wins major government quantum computing contract",
    source: "IonQ IR",
    category: "ir",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const fluff = {
    title: "Should You Buy IonQ Stock Today? Price Prediction",
    source: "Market Blog",
    category: "news",
    publishedAt: "2026-07-17T11:30:00+09:00"
  };
  assert.equal(__test.isNotificationWorthy(contract, now), true);
  assert.equal(__test.isNotificationWorthy(fluff, now), false);
  assert.ok(__test.newsPriorityScore(contract, now) > __test.newsPriorityScore(fluff, now));
  assert.ok(__test.compareNewsPriority(contract, fluff, now) < 0);
  assert.deepEqual(Array.from(__test.priorityReasonLabels(contract)), ["IonQ直結", "一次情報", "重要材料"]);

  const mislabeled = {
    title: "Upcoming and recent IPOs calendar",
    source: "Yahoo Finance Singapore",
    label: "IONQ速報",
    category: "news",
    publishedAt: "2026-07-17T11:30:00+09:00"
  };
  assert.equal(__test.isNotificationWorthy(mislabeled, now), false);
  assert.equal(Array.from(__test.priorityReasonLabels(mislabeled)).includes("IonQ直結"), false);
});

test("投稿優先度は鮮度と分離し、時間経過だけでは変化しない", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", [
    "newsPriorityScore", "isImmediateNews", "isNotificationWorthy"
  ]);
  const important = {
    title: "IonQ wins major government quantum computing contract",
    source: "IonQ IR",
    category: "news",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const mentionOnly = {
    title: "IonQ mentioned in a weekly quantum stocks roundup",
    source: "Market Blog",
    category: "news",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const freshScore = __test.newsPriorityScore(important, "2026-07-17T12:00:00+09:00");
  const oldScore = __test.newsPriorityScore(important, "2026-07-20T12:00:00+09:00");
  assert.equal(freshScore, oldScore);
  assert.equal(__test.isImmediateNews(important, "2026-07-17T12:00:00+09:00"), true);
  assert.equal(__test.isNotificationWorthy(mentionOnly, "2026-07-17T12:00:00+09:00"), false);

  const recap = {
    title: "Looking back at IonQ's quarterly results and revenue",
    source: "Market Blog",
    category: "news",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  assert.ok(__test.newsPriorityScore(recap, "2026-07-17T12:00:00+09:00") < 60);

  const skytUnrelated = {
    title: "SkyWater opens a manufacturing training program",
    source: "Nasdaq/SKYT",
    ticker: "SKYT",
    category: "ir",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  assert.equal(__test.isNotificationWorthy(skytUnrelated, "2026-07-17T12:00:00+09:00"), false);
});

test("AI重要度は投稿価値を再評価し、速報候補も格下げできる", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", [
    "mergeAiPriorityScore", "parseAiPriorityResponse"
  ]);
  assert.equal(__test.mergeAiPriorityScore(35, 85), 68);
  assert.equal(__test.mergeAiPriorityScore(85, 10), 36);
  const parsed = __test.parseAiPriorityResponse('```json\n{"items":[{"id":"a","score":72,"reason":"大型契約"}]}\n```');
  assert.deepEqual(Array.from(parsed, (item) => ({ ...item })), [{ id: "a", score: 72, reason: "大型契約" }]);
});

test("金融ニュースは米株を動かすマクロ材料だけを採用する", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", [
    "isImportantMacroNews", "newsPriorityScore", "isNotificationWorthy"
  ]);
  const now = "2026-07-17T12:00:00+09:00";
  const macro = {
    title: "Federal Reserve rate cut lifts Nasdaq technology stocks",
    source: "Financial News",
    category: "macro",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const unrelated = {
    title: "Local bank opens a new branch downtown",
    source: "Local News",
    category: "macro",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  assert.equal(__test.isImportantMacroNews(macro), true);
  assert.equal(__test.isImportantMacroNews(unrelated), false);
  assert.equal(__test.isNotificationWorthy(macro, now), true);
  assert.ok(__test.newsPriorityScore(macro, now) >= 60);

  const officialCpi = {
    title: "Consumer Price Index Summary",
    source: "BLS CPI",
    category: "macro",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  assert.equal(__test.isImportantMacroNews(officialCpi), true);
  assert.equal(__test.isNotificationWorthy(officialCpi, now), true);

  const economicSignals = [
    ["US GDP growth beats forecasts as Nasdaq futures rise", true],
    ["Jobless claims jump and Wall Street stocks fall", true],
    ["Government shutdown fears rattle US markets", false],
    ["VIX spikes as technology stocks sell off", true],
    ["Weak Treasury auction pushes yields higher and pressures Nasdaq", true]
  ];
  economicSignals.forEach(([title, shouldNotify]) => {
    const item = { title, source: "Financial News", category: "macro", publishedAt: macro.publishedAt };
    assert.equal(__test.isImportantMacroNews(item), true, title);
    assert.equal(__test.isNotificationWorthy(item, now), shouldNotify, title);
  });
});

test("速報は即通知、投稿候補は朝夜まとめに分ける", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", [
    "isImmediateNews", "currentDigestSlot", "mergeDigestQueue"
  ]);
  const now = "2026-07-17T12:00:00+09:00";
  const important = {
    id: "important",
    title: "IonQ announces major government contract",
    source: "IonQ IR",
    category: "ir",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const macro = {
    id: "macro",
    title: "Federal Reserve rate cut lifts Nasdaq stocks",
    source: "Financial News",
    category: "macro",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  const crisis = {
    id: "crisis",
    title: "VIX spikes as bank crisis triggers market selloff",
    source: "Financial News",
    category: "macro",
    publishedAt: "2026-07-17T11:00:00+09:00"
  };
  assert.equal(__test.isImmediateNews(important, now), true);
  assert.equal(__test.isImmediateNews(macro, now), false);
  assert.equal(__test.isImmediateNews(crisis, now), true);
  assert.equal(__test.currentDigestSlot("2026-07-16T23:00:00Z"), "2026-07-17-08");
  assert.equal(__test.currentDigestSlot("2026-07-17T11:00:00Z"), "2026-07-17-20");
  assert.equal(__test.currentDigestSlot("2026-07-17T12:00:00Z"), "");
  assert.equal(__test.mergeDigestQueue([], [macro, macro], now, new Set()).length, 1);
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    ...macro,
    id: `candidate-${index}`,
    form: "TEST",
    publishedAt: `2026-07-17T${String(11 - index).padStart(2, "0")}:00:00+09:00`
  }));
  assert.equal(__test.mergeDigestQueue([], candidates, now, new Set()).length, 5);
});

test("Discord通知は6件以上でも5件単位に分割して全件を残す", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", ["splitNotificationBatches"]);
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}` }));
  const batches = __test.splitNotificationBatches(items, 5);
  assert.deepEqual(Array.from(batches, (batch) => batch.length), [5, 5, 2]);
  assert.deepEqual(Array.from(batches.flat(), (item) => item.id), Array.from(items, (item) => item.id));
});

test("通知先が未設定なら成功扱いにせず再試行可能なままにする", async () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", ["sendNotificationBatches"]);
  await assert.rejects(
    __test.sendNotificationBatches([{ id: "retry", title: "IonQ contract", url: "https://example.com" }]),
    /Notification target is not configured/
  );
});

test("IonQ公式ニュースページをGoogle Newsなしで直接読める", () => {
  const { __test } = loadHelpers("netlify/functions/watch-ionq.js", ["parseIonqOfficialHtml"]);
  const html = `
    <article><time>July 17, 2026</time><a href="/news/ionq-major-contract">
      <span>IonQ Wins Major Government Quantum Contract</span>
      <span>IonQ Press Release</span>
    </a></article>`;
  const items = __test.parseIonqOfficialHtml(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "IonQ公式");
  assert.equal(items[0].url, "https://www.ionq.com/news/ionq-major-contract");
  assert.match(items[0].publishedAt, /^2026-07-17/);
});

test("画面に収集元の状態と米国市場時間帯を表示する", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="sources">収集 --/);
  assert.match(html, /function renderSourceHealth/);
  assert.match(html, /function marketSessionLabel/);
  assert.match(html, /米プレ/);
  assert.match(html, /米市場中/);
  assert.match(html, /米アフター/);
});

test("画面では日時不明の記事を新着扱いしない", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /function isFreshItem[\s\S]*if \(!Number\.isFinite\(ms\)\) return false;/);
  assert.match(html, /age >= -5 \* 60 \* 1000/);
});

test("スマホでも投稿済み操作を表示し、速報の週間まとめを作れる", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(html, /id="weeklyDigest"[^>]*>🚨速報の週間まとめ/);
  assert.match(html, /id="markAllPosted"[^>]*>表示中を投稿済み/);
  assert.match(html, /id="clearPosted"[^>]*>投稿済みクリア/);
  assert.doesNotMatch(html, /\.toolbar-row \.secondary-action\s*\{\s*display:\s*none/);
  assert.match(html, /function weeklyPriorityItems[\s\S]*isWithinHours\(item, 168\)[\s\S]*postTier\(item\) === 0/);
  assert.match(html, /function buildWeeklyDigestText/);
  assert.match(html, /const WEEKLY_GPTS_URL = "https:\/\/chatgpt\.com\/g\/g-6a629ec2cb7c81919c4f72700a4839c6-liang-zi-zhou-jian-rehoto"/);
  assert.match(html, /window\.open\(WEEKLY_GPTS_URL, "_blank"\)/);
  assert.match(html, /スレッドには分割しないでください/);
  assert.match(html, /投稿済みの記事も振り返り対象に含みます/);
});

test("Jina Reader URLは元URLを一度だけ連結する", () => {
  const { __test } = loadHelpers("netlify/functions/report.js", ["readerUrls"]);
  assert.deepEqual(
    Array.from(__test.readerUrls("https://example.com/article")),
    ["https://r.jina.ai/https://example.com/article"]
  );
});

test("report APIはSecret未設定時に停止する", async () => {
  const report = loadHelpers("netlify/functions/report.js", ["readerUrls"]);
  const response = await report.handler({ httpMethod: "POST", headers: {}, body: "{}" });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, "report_secret_not_configured");
});
