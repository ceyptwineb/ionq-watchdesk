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

test("Cronは30分間隔", () => {
  const config = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.match(config, /schedule\s*=\s*"\*\/30 \* \* \* \*"/);
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

test("キャッシュは30分Cronに余裕を持たせ、未来時刻は拒否する", () => {
  const { __test } = loadHelpers("netlify/functions/latest-ionq.js", ["isCacheFresh"]);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() - 70 * 60 * 1000).toISOString() }), true);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() - 80 * 60 * 1000).toISOString() }), false);
  assert.equal(__test.isCacheFresh({ cachedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }), false);
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
