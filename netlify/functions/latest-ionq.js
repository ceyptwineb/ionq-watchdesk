// IONQ Watchdesk - フロント向けAPI
// 変更点: 毎回のフル収集をやめ、watch-ionq(cron 5分おき)が書いたBlobキャッシュを返すだけにした。
// - ページを何回開いてもタイムアウトしない・外部APIを叩かない・表示が一瞬で出る
// - キャッシュが無い/古い(30分超)場合のみ、軽量ライブ収集(SEC + Nasdaqワイヤーのみ)にフォールバック

const STORE_NAME = "ionq-watchdesk";
const CACHE_KEY = "latest-cache";
const CACHE_STALE_MINUTES = 30;
const SEC_CIK = "0001824920";
const FETCH_TIMEOUT_MS = 6000;

const WIRE_FEEDS = [
  { source: "Nasdaq/IONQ", ticker: "IONQ", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=IONQ", type: "IR" },
  { source: "Nasdaq/SKYT", ticker: "SKYT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=SKYT", type: "IR" }
];

exports.handler = async (event = {}) => {
  try {
    await connectBlobs(event);

    const cached = await readCache();
    if (cached && isCacheFresh(cached)) {
      return json(200, { ...cached, cacheStatus: "hit" });
    }

    // フォールバック: キャッシュが無い(初回デプロイ直後など)か古い場合のみ軽量ライブ収集
    const live = await lightCollect();
    const decorated = await decorateJapanese(live, cached);
    return json(200, {
      updatedAt: new Date().toISOString(),
      cachedAt: cached ? cached.cachedAt : null,
      items: decorated,
      cacheStatus: cached ? "stale_fallback" : "miss_fallback",
      note: "キャッシュ未生成のため軽量収集で応答。数分後にwatch-ionqが全ソースを収集します。"
    });
  } catch (error) {
    return json(500, {
      updatedAt: new Date().toISOString(),
      error: "latest_fetch_failed",
      message: error.message
    });
  }
};

function isCacheFresh(cached) {
  const ms = Date.parse(cached.cachedAt || cached.updatedAt || "");
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= CACHE_STALE_MINUTES * 60 * 1000;
}

// ---------------------------------------------------------------- 軽量ライブ収集

async function lightCollect() {
  const [sec, wires] = await Promise.all([
    safeGetSec(),
    safeGetWires()
  ]);
  const items = [];

  sec.filter(isImportantSec).forEach((item) => items.push(withId({
    type: "SEC",
    category: "sec",
    label: "重要SEC",
    title: `SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: "SEC EDGAR",
    kind: "SEC開示",
    form: item.form,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt
  })));

  wires.forEach((item) => items.push(withId({
    type: "IR",
    category: "ir",
    label: "ワイヤー速報",
    title: item.title,
    url: item.url,
    source: item.source,
    kind: "IR・提携",
    ticker: item.ticker,
    publishedAt: item.publishedAt
  })));

  const seen = new Set();
  return items
    .filter((item) => item.title || item.url)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt || b.acceptedAt || 0) - Date.parse(a.publishedAt || a.acceptedAt || 0));
}

async function safeGetSec() {
  try {
    const response = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, {
      headers: {
        "User-Agent": process.env.SEC_USER_AGENT || "IONQ Watchdesk contact@example.com",
        "Accept": "application/json"
      }
    });
    if (!response.ok) return [];
    const data = await response.json();
    const recent = data.filings && data.filings.recent ? data.filings.recent : {};
    const forms = recent.form || [];
    return forms.slice(0, 30).map((form, index) => {
      const accession = recent.accessionNumber[index];
      const accessionPath = accession.replace(/-/g, "");
      const cikPath = String(Number(SEC_CIK));
      return {
        form,
        filingDate: recent.filingDate[index],
        acceptedAt: recent.acceptanceDateTime[index] || "",
        description: recent.primaryDocDescription[index] || recent.form[index],
        url: `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}/${recent.primaryDocument[index]}`
      };
    });
  } catch (error) {
    return [];
  }
}

async function safeGetWires() {
  const batches = await Promise.all(WIRE_FEEDS.map(async (feed) => {
    try {
      const response = await fetchWithTimeout(feed.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept": "application/rss+xml,application/xml,text/xml,*/*"
        }
      });
      if (!response.ok) return [];
      const xml = await response.text();
      return parseItems(xml, feed.source).slice(0, 15).map((item) => ({ ...item, ticker: feed.ticker }));
    } catch (error) {
      return [];
    }
  }));
  return batches.flat();
}

// フォールバック応答でも日本語表示を維持する。
// SECは静的マップで即日本語化、ニュースは翻訳キャッシュ(watch-ionqが蓄積)を再利用。
const SEC_FORM_JA = {
  "8-K": "臨時報告（重要イベント発生）",
  "8-K/A": "臨時報告の訂正",
  "10-Q": "四半期報告",
  "10-K": "年次報告",
  "S-3": "増資・売出の事前登録",
  "S-8": "従業員株式報酬の登録",
  "424B3": "目論見書（売出条件）",
  "424B5": "目論見書（増資・売出条件）",
  "DEF 14A": "株主総会招集通知（委任状）",
  "PRE 14A": "株主総会招集通知（事前版）",
  "SC 13D": "大量保有報告（5%超・支配目的あり）",
  "SC 13G": "大量保有報告（5%超・純投資）"
};

async function decorateJapanese(items, cached) {
  let translateCache = {};
  try {
    const { getStore } = await import("@netlify/blobs");
    const opts = { name: STORE_NAME };
    const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
    if (siteID && token) { opts.siteID = siteID; opts.token = token; }
    const store = getStore(opts);
    const raw = await store.get("translate-cache");
    translateCache = raw ? JSON.parse(raw) : {};
  } catch (error) {
    translateCache = {};
  }

  // 古いキャッシュに同じ記事の和訳があればそれも拾う
  const cachedJa = new Map();
  ((cached && cached.items) || []).forEach((item) => {
    if (item.titleJa) cachedJa.set(item.id, item.titleJa);
  });

  return items.map((item) => {
    if (item.form) {
      const form = String(item.form || "").toUpperCase();
      const ja = SEC_FORM_JA[form] || secPrefixJa(form);
      return ja ? { ...item, titleJa: `SEC ${form}: ${ja}` } : item;
    }
    const ja = translateCache[normalizeSignature(item.title)] || cachedJa.get(item.id);
    return ja ? { ...item, titleJa: ja } : item;
  });
}

function secPrefixJa(form) {
  if (form.startsWith("424B")) return "目論見書（増資・売出条件）";
  if (form.startsWith("SC 13D")) return "大量保有報告（支配目的あり）";
  if (form.startsWith("SC 13G")) return "大量保有報告（純投資）";
  if (form.startsWith("S-3")) return "増資・売出の事前登録";
  if (form.startsWith("10-Q")) return "四半期報告";
  if (form.startsWith("10-K")) return "年次報告";
  if (form.startsWith("8-K")) return "臨時報告（重要イベント発生）";
  return "";
}

function isImportantSec(item) {
  const form = String(item.form || "").toUpperCase();
  const description = String(item.description || "").toUpperCase();
  if (["3", "4", "5", "144"].includes(form)) return false;
  if (description.includes("OWNERSHIP")) return false;
  return /8-K|10-Q|10-K|S-3|424B|DEF 14A|PRE 14A|SC 13|13D|13G/.test(form) ||
    /PROSPECTUS|CURRENT REPORT|QUARTERLY|ANNUAL/.test(description);
}

// 統一ID: watch-ionq.js / index.html と完全に同じロジック。変更時は3ファイル同時に。
function withId(item) {
  return { ...item, id: stableId(item) };
}

function stableId(item) {
  const basis = item.form
    ? `${item.type}|${item.url || item.title || ""}`
    : `${item.type}|${normalizeSignature(item.title)}`;
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "n" + (hash >>> 0).toString(16);
}

function normalizeSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+-\s+[^-|]+$/g, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- Blobs/HTTP/XML

async function connectBlobs(event) {
  try {
    const { connectLambda } = await import("@netlify/blobs");
    if (typeof connectLambda === "function") connectLambda(event);
  } catch (error) {
    console.warn("connectLambda unavailable:", error.message);
  }
}

async function readCache() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const opts = { name: STORE_NAME };
    const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
    if (siteID && token) {
      opts.siteID = siteID;
      opts.token = token;
    }
    const store = getStore(opts);
    const value = await store.get(CACHE_KEY);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn("cache read failed:", error.message);
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseItems(xml, fallbackSource = "") {
  const items = [];
  const itemMatches = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (const itemXml of itemMatches) {
    items.push({
      title: cleanXml(readTag(itemXml, "title")),
      url: cleanXml(readTag(itemXml, "link")),
      publishedAt: cleanXml(readTag(itemXml, "pubDate")),
      source: cleanXml(readTag(itemXml, "source")) || fallbackSource
    });
  }
  return items.filter((item) => item.title || item.url);
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
