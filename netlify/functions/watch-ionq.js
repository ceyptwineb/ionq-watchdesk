const crypto = require("node:crypto");

const SEC_CIK = "0001824920";
const COMPETITOR_TICKERS = ["RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "MSFT", "AMZN", "HON", "NVDA"];
const STORE_NAME = "ionq-watchdesk";
const STATE_KEY = "watch-state";
const POSTED_KEY = "posted-state";
const DEFAULT_LOOKBACK_MINUTES = 1440;
const SITE_URL = (process.env.WATCHDESK_URL || "https://ionqrnews.netlify.app/").trim();

exports.handler = async (event = {}) => {
  const startedAt = new Date().toISOString();

  try {
    await connectBlobs(event);
    if (event.queryStringParameters && event.queryStringParameters.test === "discord") {
      const testItem = {
        title: "通知テスト: IONQ Watchdesk",
        url: "https://ionqrnews.netlify.app/",
        source: "watch-ionq",
        publishedAt: startedAt
      };
      await sendNotification(testItem, 1, { requireTarget: true });
      return json(200, {
        ok: true,
        result: "discord_test_sent",
        webhookConfigured: Boolean(getDiscordWebhookUrl())
      });
    }

    const data = await collectLatest();
    const items = normalizeLatestItems(data);
    const state = await readState();
    const postedIds = new Set([...(state.postedIds || []), ...(await readPostedIds())]);
    const notifiedIds = new Set(state.notifiedIds || []);
    const knownIds = new Set([...(state.knownIds || []), ...(state.notifiedIds || [])]);
    const currentIds = items.map((item) => item.id).filter(Boolean);

    if (event.queryStringParameters && event.queryStringParameters.seed === "1") {
      currentIds.forEach((id) => knownIds.add(id));
      await writeState({
        ...state,
        knownIds: [...knownIds].slice(-1000),
        initializedAt: state.initializedAt || startedAt,
        lastCheckedAt: startedAt,
        lastResult: "seeded"
      });
      return json(200, {
        ok: true,
        result: "seeded",
        count: currentIds.length,
        message: "現在表示されている候補を既読扱いにしました。次回以降の新着だけ通知します。"
      });
    }

    if (event.queryStringParameters && event.queryStringParameters.debug === "1") {
      return json(200, {
        ok: true,
        checkedAt: startedAt,
        webhookConfigured: Boolean(getDiscordWebhookUrl()),
        lookbackMinutes: effectiveLookbackMinutes(),
        totalItems: items.length,
        items: items.slice(0, 30).map((item) => ({
          title: item.title,
          kind: item.kind,
          source: item.source,
          publishedAt: item.publishedAt,
          acceptedAt: item.acceptedAt,
          notify: !postedIds.has(item.id) &&
            !postedIds.has(item.postedId) &&
            !notifiedIds.has(item.id) &&
            !knownIds.has(item.id) &&
            !isLowSignalSec(item) &&
            shouldNotifyByTime(item, startedAt),
          reason: notificationReason(item, startedAt, postedIds, notifiedIds, knownIds),
          id: item.id,
          postedId: item.postedId,
          url: item.url
        }))
      });
    }

    if (event.queryStringParameters && event.queryStringParameters.test === "current") {
      const item = items.find((entry) => !isLowSignalSec(entry));
      if (!item) return json(200, { ok: false, result: "no_items_to_test" });
      await sendNotification(item, 1, { requireTarget: true });
      return json(200, {
        ok: true,
        result: "current_item_test_sent",
        item: item.title,
        webhookConfigured: Boolean(getDiscordWebhookUrl())
      });
    }

    if (!state.initializedAt && !state.knownIds && process.env.NOTIFY_ALL_CURRENT !== "true") {
      currentIds.forEach((id) => knownIds.add(id));
      await writeState({
        ...state,
        knownIds: [...knownIds].slice(-1000),
        initializedAt: startedAt,
        lastCheckedAt: startedAt,
        lastResult: "seeded_initial"
      });
      return json(200, {
        ok: true,
        result: "seeded_initial",
        checkedAt: startedAt,
        totalItems: items.length,
        message: "初回実行のため、既存記事は通知せず既読登録しました。"
      });
    }

    const fresh = items.filter((item) =>
      !postedIds.has(item.id) &&
      !postedIds.has(item.postedId) &&
      !notifiedIds.has(item.id) &&
      !knownIds.has(item.id) &&
      !isLowSignalSec(item) &&
      shouldNotifyByTime(item, startedAt)
    );

    if (!fresh.length) {
      await writeState({
        ...state,
        knownIds: mergeRecentIds(knownIds, currentIds),
        lastCheckedAt: startedAt,
        lastResult: "no_new_items"
      });
      return json(200, {
        ok: true,
        result: "no_new_items",
        checkedAt: startedAt,
        totalItems: items.length,
        webhookConfigured: Boolean(getDiscordWebhookUrl()),
        lookbackMinutes: effectiveLookbackMinutes()
      });
    }

    const item = fresh[0];
    await sendNotification(item, fresh.length);

    fresh.forEach((entry) => notifiedIds.add(entry.id));
    await writeState({
      ...state,
      notifiedIds: [...notifiedIds].slice(-500),
      knownIds: mergeRecentIds(knownIds, currentIds),
      initializedAt: state.initializedAt || startedAt,
      lastCheckedAt: startedAt,
      lastNotifiedAt: startedAt,
      lastItem: item,
      lastResult: "notified"
    });

    return json(200, {
      ok: true,
      result: "notified",
      count: fresh.length,
      item: item.title
    });
  } catch (error) {
    console.error(error);
    return json(500, {
      ok: false,
      error: error.message
    });
  }
};

async function collectLatest() {
  const [sec, officialNews, marketNews, quantumNews, competitorSec, competitorNews] = await Promise.all([
    getSecFilings(),
    getGoogleNews("site:investors.ionq.com/news/news-details IonQ"),
    getGoogleNews("IONQ OR $IONQ"),
    getGoogleNews("\"quantum computing\" OR \"quantum computer\" OR \"quantum technology\" -IONQ -$IONQ"),
    getCompetitorSecFilings(),
    getGoogleNews("(Rigetti OR RGTI OR D-Wave OR QBTS OR \"Quantum Computing Inc\" OR QUBT OR Quantinuum OR \"IBM quantum\" OR \"Google quantum\" OR \"Microsoft quantum\" OR \"AWS Braket\" OR \"NVIDIA quantum\")")
  ]);

  return {
    updatedAt: new Date().toISOString(),
    sec,
    officialNews,
    marketNews,
    quantumNews,
    competitorSec,
    competitorNews
  };
}

async function getSecFilings() {
  return getSecFilingsByCik(SEC_CIK, "IONQ");
}

async function getCompetitorSecFilings() {
  let companies;
  try {
    companies = await getCompanyTickerMap();
  } catch (error) {
    console.warn(`Competitor SEC ticker map failed: ${error.message}`);
    return [];
  }
  const filings = await Promise.all(COMPETITOR_TICKERS.map(async (ticker) => {
    const company = companies.get(ticker);
    if (!company) return [];
    try {
      return await getSecFilingsByCik(company.cik, ticker, company.name);
    } catch (error) {
      console.warn(`Competitor SEC failed for ${ticker}: ${error.message}`);
      return [];
    }
  }));
  return filings.flat().filter(isImportantSec).slice(0, 24);
}

async function getCompanyTickerMap() {
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: {
      "User-Agent": process.env.SEC_USER_AGENT || "IONQ Watchdesk contact@example.com",
      "Accept": "application/json"
    }
  });
  if (!response.ok) throw new Error(`SEC ticker request failed: ${response.status}`);
  const payload = await response.json();
  const map = new Map();
  Object.values(payload).forEach((entry) => {
    map.set(String(entry.ticker || "").toUpperCase(), {
      cik: String(entry.cik_str).padStart(10, "0"),
      name: entry.title || entry.ticker
    });
  });
  return map;
}

