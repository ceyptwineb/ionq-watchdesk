// IONQ Watchdesk - 収集・通知の中核（cron実行）
// 変更点:
// - Nasdaq銘柄別RSS(ワイヤー配信の準リアルタイム中継)を一次ソースとして追加
// - Google Newsは when:1d の速報クエリ + when:7d の補完クエリに分離、取得数 8→25
// - 収集結果をNetlify Blobsにキャッシュし、latest-ionqはBlobを読むだけにする
// - 記事ID(FNVハッシュ)をフロントと完全に統一。投稿済みフィルタが実際に効くようになる
// - 翻訳をこの関数に移動し、Blobキャッシュで再翻訳を防ぐ
// - Discord通知は最大5件のembedをまとめて送信
// - getXPosts(未使用)を削除

const SEC_CIK = "0001824920";
const COMPETITOR_TICKERS = ["RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "MSFT", "AMZN", "HON", "NVDA"];

// ワイヤー配信をほぼリアルタイムで中継する銘柄別フィード。
// SKYTは買収クローズまで実質IonQ関連の一次情報源。
const WIRE_FEEDS = [
  { source: "Nasdaq/IONQ", ticker: "IONQ", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=IONQ", type: "IR" },
  { source: "Nasdaq/SKYT", ticker: "SKYT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=SKYT", type: "IR" },
  { source: "Nasdaq/RGTI", ticker: "RGTI", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=RGTI", type: "CNEWS" },
  { source: "Nasdaq/QBTS", ticker: "QBTS", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=QBTS", type: "CNEWS" },
  { source: "Nasdaq/QUBT", ticker: "QUBT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=QUBT", type: "CNEWS" }
];

const QUANTUM_RSS_FEEDS = [
  { source: "The Quantum Insider", url: "https://thequantuminsider.com/feed/" },
  { source: "Quantum Computing Report", url: "https://quantumcomputingreport.com/feed/" },
  { source: "Inside Quantum Technology", url: "https://www.insidequantumtechnology.com/feed/" },
  { source: "Quantum Zeitgeist", url: "https://quantumzeitgeist.com/feed/" },
  { source: "HPCwire", url: "https://www.hpcwire.com/feed/" }
];

const STORE_NAME = "ionq-watchdesk";
const STATE_KEY = "watch-state";
const POSTED_KEY = "posted-state";
const CACHE_KEY = "latest-cache";
const TRANSLATE_KEY = "translate-cache";
const GOOGLE_NEWS_LIMIT = 25;
const MAX_TRANSLATE_PER_RUN = 15;
const MAX_NOTIFY_EMBEDS = 5;
const DEFAULT_LOOKBACK_MINUTES = 1440;
const FETCH_TIMEOUT_MS = 6000;
const WATCHDESK_FALLBACK_URL = "https://ionqwatchdesk.netlify.app/";
const SITE_URL = (process.env.WATCHDESK_URL || WATCHDESK_FALLBACK_URL).trim() || WATCHDESK_FALLBACK_URL;

exports.handler = async (event = {}) => {
  const startedAt = new Date().toISOString();

  try {
    await connectBlobs(event);
    const qs = event.queryStringParameters || {};

    if (qs.test === "discord") {
      await sendNotification([{
        title: "通知テスト: IONQ Watchdesk",
        url: SITE_URL,
        source: "watch-ionq",
        publishedAt: startedAt
      }], { requireTarget: true });
      return json(200, { ok: true, result: "discord_test_sent", webhookConfigured: Boolean(getDiscordWebhookUrl()) });
    }

    // 収集 → 正規化(統一ID付与) → 翻訳 → キャッシュ書き込み
    const collected = await collectLatest();
    let items = normalizeLatestItems(collected);
    items = await applyTranslations(items);

    await writeCache({
      updatedAt: startedAt,
      cachedAt: startedAt,
      items,
      sourceStats: collected.stats
    });

    const state = await readState();
    const postedIds = new Set([...(state.postedIds || []), ...(await readPostedIds())]);
    const notifiedIds = new Set(state.notifiedIds || []);
    const knownIds = new Set([...(state.knownIds || []), ...(state.notifiedIds || [])]);
    const currentIds = items.map((item) => item.id).filter(Boolean);

    if (qs.seed === "1") {
      currentIds.forEach((id) => knownIds.add(id));
      await writeState({
        ...state,
        knownIds: [...knownIds].slice(-1500),
        initializedAt: state.initializedAt || startedAt,
        lastCheckedAt: startedAt,
        lastResult: "seeded"
      });
      return json(200, { ok: true, result: "seeded", count: currentIds.length });
    }

    if (qs.debug === "1") {
      return json(200, {
        ok: true,
        checkedAt: startedAt,
        webhookConfigured: Boolean(getDiscordWebhookUrl()),
        lookbackMinutes: effectiveLookbackMinutes(),
        totalItems: items.length,
        sourceStats: collected.stats,
        items: items.slice(0, 30).map((item) => ({
          title: item.title,
          kind: item.kind,
          source: item.source,
          publishedAt: item.publishedAt,
          reason: notificationReason(item, startedAt, postedIds, notifiedIds, knownIds),
          id: item.id,
          url: item.url
        }))
      });
    }

    if (!state.initializedAt && !state.knownIds && process.env.NOTIFY_ALL_CURRENT !== "true") {
      currentIds.forEach((id) => knownIds.add(id));
      await writeState({
        ...state,
        knownIds: [...knownIds].slice(-1500),
        initializedAt: startedAt,
        lastCheckedAt: startedAt,
        lastResult: "seeded_initial"
      });
      return json(200, { ok: true, result: "seeded_initial", totalItems: items.length });
    }

    const fresh = items.filter((item) =>
      !postedIds.has(item.id) &&
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
      return json(200, { ok: true, result: "no_new_items", totalItems: items.length });
    }

    await sendNotification(fresh.slice(0, MAX_NOTIFY_EMBEDS), { totalCount: fresh.length });

    fresh.forEach((entry) => notifiedIds.add(entry.id));
    await writeState({
      ...state,
      notifiedIds: [...notifiedIds].slice(-500),
      knownIds: mergeRecentIds(knownIds, currentIds),
      initializedAt: state.initializedAt || startedAt,
      lastCheckedAt: startedAt,
      lastNotifiedAt: startedAt,
      lastItem: fresh[0],
      lastResult: "notified"
    });

    return json(200, { ok: true, result: "notified", count: fresh.length, item: fresh[0].title });
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, error: error.message });
  }
};

// ---------------------------------------------------------------- 収集

async function collectLatest() {
  const [sec, wireNews, speedNews, officialNews, marketNews, quantumNews, competitorSec, competitorNews] = await Promise.all([
    safe(() => getSecFilings(), "sec"),
    safe(() => getWireNews(), "wire"),
    // 速報クエリ: when:1d は新着が上に来やすい
    safe(() => getGoogleNews("IonQ OR IONQ", "1d"), "speed"),
    safe(() => getGoogleNews("site:investors.ionq.com/news/news-details IonQ", "7d"), "official"),
    safe(() => getGoogleNews("IONQ OR $IONQ", "7d"), "market"),
    safe(() => getQuantumNews(), "quantum"),
    safe(() => getCompetitorSecFilings(), "csec"),
    safe(() => getGoogleNews("(Rigetti OR RGTI OR D-Wave OR QBTS OR \"Quantum Computing Inc\" OR QUBT OR Quantinuum OR \"IBM quantum\" OR \"Google quantum\" OR \"Microsoft quantum\" OR \"AWS Braket\" OR \"NVIDIA quantum\")", "7d"), "cnews")
  ]);

  return {
    sec: sec.value,
    wireNews: wireNews.value,
    speedNews: speedNews.value,
    officialNews: officialNews.value,
    marketNews: marketNews.value,
    quantumNews: quantumNews.value,
    competitorSec: competitorSec.value,
    competitorNews: competitorNews.value,
    stats: {
      sec: sourceStat(sec), wire: sourceStat(wireNews), speed: sourceStat(speedNews),
      official: sourceStat(officialNews), market: sourceStat(marketNews),
      quantum: sourceStat(quantumNews), csec: sourceStat(competitorSec), cnews: sourceStat(competitorNews)
    }
  };
}

async function safe(fn, label) {
  try {
    const value = await fn();
    return { value: value || [], error: null };
  } catch (error) {
    console.warn(`collect failed [${label}]: ${error.message}`);
    return { value: [], error: error.message };
  }
}

function sourceStat(result) {
  return { count: (result.value || []).length, error: result.error };
}

async function getWireNews() {
  const batches = await Promise.all(WIRE_FEEDS.map(async (feed) => {
    try {
      const response = await fetchWithTimeout(feed.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "Accept": "application/rss+xml,application/xml,text/xml,*/*"
        }
      });
      if (!response.ok) throw new Error(`wire_${response.status}`);
      const xml = await response.text();
      return parseItems(xml, feed.source).slice(0, 15).map((item) => ({
        ...item,
        ticker: feed.ticker,
        wireType: feed.type
      }));
    } catch (error) {
      console.warn(`Wire feed failed ${feed.source}: ${error.message}`);
      return [];
    }
  }));
  return dedupeItems(batches.flat());
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
  const response = await fetchWithTimeout("https://www.sec.gov/files/company_tickers.json", {
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
  const response = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${cik}.json`, {
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

async function getGoogleNews(query, window = "7d") {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}%20when%3A${window}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "IONQ Watchdesk contact@example.com",
      "Accept": "application/rss+xml,text/xml"
    }
  });
  if (!response.ok) throw new Error(`Google News request failed: ${response.status}`);
  const xml = await response.text();
  return parseItems(xml).slice(0, GOOGLE_NEWS_LIMIT);
}

async function getQuantumNews() {
  const googleQueries = [
    "\"quantum computing\" OR \"quantum computer\" OR \"quantum technology\" -IONQ -$IONQ",
    "\"quantum computing\" (startup OR funding OR partnership OR contract OR government OR defense)",
    "\"quantum computing stocks\" (analyst OR rating OR upgrade OR downgrade OR price target OR investor)",
    "\"quantum error correction\" OR \"logical qubit\" OR \"ion trap\" OR \"superconducting qubit\""
  ];

  const batches = await Promise.all([
    ...googleQueries.map((query) => safeGetGoogleNews(query)),
    ...QUANTUM_RSS_FEEDS.map((feed) => safeGetFeed(feed))
  ]);

  return dedupeItems(batches.flat())
    .filter(isQuantumRelevant)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 30);
}

async function safeGetGoogleNews(query) {
  try {
    return await getGoogleNews(query, "7d");
  } catch (error) {
    console.warn(`Google quantum query failed: ${error.message}`);
    return [];
  }
}

async function safeGetFeed(feed) {
  try {
    const response = await fetchWithTimeout(feed.url, {
      headers: {
        "User-Agent": "IONQ Watchdesk contact@example.com",
        "Accept": "application/rss+xml,application/atom+xml,text/xml"
      }
    });
    if (!response.ok) throw new Error(`feed_${response.status}`);
    const xml = await response.text();
    return parseItems(xml, feed.source).slice(0, 12);
  } catch (error) {
    console.warn(`Quantum feed failed ${feed.source}: ${error.message}`);
    return [];
  }
}

// ---------------------------------------------------------------- 正規化

function normalizeLatestItems(data) {
  const items = [];

  data.sec.filter(isImportantSec).forEach((item) => items.push(withId({
    type: "SEC",
    category: "sec",
    label: "重要SEC",
    title: `SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: "SEC EDGAR",
    kind: "SEC開示",
    form: item.form,
    ticker: item.ticker,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt
  })));

  (data.wireNews || []).forEach((item) => items.push(withId({
    type: item.wireType === "IR" ? "IR" : "CNEWS",
    category: item.wireType === "IR" ? "ir" : "competitor",
    label: item.wireType === "IR" ? "ワイヤー速報" : "競合速報",
    title: item.title,
    url: item.url,
    source: item.source,
    kind: item.wireType === "IR" ? "IR・提携" : "競合IR/SEC",
    ticker: item.ticker,
    publishedAt: item.publishedAt
  })));

  (data.speedNews || []).forEach((item) => items.push(withId({
    type: "NEWS",
    category: "news",
    label: "IONQ速報",
    title: item.title,
    url: item.url,
    source: item.source || "News",
    kind: "株価材料",
    publishedAt: item.publishedAt
  })));

  (data.officialNews || []).forEach((item) => items.push(withId({
    type: "IR",
    category: "ir",
    label: "最新IR",
    title: item.title,
    url: item.url,
    source: item.source || "IonQ IR",
    kind: "IR・提携",
    publishedAt: item.publishedAt
  })));

  (data.marketNews || []).forEach((item) => items.push(withId({
    type: "NEWS",
    category: "news",
    label: "IONQ NEWS",
    title: item.title,
    url: item.url,
    source: item.source || "News",
    kind: "株価材料",
    publishedAt: item.publishedAt
  })));

  (data.quantumNews || []).forEach((item) => items.push(withId({
    type: "QNEWS",
    category: "quantum",
    label: "量子業界",
    title: item.title,
    url: item.url,
    source: item.source || "Quantum News",
    kind: "量子業界",
    publishedAt: item.publishedAt
  })));

  (data.competitorSec || []).forEach((item) => items.push(withId({
    type: "CSEC",
    category: "competitor",
    label: "競合SEC",
    title: `${item.ticker || "競合"} SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: `${item.ticker || "競合"} SEC`,
    kind: "競合IR/SEC",
    form: item.form,
    ticker: item.ticker,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt
  })));

  (data.competitorNews || []).forEach((item) => items.push(withId({
    type: "CNEWS",
    category: "competitor",
    label: "競合NEWS",
    title: item.title,
    url: item.url,
    source: item.source || "Competitor News",
    kind: "競合IR/SEC",
    publishedAt: item.publishedAt
  })));

  // 統一IDでの重複排除。同じ記事が速報クエリと通常クエリの両方に出ても1件になる。
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

// ============================================================
// 統一ID: フロント(index.html)のstableIdと完全に同じロジック。
// 片方を変えるときは必ず両方変えること。
// SEC等の提出書類はURL(accession込み)が安定しているのでURLを使い、
// ニュースはURLがトラッキングで揺れるため正規化タイトルを使う。
// ============================================================
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

function dedupeItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeSignature(item.title) || normalizeKey(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/$/, "")
    .trim();
}

function isQuantumRelevant(item) {
  const text = `${item.title || ""} ${item.source || ""}`.toLowerCase();
  return /quantum|qubit|qubits|ion trap|trapped ion|superconducting|photonic|annealing|qpu|qiskit|braket|cuda-q|quantinuum|rigetti|d-wave|pasqal|quera|atom computing|alice & bob|xanadu|institutional investor|hedge fund|asset manager|etf|holdings|stake|portfolio|analyst|price target|upgrade|downgrade|rating/.test(text);
}

// ---------------------------------------------------------------- 翻訳(Blobキャッシュ付き)

async function applyTranslations(items) {
  let cache = {};
  try {
    const store = await openStore();
    const raw = await store.get(TRANSLATE_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn("translate cache read failed:", error.message);
  }

  const targets = items.filter((item) => !item.form && shouldTranslateTitle(item.title));
  const pending = [];
  const seen = new Set();

  for (const item of targets) {
    const key = normalizeSignature(item.title);
    if (cache[key]) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({ key, title: item.title });
    if (pending.length >= MAX_TRANSLATE_PER_RUN) break;
  }

  if (pending.length) {
    await runLimited(pending, 4, async (entry) => {
      const ja = await translateToJapanese(entry.title);
      if (ja && ja !== entry.title) cache[entry.key] = ja;
    });
    try {
      const store = await openStore();
      const keys = Object.keys(cache);
      if (keys.length > 800) {
        const trimmed = {};
        keys.slice(-600).forEach((k) => { trimmed[k] = cache[k]; });
        cache = trimmed;
      }
      await store.set(TRANSLATE_KEY, JSON.stringify(cache));
    } catch (error) {
      console.warn("translate cache write failed:", error.message);
    }
  }

  return items.map((item) => {
    const ja = cache[normalizeSignature(item.title)];
    return ja ? { ...item, titleJa: ja } : item;
  });
}

function shouldTranslateTitle(title) {
  const text = String(title || "").trim();
  if (!text) return false;
  if (/[ぁ-んァ-ヶ一-龠]/.test(text)) return false;
  return true;
}

async function translateToJapanese(text) {
  try {
    const endpoint = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=" + encodeURIComponent(text);
    const response = await fetchWithTimeout(endpoint, {}, 4000);
    if (!response.ok) return "";
    const data = await response.json();
    return (data && data[0] ? data[0].map((row) => row && row[0] ? row[0] : "").join("") : "").trim();
  } catch (error) {
    return "";
  }
}

async function runLimited(list, limit, worker) {
  const queue = [...list];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) return;
      await worker(entry);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------- フィルタ・判定

function isLowSignalSec(item) {
  if (item.kind !== "SEC開示" && item.kind !== "競合IR/SEC") return false;
  const form = String(item.form || "").toUpperCase();
  if (!form) return false;
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
  if (postedIds.has(item.id)) return "posted";
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
  const oldestAllowed = now - effectiveLookbackMinutes() * 60 * 1000;
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
  return [...merged].slice(-1500);
}

function parseItemTime(item) {
  const value = item.acceptedAt || item.publishedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------- 通知

async function sendNotification(items, options = {}) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  const total = options.totalCount || list.length;
  const title = total > 1 ? `IONQ新着 ${total}件` : "IONQ新着";

  if (getDiscordWebhookUrl()) {
    await sendDiscord(list, title, total);
    return;
  }

  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    const first = list[0];
    const message = `${title}\n${first.title}\n${first.source || ""} ${first.publishedAt || ""}\n${first.url}`;
    await sendPushover(title, message, first.url);
    return;
  }

  if (options.requireTarget) {
    throw new Error("Notification target is not configured. Set DISCORD_WEBHOOK_URL in Netlify environment variables.");
  }
  console.log("No notification target configured.");
}

async function sendDiscord(items, title, total) {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is empty.");

  const embeds = items.slice(0, MAX_NOTIFY_EMBEDS).map((item) => {
    const jst = formatJst(item.acceptedAt || item.publishedAt);
    const hasUrl = /^https?:\/\//i.test(String(item.url || ""));
    const descriptionLines = [
      item.titleJa ? truncate(item.titleJa, 200) : null,
      item.source ? `**${item.source}**` : null,
      jst ? `🕒 ${jst}` : null
    ].filter(Boolean);
    return {
      title: truncate(item.title, 240),
      url: hasUrl ? item.url : undefined,
      description: descriptionLines.join("\n"),
      color: 0x2458c6
    };
  });

  const contentLines = [`**${title}**`];
  if (total > items.length) contentLines.push(`他 ${total - items.length} 件は [Watchdesk](${SITE_URL}) で確認`);
  else contentLines.push(`🔗 [Watchdeskを開く](${SITE_URL})`);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: contentLines.join("\n"), embeds })
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
  return value.trim().replace(/^['"]|['"]$/g, "").trim();
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

// ---------------------------------------------------------------- Blobs

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
  const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    opts.siteID = siteID;
    opts.token = token;
  }
  return getStore(opts);
}

async function writeCache(payload) {
  try {
    const store = await openStore();
    await store.set(CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not write latest cache:", error.message);
  }
}

async function readState() {
  try {
    const store = await openStore();
    const value = await store.get(STATE_KEY);
    return value ? JSON.parse(value) : {};
  } catch (error) {
    console.warn("Could not read state. Continuing without persistent dedupe.", error.message);
    return { notifiedIds: [], postedIds: [], storageUnavailable: true };
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
    console.warn("Could not read posted state.", error.message);
    return [];
  }
}

async function writeState(state) {
  try {
    if (state.storageUnavailable) return;
    const store = await openStore();
    await store.set(STATE_KEY, JSON.stringify(state, null, 2));
  } catch (error) {
    console.warn("Could not write state.", error.message);
  }
}

// ---------------------------------------------------------------- HTTP/XML

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

  const entryMatches = xml.match(/<entry[\s\S]*?<\/entry>/g) || [];
  for (const entryXml of entryMatches) {
    const href = (entryXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i) || [])[1] || "";
    items.push({
      title: cleanXml(readTag(entryXml, "title")),
      url: cleanXml(href || readTag(entryXml, "link")),
      publishedAt: cleanXml(readTag(entryXml, "updated") || readTag(entryXml, "published")),
      source: fallbackSource
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