async function getSecFilingsByCik(cik, ticker, companyName = ticker) {
  const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: {
      "User-Agent": process.env.SEC_USER_AGENT || "IONQ Watchdesk contact@example.com",
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error(`SEC request failed for ${ticker}: ${response.status}`);

  const data = await response.json();
  const recent = data.filings && data.filings.recent ? data.filings.recent : {};
  const forms = recent.form || [];

  return forms.slice(0, 50).map((form, index) => {
    const accession = recent.accessionNumber[index];
    const accessionPath = accession.replace(/-/g, "");
    const cikPath = String(Number(cik));
    return {
      ticker,
      companyName,
      form,
      filingDate: recent.filingDate[index],
      reportDate: recent.reportDate[index] || "",
      acceptedAt: recent.acceptanceDateTime[index] || "",
      accessionNumber: accession,
      primaryDocument: recent.primaryDocument[index],
      description: recent.primaryDocDescription[index] || recent.form[index],
      url: `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}/${recent.primaryDocument[index]}`
    };
  });
}

async function getGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}%20when%3A7d&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "IONQ Watchdesk contact@example.com",
      "Accept": "application/rss+xml,text/xml"
    }
  });

  if (!response.ok) throw new Error(`Google News request failed: ${response.status}`);

  const xml = await response.text();
  return parseItems(xml).slice(0, 8);
}

async function getXPosts() {
  if (!process.env.X_BEARER_TOKEN) return [];

  const bearerToken = process.env.X_BEARER_TOKEN
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!bearerToken) return [];

  const listId = process.env.X_LIST_ID || "2068093425489264980";
  const params = new URLSearchParams({
    max_results: "25",
    "tweet.fields": "created_at,public_metrics,author_id,lang",
    expansions: "author_id",
    "user.fields": "username,name,verified"
  });

  const response = await fetch(`https://api.x.com/2/lists/${listId}/tweets?${params}`, {
    headers: {
      "Authorization": `Bearer ${bearerToken}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    console.warn(`X request failed: ${response.status}`);
    return [];
  }

  const payload = await response.json();
  const users = new Map((payload.includes && payload.includes.users || []).map((user) => [user.id, user]));

  return (payload.data || []).map((post) => {
    const user = users.get(post.author_id) || {};
    return {
      title: post.text,
      url: user.username ? `https://x.com/${user.username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`,
      source: user.username ? `@${user.username}` : "X",
      kind: "X投稿",
      curatedList: true,
      publishedAt: post.created_at,
      metrics: post.public_metrics || {}
    };
  });
}

function normalizeLatestItems(data) {
  const items = [];

  data.sec.filter(isImportantSec).forEach((item) => items.push(withId({
    type: "SEC",
    title: `SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: "SEC EDGAR",
    kind: "SEC開示",
    form: item.form,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt,
    notes: `提出日: ${item.filingDate}\nフォーム: ${item.form}\n内容はSEC本文で確認`
  })));

  data.officialNews.forEach((item) => items.push(withId({
    type: "IR",
    title: item.title,
    url: item.url,
    source: item.source || "IonQ IR",
    kind: "IR・提携",
    publishedAt: item.publishedAt,
    notes: `公式IR系の最新候補\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  data.marketNews.forEach((item) => items.push(withId({
    type: "NEWS",
    title: item.title,
    url: item.url,
    source: item.source || "News",
    kind: "株価材料",
    publishedAt: item.publishedAt,
    notes: `市場ニュースの最新候補\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  (data.quantumNews || []).forEach((item) => items.push(withId({
    type: "QNEWS",
    title: item.title,
    url: item.url,
    source: item.source || "Quantum News",
    kind: "量子業界",
    publishedAt: item.publishedAt,
    notes: `量子業界ニュースの最新候補\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  (data.competitorSec || []).forEach((item) => items.push(withId({
    type: "CIRS",
    title: `${item.ticker || "競合"} SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: `${item.ticker || "競合"} SEC`,
    kind: "競合IR/SEC",
    form: item.form,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt,
    notes: `競合SEC\n企業: ${item.ticker || item.companyName || "競合"}\nフォーム: ${item.form}`
  })));

  (data.competitorNews || []).forEach((item) => items.push(withId({
    type: "CIRS",
    title: item.title,
    url: item.url,
    source: item.source || "Competitor IR",
    kind: "競合IR/SEC",
    publishedAt: item.publishedAt,
    notes: `競合・周辺企業ニュース\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  (data.xPosts || []).forEach((item) => items.push(withId({
    type: "X",
    title: item.title,
    url: item.url,
    source: item.source || "X",
    kind: "X投稿",
    publishedAt: item.publishedAt,
    notes: `X上の反応候補\n投稿者: ${item.source || "X"}\n一次情報ではないため公式IR・SECで照合`
  })));

  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function withId(item) {
  return {
    ...item,
    id: crypto.createHash("sha256").update(dedupeBasis(item)).digest("hex"),
    postedId: frontendItemId(item)
  };
}

// 通知の重複防止に使う安定キー。
// SEC等の提出書類はaccessionを含むURLが固定なのでURLを使う。
// ニュースはGoogle NewsのリンクがトラッキングトークンでブレるためURLを使わず、
// 正規化したタイトル+ソースを使う（同じ記事を再通知しないため）。
function dedupeBasis(item) {
  if (item.form) return `filing|${item.url || item.title || ""}`;
  return `news|${normalizeSignature(`${item.title || ""}|${item.source || ""}`)}`;
}

function normalizeSignature(text) {
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+-\s+[^-|]+$/g, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

function frontendItemId(item) {
  const basis = item.form
    ? `${item.type}|${item.url || ""}`
    : `${item.type}|${normalizeSignature(item.title)}|${item.source || ""}`;
  return encodeURIComponent(basis).slice(0, 500);
}

function isLowSignalSec(item) {
  if (item.kind !== "SEC開示") return false;
  const form = String(item.form || "").toUpperCase();
  const text = `${item.title || ""} ${item.description || ""}`.toUpperCase();
  if (["3", "4", "5", "144"].includes(form)) return true;
  return text.includes("FORM 4") || text.includes("OWNERSHIP");
}

function isImportantSec(item) {
  const form = String(item.form || "").toUpperCase();
  const description = String(item.description || "").toUpperCase();
  if (["3", "4", "5", "144"].includes(form)) return false;
  if (description.includes("OWNERSHIP")) return false;
  return /8-K|10-Q|10-K|S-3|424B|DEF 14A|PRE 14A|SC 13|13D|13G/.test(form) ||
    /PROSPECTUS|CURRENT REPORT|QUARTERLY|ANNUAL/.test(description);
}

function shouldNotifyByTime(item, nowValue) {
  if (process.env.NOTIFY_ALL_CURRENT === "true") return true;

  const baseline = process.env.WATCH_BASELINE_AT
    ? Date.parse(process.env.WATCH_BASELINE_AT)
    : Date.parse("2026-06-19T15:05:00+09:00");
  const itemTime = parseItemTime(item);

  if (!itemTime) return false;
  if (Number.isFinite(baseline) && itemTime <= baseline) return false;

  const now = Date.parse(nowValue);
  const lookbackMinutes = effectiveLookbackMinutes();
  const oldestAllowed = now - lookbackMinutes * 60 * 1000;

  return itemTime >= oldestAllowed && itemTime <= now + 2 * 60 * 1000;
}

function notificationReason(item, nowValue, postedIds, notifiedIds, knownIds = new Set()) {
  if (postedIds.has(item.id) || postedIds.has(item.postedId)) return "posted";
  if (notifiedIds.has(item.id)) return "already_notified";
  if (knownIds.has(item.id)) return "already_known";
  if (isLowSignalSec(item)) return "low_signal_sec";
  const itemTime = parseItemTime(item);
  if (!itemTime) return "no_valid_time";
  const baseline = process.env.WATCH_BASELINE_AT
    ? Date.parse(process.env.WATCH_BASELINE_AT)
    : Date.parse("2026-06-19T15:05:00+09:00");
  if (Number.isFinite(baseline) && itemTime <= baseline) return "before_baseline";
  const now = Date.parse(nowValue);
  const lookbackMinutes = effectiveLookbackMinutes();
  const oldestAllowed = now - lookbackMinutes * 60 * 1000;
  if (itemTime < oldestAllowed) return "older_than_lookback";
  if (itemTime > now + 2 * 60 * 1000) return "future_time";
  return "will_notify";
}

function effectiveLookbackMinutes() {
  const configured = Number(process.env.WATCH_LOOKBACK_MINUTES || DEFAULT_LOOKBACK_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_LOOKBACK_MINUTES;
  return Math.max(configured, DEFAULT_LOOKBACK_MINUTES);
}

function mergeRecentIds(existingIds, newIds) {
  const merged = new Set(existingIds);
  newIds.forEach((id) => {
    if (id) merged.add(id);
  });
  return [...merged].slice(-1000);
}

function parseItemTime(item) {
  const value = item.acceptedAt || item.publishedAt;
  if (!value) return null;

  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? value
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

async function sendNotification(item, count, options = {}) {
  const title = count > 1 ? `IONQ新着 ${count}件` : "IONQ新着";
  const message = `${title}\n${item.title}\n${item.source || ""} ${item.publishedAt || ""}\n${item.url}`;

  if (getDiscordWebhookUrl()) {
    await sendDiscord(item, title);
    return;
  }

  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    await sendPushover(title, message, item.url);
    return;
  }

  if (options.requireTarget) {
    throw new Error("Notification target is not configured. Set DISCORD_WEBHOOK_URL in Netlify environment variables.");
  }

  console.log("No notification target configured. Set DISCORD_WEBHOOK_URL or PUSHOVER_USER_KEY/PUSHOVER_APP_TOKEN.");
}

async function sendDiscord(item, title) {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is empty.");

  const jst = formatJst(item.acceptedAt || item.publishedAt);
  const hasUrl = /^https?:\/\//i.test(String(item.url || ""));
  const descriptionLines = [
    item.source ? `**${item.source}**` : null,
    jst ? `🕒 ${jst}` : null,
    `🔗 [Watchdeskを開く](${SITE_URL})`
  ].filter(Boolean);

  const embed = {
    title: truncate(item.title, 240),
    url: hasUrl ? item.url : undefined,
    description: descriptionLines.join("\n"),
    color: 0x2458c6
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `**${title}**`,
      embeds: [embed]
    })
  });

  if (!response.ok) throw new Error(`Discord webhook failed: ${response.status}`);
}

function formatJst(value) {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(ms)) + " JST";
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function getDiscordWebhookUrl() {
  const value = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK || process.env.WEBHOOK_URL || "";
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

async function sendPushover(title, message, url) {
  const response = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: process.env.PUSHOVER_APP_TOKEN,
      user: process.env.PUSHOVER_USER_KEY,
      title,
      message,
      url
    })
  });

  if (!response.ok) throw new Error(`Pushover failed: ${response.status}`);
}

// Lambda形式の関数ではNetlify Blobsのコンテキストをイベントから接続する必要がある。
// これが無いと "environment has not been configured to use Netlify Blobs" になり、
// 通知の重複防止が一切効かず毎回再通知してしまう。
async function connectBlobs(event) {
  try {
    const { connectLambda } = await import("@netlify/blobs");
    if (typeof connectLambda === "function") connectLambda(event);
  } catch (error) {
    console.warn("connectLambda unavailable:", error.message);
  }
}

async function openStore() {
  const { getStore } = await import("@netlify/blobs");
  const opts = { name: STORE_NAME };
  // 自動構成が効かない環境向けのフォールバック（環境変数があれば明示指定）
  const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    opts.siteID = siteID;
    opts.token = token;
  }
  return getStore(opts);
}

async function readState() {
  try {
    // cronは5分間隔なので、前回の書き込みはeventual整合でも十分に伝播済み。
    // strong整合はこの実行環境(uncachedEdgeURL未設定)では使えないため既定を使う。
    const store = await openStore();
    const value = await store.get(STATE_KEY);
    return value ? JSON.parse(value) : {};
  } catch (error) {
    console.warn("Could not read state. Continuing without persistent dedupe.", error.message);
    return {
      notifiedIds: [],
      postedIds: [],
      storageUnavailable: true
    };
  }
}

async function readPostedIds() {
  try {
    const store = await openStore();
    const value = await store.get(POSTED_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch (error) {
    console.warn("Could not read posted state. Continuing without posted filter.", error.message);
    return [];
  }
}

async function writeState(state) {
  try {
    if (state.storageUnavailable) return;
    const store = await openStore();
    await store.set(STATE_KEY, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("Could not write state. Notification was still processed.", error.message);
  }
}

function parseItems(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  for (const itemXml of itemMatches) {
    items.push({
      title: cleanXml(readTag(itemXml, "title")),
      url: cleanXml(readTag(itemXml, "link")),
      publishedAt: cleanXml(readTag(itemXml, "pubDate")),
      source: cleanXml(readTag(itemXml, "source"))
    });
  }

  return items;
}

function readTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : "";
}

function cleanXml(value) {
  return value
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
