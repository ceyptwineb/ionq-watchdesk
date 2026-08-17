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
const COMPETITOR_TICKERS = ["QNT", "RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "MSFT", "AMZN", "HON", "NVDA"];

// IonQが買収・支配株取得した企業と、買収手続き中の企業。
// 各社の記事はIonQ/quantumを含まないことが多いため、通常の量子検索とは別に追跡する。
const IONQ_PORTFOLIO_COMPANIES = [
  { name: "Qubitekk", pattern: /\bqubitekk\b/i },
  { name: "ID Quantique", pattern: /\bid quantique\b|\bidq\b/i },
  { name: "Lightsynq", pattern: /\blightsynq\b|\blightsync technologies\b/i },
  { name: "Capella Space", pattern: /\bcapella space\b/i },
  { name: "Oxford Ionics", pattern: /\boxford ionics\b/i },
  { name: "Vector Atomic", pattern: /\bvector atomic\b/i },
  { name: "Skyloom", pattern: /\bskyloom(?: global)?\b/i },
  { name: "Seed Innovations", pattern: /\bseed innovations\b/i },
  { name: "SkyWater Technology", pattern: /\bskywater(?: technology)?\b|\bskyt\b/i }
];

const IONQ_PORTFOLIO_QUERIES = [
  '"Qubitekk" OR "ID Quantique" OR "Lightsynq" OR "Oxford Ionics"',
  '"Capella Space" OR "Vector Atomic" OR "Skyloom Global" OR "Seed Innovations"',
  '"SkyWater Technology" OR SKYT'
];

// ワイヤー配信をほぼリアルタイムで中継する銘柄別フィード。
// SKYTは買収クローズまで実質IonQ関連の一次情報源。
const WIRE_FEEDS = [
  { source: "Nasdaq/IONQ", ticker: "IONQ", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=IONQ", type: "IR" },
  { source: "Nasdaq/SKYT", ticker: "SKYT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=SKYT", type: "IR" },
  { source: "Nasdaq/RGTI", ticker: "RGTI", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=RGTI", type: "CNEWS" },
  { source: "Nasdaq/QBTS", ticker: "QBTS", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=QBTS", type: "CNEWS" },
  { source: "Nasdaq/QUBT", ticker: "QUBT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=QUBT", type: "CNEWS" },
  { source: "Nasdaq/QNT", ticker: "QNT", url: "https://www.nasdaq.com/feed/rssoutbound?symbol=QNT", type: "CNEWS" }
];

const QUANTUM_RSS_FEEDS = [
  { source: "The Quantum Insider", url: "https://thequantuminsider.com/feed/" },
  { source: "Quantum Computing Report", url: "https://quantumcomputingreport.com/feed/" },
  { source: "Inside Quantum Technology", url: "https://www.insidequantumtechnology.com/feed/" },
  { source: "Quantum Zeitgeist", url: "https://quantumzeitgeist.com/feed/" },
  { source: "HPCwire", url: "https://www.hpcwire.com/feed/" }
];

// Google Newsより先に確認する米国政府の一次情報。
const OFFICIAL_MACRO_FEEDS = [
  { source: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_monetary.xml" },
  { source: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss" },
  { source: "BLS CPI", url: "https://www.bls.gov/feed/cpi.rss" },
  { source: "BEA", url: "https://apps.bea.gov/rss/rss.xml" }
];

const STORE_NAME = "ionq-watchdesk";
const STATE_KEY = "watch-state";
const POSTED_KEY = "posted-state";
const CACHE_KEY = "latest-cache";
const TRANSLATE_KEY = "translate-cache";
const AI_PRIORITY_KEY = "priority-ai-cache-v2";
const GOOGLE_NEWS_LIMIT = 25;
const MAX_TRANSLATE_PER_RUN = 30;
const TRANSLATE_CONCURRENCY = 6;
const MAX_NOTIFY_EMBEDS = 5;
// 1時間Cronの遅延や一時的な取得失敗には余裕を持たせつつ、
// 前日以前の記事を新着通知しない。
const DEFAULT_LOOKBACK_MINUTES = 360;
const MAX_COLLECTION_AGE_HOURS = 24 * 8;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const WATCHDESK_FALLBACK_URL = "https://ionqnews.netlify.app/";
const SITE_URL = (process.env.WATCHDESK_URL || WATCHDESK_FALLBACK_URL).trim() || WATCHDESK_FALLBACK_URL;

exports.handler = async (event = {}, context = {}) => {
  const startedAt = new Date().toISOString();
  // 関数タイムアウト(10秒)の3秒前をAI・翻訳の締切にする。
  // 残り時間はキャッシュ保存と複数便のDiscord通知へ確保する。
  const deadlineAt = typeof context.getRemainingTimeInMillis === "function"
    ? Date.now() + context.getRemainingTimeInMillis() - 3000
    : Date.now() + 6500;

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

    // 上書き前に前回キャッシュを確保(類似記事の再通知抑制に使う)
    const previousItems = await readCacheItems();

    // キーワードだけでは判断しにくい記事を、API設定時のみ1バッチで意味判定する。
    // 1.6秒で打ち切り、失敗時は従来スコアへそのままフォールバックする。
    items = await applyAiPriority(items, Math.min(deadlineAt, Date.now() + 1600));

    // 翻訳前に一度キャッシュを書く(翻訳中にタイムアウトしても表示は生きる)
    await writeCache({ updatedAt: startedAt, cachedAt: startedAt, items, sourceStats: collected.stats });

    items = await applyTranslations(items, deadlineAt);

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
          priorityScore: newsPriorityScore(item, startedAt),
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
      !idInSet(item, postedIds) &&
      !idInSet(item, notifiedIds) &&
      !idInSet(item, knownIds) &&
      !isLowSignalSec(item) &&
      shouldNotifyByTime(item, startedAt) &&
      isNotificationWorthy(item, startedAt)
    );

    // 転載・言い換え記事の通知抑制:
    // 1. 既知(通知済み/投稿済み/既出)の記事とタイトルが類似する新着は通知しない
    // 2. 同一バッチ内の類似記事は1件に代表させる
    buildSimilarityIndex(items.concat(previousItems));
    const seenItems = previousItems.filter((p) => !p.form &&
      (idInSet(p, knownIds) || idInSet(p, notifiedIds) || idInSet(p, postedIds)));
    const immediateFresh = fresh.filter((item) => isImmediateNews(item, startedAt));
    const digestFresh = fresh.filter((item) =>
      !isImmediateNews(item, startedAt) &&
      (item.form || !seenItems.some((seen) => isSimilarNews(item, seen)))
    );
    const notifyList = [];
    immediateFresh.forEach((item) => {
      if (item.form ? false : seenItems.some((p) => isSimilarNews(item, p))) return;
      const similarIndex = notifyList.findIndex((n) => isSimilarNews(n, item));
      if (similarIndex >= 0) {
        if (compareNewsPriority(item, notifyList[similarIndex], startedAt) < 0) {
          notifyList[similarIndex] = item;
        }
        return;
      }
      notifyList.push(item);
    });

    // 最大5件に絞る前に「IonQ直結・材料性・一次情報」を優先する。
    notifyList.sort((a, b) => compareNewsPriority(a, b, startedAt));
    let digestQueue = mergeDigestQueue(state.digestItems || [], digestFresh, startedAt, postedIds);
    let immediateSent = false;
    let digestSent = false;
    let lastDigestSlot = state.lastDigestSlot || "";

    if (notifyList.length) {
      await sendNotificationBatches(notifyList, { title: "IONQ速報" });
      immediateSent = true;
      // 抑制した類似分も通知済み扱いにして、以後の再浮上を防ぐ。
      immediateFresh.forEach((entry) => notifiedIds.add(entry.id));
    }

    const digestSlot = currentDigestSlot(startedAt);
    if (digestSlot && digestSlot !== lastDigestSlot && digestQueue.length) {
      const digestList = digestQueue.slice().sort((a, b) => compareNewsPriority(a, b, startedAt));
      await sendNotificationBatches(digestList, {
        title: digestSlot.endsWith("-08") ? "IONQ注目ニュース 朝まとめ" : "IONQ注目ニュース 夜まとめ"
      });
      digestList.forEach((entry) => notifiedIds.add(entry.id));
      digestQueue = [];
      lastDigestSlot = digestSlot;
      digestSent = true;
    }

    const result = immediateSent && digestSent ? "notified_and_digest" :
      immediateSent ? "notified" : digestSent ? "digest_notified" :
        digestQueue.length ? "queued_digest" : fresh.length ? "suppressed_similar" : "no_new_items";
    await writeState({
      ...state,
      notifiedIds: [...notifiedIds].slice(-500),
      knownIds: mergeRecentIds(knownIds, currentIds),
      digestItems: digestQueue.slice(-100),
      lastDigestSlot,
      initializedAt: state.initializedAt || startedAt,
      lastCheckedAt: startedAt,
      lastNotifiedAt: immediateSent || digestSent ? startedAt : state.lastNotifiedAt,
      lastItem: notifyList[0] || state.lastItem,
      lastResult: result
    });

    return json(200, {
      ok: true,
      result,
      immediateCount: notifyList.length,
      digestQueued: digestQueue.length,
      totalItems: items.length
    });
  } catch (error) {
    console.error(error);
    return json(500, { ok: false, error: error.message });
  }
};

// ---------------------------------------------------------------- 収集

async function collectLatest() {
  const [sec, wireNews, speedNews, officialNews, marketNews, portfolioNews, macroNews, quantumNews, competitorSec, competitorNews] = await Promise.all([
    safe(() => getSecFilings(), "sec"),
    safe(() => getWireNews(), "wire"),
    // 速報クエリ: when:1d は新着が上に来やすい
    safe(() => getGoogleNews("IonQ OR IONQ", "1d"), "speed"),
    safe(() => getOfficialIonqNews(), "official"),
    safe(() => getGoogleNews("IONQ OR $IONQ", "7d"), "market"),
    safe(() => getIonqPortfolioNews(), "portfolio"),
    safe(() => getMacroNews(), "macro"),
    safe(() => getQuantumNews(), "quantum"),
    safe(() => getCompetitorSecFilings(), "csec"),
    safe(() => getGoogleNews("(Rigetti OR RGTI OR D-Wave OR QBTS OR \"Quantum Computing Inc\" OR QUBT OR Quantinuum OR (QNT \"quantum computing\") OR \"IBM quantum\" OR \"Google quantum\" OR \"Microsoft quantum\" OR \"AWS Braket\" OR \"NVIDIA quantum\")", "7d"), "cnews")
  ]);

  return {
    sec: sec.value,
    wireNews: wireNews.value,
    speedNews: speedNews.value,
    officialNews: officialNews.value,
    marketNews: marketNews.value,
    portfolioNews: portfolioNews.value,
    macroNews: macroNews.value,
    quantumNews: quantumNews.value,
    competitorSec: competitorSec.value,
    competitorNews: competitorNews.value,
    stats: {
      sec: sourceStat(sec), wire: sourceStat(wireNews), speed: sourceStat(speedNews),
      official: sourceStat(officialNews), market: sourceStat(marketNews), portfolio: sourceStat(portfolioNews), macro: sourceStat(macroNews),
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

// IonQ公式ページを直接確認し、取得できない項目だけGoogle Newsで補完する。
async function getOfficialIonqNews() {
  const [direct, indexed] = await Promise.all([
    getIonqNewsPage().catch((error) => {
      console.warn(`IonQ direct news failed: ${error.message}`);
      return [];
    }),
    safeGetGoogleNews("site:investors.ionq.com/news/news-details IonQ", "7d")
  ]);
  return dedupeItems([...direct, ...indexed])
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 25);
}

async function getIonqNewsPage() {
  const response = await fetchWithTimeout("https://www.ionq.com/news", {
    headers: {
      "User-Agent": "Mozilla/5.0 IONQ-Watchdesk/1.0",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`official_${response.status}`);
  return parseIonqOfficialHtml(await response.text());
}

async function getIonqPortfolioNews() {
  const batches = await Promise.all(
    IONQ_PORTFOLIO_QUERIES.map((query) => safeGetGoogleNews(query, "7d"))
  );
  return dedupeItems(batches.flat())
    .map((item) => {
      const companyName = matchIonqPortfolioCompany(item);
      return companyName ? { ...item, companyName, ionqPortfolio: true } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 30);
}

function matchIonqPortfolioCompany(item) {
  const text = `${item && item.title || ""} ${item && item.source || ""}`;
  const company = IONQ_PORTFOLIO_COMPANIES.find((entry) => entry.pattern.test(text));
  return company ? company.name : "";
}

function parseIonqOfficialHtml(html) {
  const sourceHtml = String(html || "");
  const output = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(sourceHtml))) {
    const href = cleanXml(match[1]);
    const context = sourceHtml.slice(Math.max(0, match.index - 260), anchorRe.lastIndex + 260);
    const officialHref = /investors\.ionq\.com\/news\/news-details|^\/news\/[^?#]+|^https?:\/\/(?:www\.)?ionq\.com\/news\/[^?#]+/i.test(href);
    const labeledPressRelease = /ionq press release/i.test(match[2]);
    if (!officialHref && !labeledPressRelease) continue;
    const title = stripHtml(match[2])
      .replace(/\bIonQ Press Release\b/gi, "")
      .replace(/\bRead More\b/gi, "")
      .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (title.length < 18 || !href || href === "#") continue;
    const dateText = (context.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i) || [])[0] || "";
    const publishedAt = dateText ? new Date(`${dateText} 12:00:00 UTC`).toISOString() : "";
    if (!publishedAt) continue;
    let url;
    try {
      url = new URL(href, "https://www.ionq.com/news").toString();
    } catch (error) {
      continue;
    }
    output.push({ title, url, publishedAt, source: "IonQ公式" });
  }
  return dedupeItems(output);
}

function stripHtml(value) {
  return cleanXml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// 株アカウントとして押さえたい金融材料。ただし一般金融ニュースを無制限に
// 混ぜず、米株全体を動かすマクロ指標か量子株の資本市場材料に限定する。
async function getMacroNews() {
  const queries = [
    '("Federal Reserve" OR FOMC OR Powell OR inflation OR CPI OR PCE OR GDP OR payrolls OR "jobless claims" OR "retail sales" OR ISM OR PMI) (stocks OR Nasdaq OR "Wall Street")',
    '("Treasury yields" OR "Treasury auction" OR "debt ceiling" OR "government shutdown" OR recession OR tariffs OR sanctions OR "oil prices" OR VIX OR "credit spreads" OR "bank crisis") (stocks OR Nasdaq OR "Wall Street" OR markets)',
    '(IONQ OR "quantum stocks") (offering OR dilution OR "short seller" OR ETF OR institutional OR analyst)'
  ];
  const [newsBatches, officialBatches] = await Promise.all([
    Promise.all(queries.map((query) => safeGetGoogleNews(query, "1d"))),
    Promise.all(OFFICIAL_MACRO_FEEDS.map((feed) => safeGetFeed(feed)))
  ]);
  return dedupeItems([...officialBatches.flat(), ...newsBatches.flat()])
    .filter(isImportantMacroNews)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 15);
}

const MACRO_NEWS_RE = /federal reserve|\bfed\b|\bfomc\b|\bpowell\b|interest rates?|rate cut|rate hike|quantitative easing|quantitative tightening|balance sheet|inflation|\bcpi\b|\bpce\b|\bgdp\b|payrolls?|jobs report|jobless claims|unemployment|retail sales|\bism\b|\bpmi\b|consumer confidence|treasury yields?|treasury auction|debt ceiling|government shutdown|recession|tariffs?|sanctions?|oil prices?|crude oil|\bvix\b|volatility index|credit spreads?|bank (?:crisis|failure)|liquidity crisis|market selloff|stock offering|dilution|short seller|institutional investor|analyst|upgrade|downgrade|price target|\betf\b/i;
const MARKET_CONTEXT_RE = /stocks?|nasdaq|s&p|wall street|market|ionq|quantum|growth|technology|tech/i;
const OFFICIAL_MACRO_SOURCE_RE = /federal reserve|\bbls\b|bureau of labor statistics|\bbea\b|bureau of economic analysis/i;
const OFFICIAL_MACRO_RELEASE_RE = /monetary policy|fomc|consumer price index|producer price index|employment situation|job openings|employment cost|gross domestic product|personal income and outlays|\bcpi\b|\bpce\b|\bgdp\b/i;

function isImportantMacroNews(item) {
  const text = `${item.title || ""} ${item.source || ""}`;
  if (OFFICIAL_MACRO_SOURCE_RE.test(item.source || "")) {
    return OFFICIAL_MACRO_RELEASE_RE.test(text) || MACRO_NEWS_RE.test(text);
  }
  return MACRO_NEWS_RE.test(text) && MARKET_CONTEXT_RE.test(text);
}

async function getQuantumNews() {
  const googleQueries = [
    "\"quantum computing\" OR \"quantum computer\" OR \"quantum technology\" -IONQ -$IONQ",
    "\"quantum computing\" (startup OR funding OR partnership OR contract OR government OR defense)",
    "\"quantum computing stocks\" (analyst OR rating OR upgrade OR downgrade OR price target OR investor)",
    "\"quantum error correction\" OR \"logical qubit\" OR \"ion trap\" OR \"superconducting qubit\"",
    "\"quantum fidelity\" OR \"two-qubit gate\" OR \"below threshold\" OR \"magic state\" OR \"quantum interconnect\"",
    "Quantinuum OR (QNT \"quantum computing\")"
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

async function safeGetGoogleNews(query, window = "7d") {
  try {
    return await getGoogleNews(query, window);
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

  (data.portfolioNews || []).forEach((item) => items.push(withId({
    type: "PNEWS",
    category: "portfolio",
    label: "IonQグループ",
    title: item.title,
    url: item.url,
    source: item.source || item.companyName || "IonQ Group News",
    kind: "買収企業",
    companyName: item.companyName || matchIonqPortfolioCompany(item),
    ionqPortfolio: true,
    parentTicker: "IONQ",
    publishedAt: item.publishedAt
  })));

  (data.macroNews || []).forEach((item) => items.push(withId({
    type: "MNEWS",
    category: "macro",
    label: "金融・マクロ",
    title: item.title,
    url: item.url,
    source: item.source || "Financial News",
    kind: "株価環境",
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
    .filter((item) => !isExcludedSource(item))
    .filter((item) => !isIrrelevantWire(item))
    // 日時不明・未来日・8日超の記事はキャッシュへ入れない。
    // 7日表示には1日分の取得遅延余裕を残す。
    .filter((item) => isCollectableItemTime(item))
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt || b.acceptedAt || 0) - Date.parse(a.publishedAt || a.acceptedAt || 0));
}

// ============================================================
// 統一ID: フロント(index.html) / latest-ionq.js のstableIdと完全に同じロジック。
// 片方を変えるときは必ず3ファイル同時に変えること。
// SEC等の提出書類はURL(accession込み)が安定しているのでURLを使い、
// ニュースはURLがトラッキングで揺れるため正規化タイトルを使う。
// typeはIDに含めない: 同じ記事が別カテゴリ(NEWS/QNEWS/IR/CNEWS)で
// 取れても同一IDになり、重複表示・再通知・チェック復活を防ぐ。
// legacyId(旧type込みID)は過去の投稿済み/通知済み状態の引き継ぎ用。
// ============================================================
function withId(item) {
  return { ...item, id: stableId(item), legacyId: legacyStableId(item) };
}

function stableId(item) {
  const basis = item.form
    ? `F|${item.url || item.title || ""}`
    : `N|${normalizeSignatureV2(item.title)}`;
  return "u" + fnvHash(basis);
}

// 新IDの基礎になる正規化(V2)。"IonQ (IONQ) Launches..." のような
// ティッカー括弧だけの差を吸収して同一記事を同一IDにする。
// legacyStableIdは旧normalizeSignatureのまま(過去チェック引き継ぎ用)。
function normalizeSignatureV2(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+-\s+[^-|]+$/g, "")
    .replace(/\((?:nyse|nasdaq|otcmkts|otc|asx)?[:\s]*[a-z]{1,6}\)/g, " ")
    .replace(/[\s　]+/g, " ")
    .trim();
}

function legacyStableId(item) {
  const basis = item.form
    ? `${item.type}|${item.url || item.title || ""}`
    : `${item.type}|${normalizeSignature(item.title)}`;
  return "n" + fnvHash(basis);
}

function fnvHash(basis) {
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function idInSet(item, set) {
  return set.has(item.id) || (item.legacyId && set.has(item.legacyId));
}

// ============================================================
// 収集品質フィルタ(2026-07-03に実データ170件で棚卸しして設計)。
// index.htmlにも同じ除外ロジックあり(変更時は両方)。
// ============================================================
// 完全除外するスパム/低品質媒体:
// - Mshale: IONQと無関係な動画スパムの巣
// - AD HOC NEWS / Pluang: 海外アグリゲータの転載(実質重複)
// - Stock Traders Daily: ワラント取引の定型スパム
// - ChartMill: 記事ではなく株価クオートページ
// - MarketBeat: 「◯◯社が$3M保有」型の自動生成記事が大量
const EXCLUDED_SOURCE_PATTERNS = [
  /\bmshale\b/i,
  /\bad hoc news\b/i,
  /\bpluang\b/i,
  /stock traders daily/i,
  /chartmill/i,
  /marketbeat/i
];

// タイトル自体がジャンクのパターン:
// - (hcISYvRmwV) 型の動画IDコード(スパム転載の署名)
// - フォーラム/クオートページ
// - 海外預託証券のテクニカルページ
const JUNK_TITLE_PATTERNS = [
  /\([A-Za-z0-9]{8,12}\)\s*(-|$)/,
  /stock forum and discussion/i,
  /stock quote price|price and forecast\b/i,
  /depositary receipts/i
];

function isExcludedSource(item) {
  const text = `${item.source || ""} ${item.title || ""}`;
  if (EXCLUDED_SOURCE_PATTERNS.some((re) => re.test(text))) return true;
  if (JUNK_TITLE_PATTERNS.some((re) => re.test(item.title || ""))) return true;
  // 「John Martinis」だけのような文脈のないタイトル(RSSの人物アーカイブ等)
  if (!item.form && String(item.title || "").trim().split(/\s+/).length <= 2) return true;
  return false;
}

// Nasdaq銘柄別RSSは対象銘柄と無関係な記事(WDAY/AGYS/AMAT等)も流してくるため、
// 追跡銘柄名か量子ワードをタイトルに含まないワイヤー記事は捨てる。
const TRACKED_COMPANY_RE = /quantum|qubit|qpu|ionq|rigetti|d-wave|dwave|quantinuum|\bqnt\b|\bqubt\b|skywater|\bskyt\b|qubitekk|id quantique|lightsynq|capella space|oxford ionics|vector atomic|skyloom|seed innovations/i;

function isIrrelevantWire(item) {
  if (item.label !== "ワイヤー速報" && item.label !== "競合速報") return false;
  return !TRACKED_COMPANY_RE.test(item.title || "");
}

// 量子業界(QNEWS)は研究・学術ニュースも投資判断の文脈になるため残す。
// 以前は市場ワードで絞っていたが、技術動向も追いたいとの方針で撤廃(2026-07-03)。
// スパム/ジャンク/文脈なし短タイトルは isExcludedSource 側で引き続き除去する。

// ============================================================
// 類似記事の同一視: index.html と同じロジック。変更時は両方同時に。
// 「銘柄構成が同一 + アンカー(全大文字固有名詞/数値)が1つ以上共通 +
//  重み付きタイトル類似度 >= 0.22 (または素の語彙一致率 >= 0.5)」
// で同じニュースの言い換え転載とみなし、Discord再通知を抑制する。
// ============================================================
const TITLE_STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "as", "at", "its", "with", "by", "from"]);
const TICKER_PATTERNS = [
  ["ionq", /\bionq\b/],
  ["qnt", /\bquantinuum\b|(?=.*\bqnt\b)(?=.*\b(?:quantum|qubit|qpu)\b)/],
  ["rgti", /\brigetti\b|\brgti\b/],
  ["qbts", /\bd-wave\b|\bdwave\b|\bqbts\b/],
  ["qubt", /\bqubt\b|\bquantum computing inc\b/],
  ["skyt", /\bskywater\b|\bskyt\b/],
  ["qubitekk", /\bqubitekk\b/],
  ["idq", /\bid quantique\b|\bidq\b/],
  ["lightsynq", /\blightsynq\b|\blightsync technologies\b/],
  ["capella", /\bcapella space\b/],
  ["oxford-ionics", /\boxford ionics\b/],
  ["vector-atomic", /\bvector atomic\b/],
  ["skyloom", /\bskyloom(?: global)?\b/],
  ["seed-innovations", /\bseed innovations\b/],
  ["ibm", /\bibm\b/],
  ["googl", /\bgoogle\b|\balphabet\b/],
  ["msft", /\bmicrosoft\b/],
  ["amzn", /\bamazon\b|\baws\b/],
  ["nvda", /\bnvidia\b|\bnvda\b/],
  ["hon", /\bhoneywell\b/],
  ["archer", /\barcher\b/]
];

function tickerKey(title) {
  const text = normalizeSignatureV2(title);
  return TICKER_PATTERNS.filter((p) => p[1].test(text)).map((p) => p[0]).join(",");
}

function titleTokens(title) {
  const text = normalizeSignatureV2(title)
    .replace(/\$\s*(\d[\d,.]*)\s*(million|billion|m\b|b\b)?/g, (s, n, u) => " " + n.replace(/,/g, "") + (u ? u[0] : "") + " ")
    .replace(/(\d[\d,.]*)\s*(million|billion)/g, (s, n, u) => " " + n.replace(/,/g, "") + u[0] + " ")
    .replace(/[^a-z0-9\s%.]/g, " ");
  const set = new Set();
  text.split(/\s+/).forEach((word) => {
    if (word && word.length > 1 && !TITLE_STOPWORDS.has(word)) set.add(word);
  });
  return set;
}

function anchorTokens(title, tokens) {
  const set = new Set();
  String(title || "").replace(/\s+-\s+[^-|]+$/, "").split(/[^A-Za-z0-9$%.,-]+/).forEach((word) => {
    const w = word.replace(/[.,]+$/, "");
    if (/[A-Z]{2}/.test(w) && /^[A-Z0-9$%.-]+$/.test(w) && w.length > 1) set.add(w.toLowerCase());
  });
  tokens.forEach((word) => { if (/\d/.test(word)) set.add(word); });
  return set;
}

const simIndex = { df: new Map(), toks: new Map(), anchors: new Map() };

function buildSimilarityIndex(list) {
  simIndex.df = new Map();
  simIndex.toks = new Map();
  simIndex.anchors = new Map();
  list.forEach((item) => {
    if (item.form) return;
    const T = titleTokens(item.title);
    simIndex.toks.set(item, T);
    simIndex.anchors.set(item, anchorTokens(item.title, T));
    T.forEach((word) => simIndex.df.set(word, (simIndex.df.get(word) || 0) + 1));
  });
}

function tokenWeight(word) {
  return 1 / Math.max(1, simIndex.df.get(word) || 1);
}

function itemTokens(item) {
  let T = simIndex.toks.get(item);
  if (!T) { T = titleTokens(item.title); simIndex.toks.set(item, T); }
  return T;
}

function itemAnchors(item) {
  let A = simIndex.anchors.get(item);
  if (!A) { A = anchorTokens(item.title, itemTokens(item)); simIndex.anchors.set(item, A); }
  return A;
}

function isSimilarNews(a, b) {
  if (a.form || b.form) return false;
  if (tickerKey(a.title) !== tickerKey(b.title)) return false;
  const anchorsA = itemAnchors(a);
  const anchorsB = itemAnchors(b);
  if (anchorsA.size && anchorsB.size) {
    let shared = false;
    anchorsA.forEach((word) => { if (anchorsB.has(word)) shared = true; });
    if (!shared) return false;
  }
  const A = itemTokens(a);
  const B = itemTokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0;
  let wInter = 0;
  let wUnion = 0;
  A.forEach((word) => {
    const g = tokenWeight(word);
    wUnion += g;
    if (B.has(word)) { inter += 1; wInter += g; }
  });
  B.forEach((word) => { if (!A.has(word)) wUnion += tokenWeight(word); });
  const jac = inter / (A.size + B.size - inter);
  const wjac = wUnion ? wInter / wUnion : 0;
  return wjac >= 0.22 || jac >= 0.5;
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

const TECHNICAL_SCOPE_RE = /quantum|qubit|qpu|ion trap|trapped ion|superconducting|photonic|neutral atom|annealing|quantinuum|rigetti|d-wave|pasqal|quera|xanadu/i;
const TECHNICAL_MILESTONE_RE = /breakthrough|milestone|first-ever|record|demonstrat(?:e|es|ed|ion)|achiev(?:e|es|ed)|quantum advantage|quantum supremacy|fault[ -]tolerant|logical qubit|below threshold/i;
const TECHNICAL_SCALING_RE = /error correction|qec|logical qubit|code distance|magic state|fidelity|two[ -]qubit gate|gate error|scal(?:e|es|ed|ing|able)|modular|interconnect|distributed quantum|quantum network|photonic link|cryogenic control|all-to-all connectivity/i;
const TECHNICAL_EVIDENCE_RE = /experiment|experimental|peer[ -]review|published|paper|preprint|arxiv|nature|science|university|researchers?|benchmark|measured|fidelity|error rate|\d+(?:\.\d+)?%/i;
const TECHNICAL_BREADTH_RE = /hardware|architecture|processor|system|platform|compiler|algorithm|network|sensing|cryptography|materials?|drug discovery|industrial/i;
const TECHNICAL_HYPE_RE = /could|might|may |potential(?:ly)?|opinion|prediction|roadmap|plans? to|aims? to|expects? to/i;

function technicalImportanceScore(item) {
  const text = `${item && item.title || ""} ${item && item.source || ""} ${item && item.description || ""}`.toLowerCase();
  const category = String(item && item.category || "").toLowerCase();
  if ((category !== "quantum" && category !== "competitor") || !TECHNICAL_SCOPE_RE.test(text)) return 0;
  let score = 0;
  if (TECHNICAL_MILESTONE_RE.test(text)) score += 30;
  if (TECHNICAL_SCALING_RE.test(text)) score += 25;
  if (TECHNICAL_EVIDENCE_RE.test(text)) score += 20;
  if (TECHNICAL_BREADTH_RE.test(text)) score += 15;
  if (PRIMARY_SOURCE_RE.test(`${item.source || ""} ${item.url || ""}`) || /nature|science|university|arxiv/i.test(text)) score += 10;
  if (TECHNICAL_HYPE_RE.test(text) && !TECHNICAL_EVIDENCE_RE.test(text)) score = Math.min(score, 59);
  return Math.max(0, Math.min(100, score));
}

function isImportantQuantumTechnology(item) {
  return technicalImportanceScore(item) >= 65;
}

// ---------------------------------------------------------------- 任意のAI重要度判定(結果キャッシュ付き)

async function applyAiPriority(items, deadlineAt) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey || process.env.AI_PRIORITY_ENABLED === "false" || Date.now() >= deadlineAt) return items;

  let cache = {};
  try {
    const raw = await (await openStore()).get(AI_PRIORITY_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn(`AI priority cache read failed: ${error.message}`);
  }

  const now = Date.now();
  const pending = items.filter((item) => {
    if (!item.id || cache[item.id]) return false;
    const score = heuristicPriorityScore(item);
    const time = parseItemTime(item);
    return score >= 20 && time && now - time <= 24 * 60 * 60 * 1000;
  }).slice(0, 8);

  if (pending.length && Date.now() < deadlineAt) {
    try {
      const timeoutMs = Math.max(500, Math.min(1500, deadlineAt - Date.now()));
      const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: String(process.env.PRIORITY_AI_MODEL || process.env.REPORT_MODEL || "gpt-4o-mini").trim(),
          temperature: 0.1,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You are the editor of an IonQ shareholder news desk. Return JSON only: {\"items\":[{\"id\":\"...\",\"score\":0-100,\"reason\":\"short Japanese reason\"}]}. Judge on two independent lanes: investor materiality and quantum-technology importance. A technically important result can score 80+ even without immediate stock impact when it materially advances error correction, logical qubits, fidelity, scaling, modularity, interconnects, or demonstrated quantum advantage and has credible experimental evidence. Category portfolio means an acquired IonQ company or pending acquisition, so its contracts, products, government work, technology milestones, financial results, and major management changes can directly matter to IonQ even when the title omits IonQ. Score 80+ only when missing it today would leave an IonQ shareholder or serious quantum follower uninformed: material IonQ company events, exceptional quantum-industry shifts, credible technical milestones, or true US-market shocks. Score 60-79 only when there is a concrete verified fact, a clear IonQ/quantum/US-stock implication, a distinct posting angle, and a reason to post today or this week. Score below 60 for recaps, previews, duplicates, commentary, predictions, vague mentions, routine personnel news, routine partnerships, and low-information articles. A recap or preview cannot exceed 59. You may downgrade any heuristic score. Do not invent facts beyond the supplied title/source."
            },
            {
              role: "user",
              content: JSON.stringify(pending.map((item) => ({
                id: item.id,
                title: item.title,
                source: item.source,
                category: item.category,
                companyName: item.companyName || "",
                ionqPortfolio: Boolean(item.ionqPortfolio),
                heuristicScore: heuristicPriorityScore(item)
              })))
            }
          ]
        })
      }, timeoutMs);
      if (!response.ok) throw new Error(`openai_${response.status}`);
      const payload = await response.json();
      const content = String(payload?.choices?.[0]?.message?.content || "");
      parseAiPriorityResponse(content).forEach((entry) => {
        if (!pending.some((item) => item.id === entry.id)) return;
        cache[entry.id] = { score: entry.score, reason: entry.reason, at: new Date().toISOString() };
      });
      const keys = Object.keys(cache);
      if (keys.length > 800) {
        const trimmed = {};
        keys.slice(-600).forEach((key) => { trimmed[key] = cache[key]; });
        cache = trimmed;
      }
      await (await openStore()).set(AI_PRIORITY_KEY, JSON.stringify(cache));
    } catch (error) {
      console.warn(`AI priority fallback: ${error.message}`);
    }
  }

  return items.map((item) => {
    const result = cache[item.id];
    return result && Number.isFinite(Number(result.score))
      ? { ...item, aiPriorityScore: Number(result.score), aiPriorityReason: String(result.reason || "") }
      : item;
  });
}

function parseAiPriorityResponse(content) {
  try {
    const cleaned = String(content || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);
    return (Array.isArray(parsed.items) ? parsed.items : []).map((entry) => ({
      id: String(entry.id || ""),
      score: Math.max(0, Math.min(100, Math.round(Number(entry.score)))),
      reason: String(entry.reason || "").slice(0, 40)
    })).filter((entry) => entry.id && Number.isFinite(entry.score));
  } catch (error) {
    return [];
  }
}

// ---------------------------------------------------------------- 翻訳(Blobキャッシュ付き)

async function applyTranslations(items, deadlineAt = Date.now() + 8000) {
  let cache = {};
  try {
    const store = await openStore();
    const raw = await store.get(TRANSLATE_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn("translate cache read failed:", error.message);
  }

  // 表示対象(7日以内)を翻訳する。重要度を先に見て、同点ならカテゴリ順。
  // 技術記事が投資記事の後ろで翻訳枠を失わないようにする。
  const CATEGORY_PRIORITY = { ir: 0, news: 1, portfolio: 2, quantum: 3, macro: 4, sec: 5, competitor: 6 };
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const targets = items.filter((item) => {
    if (item.form) return false; // SECは下の静的マップで日本語化
    if (!shouldTranslateTitle(item.title)) return false;
    const ms = Date.parse(item.publishedAt || item.acceptedAt || "");
    return !Number.isFinite(ms) || Date.now() - ms <= windowMs;
  });
  // itemsは新着順ソート済み。stable sortなので同カテゴリ内の新着順は保たれる。
  targets.sort((a, b) =>
    newsPriorityScore(b) - newsPriorityScore(a) ||
    (CATEGORY_PRIORITY[a.category] !== undefined ? CATEGORY_PRIORITY[a.category] : 9) -
    (CATEGORY_PRIORITY[b.category] !== undefined ? CATEGORY_PRIORITY[b.category] : 9)
  );

  const pending = [];
  const seen = new Set();
  for (const item of targets) {
    const key = normalizeSignature(item.title);
    const entry = cache[key];
    if (typeof entry === "string") continue;            // 翻訳済み
    if (entry && entry.fail >= 4) continue;             // 4回失敗したら諦める(枠の無駄遣い防止)
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push({ key, title: item.title });
    if (pending.length >= MAX_TRANSLATE_PER_RUN) break;
  }

  if (pending.length) {
    let changed = 0;
    await runLimited(pending, TRANSLATE_CONCURRENCY, async (entry) => {
      if (Date.now() >= deadlineAt) return; // 時間切れ: 残りは次回実行に持ち越し
      const ja = await translateToJapanese(entry.title);
      if (ja && ja !== entry.title) {
        cache[entry.key] = ja;
        changed += 1;
      } else {
        // 失敗を記録。次回以降は他のタイトルに枠を回し、4回で打ち切り。
        const prev = cache[entry.key];
        cache[entry.key] = { fail: ((prev && prev.fail) || 0) + 1 };
        changed += 1;
      }
    });
    if (changed) {
      try {
        const store = await openStore();
        const keys = Object.keys(cache);
        if (keys.length > 1200) {
          const trimmed = {};
          keys.slice(-900).forEach((k) => { trimmed[k] = cache[k]; });
          cache = trimmed;
        }
        await store.set(TRANSLATE_KEY, JSON.stringify(cache));
      } catch (error) {
        console.warn("translate cache write failed:", error.message);
      }
    }
  }

  return items.map((item) => {
    if (item.form) {
      const ja = secTitleJa(item);
      return ja ? { ...item, titleJa: ja } : item;
    }
    const entry = cache[normalizeSignature(item.title)];
    return typeof entry === "string" ? { ...item, titleJa: entry } : item;
  });
}

// SEC書類は定型なので翻訳API不要。フォーム番号を日本語の意味に変換する。
const SEC_FORM_JA = {
  "8-K": "臨時報告（重要イベント発生）",
  "8-K/A": "臨時報告の訂正",
  "10-Q": "四半期報告",
  "10-K": "年次報告",
  "10-K/A": "年次報告の訂正",
  "S-3": "増資・売出の事前登録",
  "S-3/A": "増資登録の訂正",
  "S-8": "従業員株式報酬の登録",
  "424B3": "目論見書（売出条件）",
  "424B5": "目論見書（増資・売出条件）",
  "DEF 14A": "株主総会招集通知（委任状）",
  "PRE 14A": "株主総会招集通知（事前版）",
  "SC 13D": "大量保有報告（5%超・支配目的あり）",
  "SC 13G": "大量保有報告（5%超・純投資）",
  "SC 13D/A": "大量保有報告の変更",
  "SC 13G/A": "大量保有報告の変更",
  "13F-HR": "機関投資家の保有報告"
};

function secTitleJa(item) {
  const form = String(item.form || "").toUpperCase();
  const ja = SEC_FORM_JA[form] || matchSecPrefix(form);
  if (!ja) return "";
  const who = item.ticker && item.ticker !== "IONQ" ? `${item.ticker} ` : "";
  return `${who}SEC ${form}: ${ja}`;
}

function matchSecPrefix(form) {
  if (form.startsWith("424B")) return "目論見書（増資・売出条件）";
  if (form.startsWith("SC 13D")) return "大量保有報告（支配目的あり）";
  if (form.startsWith("SC 13G")) return "大量保有報告（純投資）";
  if (form.startsWith("S-3")) return "増資・売出の事前登録";
  if (form.startsWith("10-Q")) return "四半期報告";
  if (form.startsWith("10-K")) return "年次報告";
  if (form.startsWith("8-K")) return "臨時報告（重要イベント発生）";
  return "";
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
  if (idInSet(item, postedIds)) return "posted";
  if (idInSet(item, notifiedIds)) return "already_notified";
  if (idInSet(item, knownIds)) return "already_known";
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
  if (!isNotificationWorthy(item, nowValue)) return "low_priority";
  return isImmediateNews(item, nowValue) ? "will_notify" : "will_digest";
}

// 投稿枠を使う価値で判定する。速報80点、投稿候補60点。
// 既報・プレビューはハード上限を設け、重要語の足し算だけで昇格させない。
const HIGH_IMPACT_NEWS_RE = /earnings|revenue|guidance|quarterly results?|annual results?|contract|award|order|bookings?|backlog|multi[ -]year|definitive agreement|\$\s?\d[\d,.]*\s?(?:million|billion)|\d[\d,.]*\s?(?:million|billion) dollars|funding|financing|raises?|raised|offering|convertible|acquisition|merger|buyout|dilution|upgrade|downgrade|price target|rating|breakthrough|logical qubit|error correction|fault[ -]tolerant|quantum advantage|legislation|appropriation|government budget|executive order|national strategy|export controls?|debt ceiling|government shutdown|short seller/i;
const MATERIAL_NEWS_RE = /deal|partnership|strategic|collaboration|customer|deployment|government|defense|army|navy|air force|darpa|doe|nasa|commercial|production|data center|investment|stake|analyst/i;
const CRITICAL_MACRO_RE = /emergency rate cut|emergency rate hike|market crash|market selloff|bank (?:crisis|failure|collapse)|liquidity crisis|debt default|government shutdown begins|trading halt|vix (?:spikes?|surges?)/i;
const MARKET_MOVING_MACRO_RE = /(?:federal reserve|\bfed\b|\bfomc\b).*(?:cuts?|hikes?|holds?|decision|statement)|(?:rate cut|rate hike|interest rate decision)|consumer price index summary|producer price index summary|employment situation|jobs report|nonfarm payrolls?|gross domestic product|personal income and outlays|\bcpi\b.*(?:rises?|falls?|increases?|decreases?|\d)|\bpce\b.*(?:rises?|falls?|increases?|decreases?|\d)|\bgdp\b.*(?:growth|grows?|contracts?|beats?|misses?|\d)|unemployment.*(?:rises?|falls?|\d)|jobless claims.*(?:jumps?|rises?|falls?|drops?|\d)|treasury auction.*(?:weak|strong|yield|demand)|yields?.*(?:surges?|jumps?|spikes?)/i;
const LOW_VALUE_NEWS_RE = /should you buy|is .* a buy|stock price prediction|price forecast|where will .* stock|why .* stock|could .* stock|millionaire.?maker|technical analysis|unusual options|options trading|short interest|wall street thinks|top \d+ .*stocks?/i;
const RECAP_NEWS_RE = /weekly (?:roundup|recap)|news roundup|year in review|look(?:ing)? back|revisited|what we (?:know|learned)|previously announced|earlier this (?:week|month|year)|last quarter|history of/i;
const PREVIEW_NEWS_RE = /what to expect|earnings preview|ahead of (?:earnings|results)|set to report|scheduled to (?:report|announce)|will report|earnings date|could announce|expected to announce/i;
const PRIMARY_SOURCE_RE = /sec edgar|ionq ir|ionq公式|quantinuum ir|nasdaq\/(?:ionq|qnt)|business wire|globenewswire|pr newswire|nature|science|arxiv|university|\.gov\b|darpa|department of defense|department of energy|federal reserve|\bbls\b|bureau of labor statistics|\bbea\b|bureau of economic analysis/i;

function heuristicPriorityScore(item) {
  const text = `${item.title || ""} ${item.source || ""} ${item.label || ""} ${item.description || ""}`.toLowerCase();
  const category = String(item.category || "").toLowerCase();
  const ionqText = `${item.title || ""} ${item.description || ""} ${item.companyName || ""} ${item.ticker || ""} ${item.source || ""} ${item.url || ""}`.toLowerCase();
  const directIonq = Boolean(item.ionqPortfolio) || String(item.ticker || "").toUpperCase() === "IONQ" || /\bionq\b|\$ionq|ionq公式|ionq ir|nasdaq\/ionq/.test(ionqText);
  const sourceText = `${item.source || ""} ${item.label || ""} ${item.url || ""}`.toLowerCase();
  const highImpact = HIGH_IMPACT_NEWS_RE.test(text) || isImportantSec(item);
  const material = highImpact || MATERIAL_NEWS_RE.test(text);
  const primary = PRIMARY_SOURCE_RE.test(sourceText) || Boolean(item.form);
  let score = 0;

  if (directIonq) score += 30;
  if (highImpact) score += 40;
  else if (material) score += 30;
  if (primary) score += 15;
  if ((category === "competitor" || category === "quantum") && material) score += 20;
  score = Math.max(score, technicalImportanceScore(item));
  if (category === "macro" && MARKET_MOVING_MACRO_RE.test(text)) score += 65;
  if (category === "macro" && CRITICAL_MACRO_RE.test(text)) score = Math.max(score, 85);
  if (LOW_VALUE_NEWS_RE.test(text)) score = Math.min(score - 45, 39);
  if (RECAP_NEWS_RE.test(text)) score = Math.min(score, 49);
  if (PREVIEW_NEWS_RE.test(text)) score = Math.min(score, 59);

  return Math.max(0, Math.min(100, score));
}

function mergeAiPriorityScore(baseScore, aiScore) {
  const base = Number(baseScore);
  const ai = Number(aiScore);
  if (!Number.isFinite(ai) || ai < 0 || ai > 100) return base;
  return Math.max(0, Math.min(100, Math.round(base * 0.35 + ai * 0.65)));
}

function newsPriorityScore(item, nowValue = Date.now()) {
  return mergeAiPriorityScore(heuristicPriorityScore(item), item.aiPriorityScore);
}

function isNotificationWorthy(item, nowValue) {
  return newsPriorityScore(item, nowValue) >= 60;
}

function isImmediateNews(item, nowValue) {
  return newsPriorityScore(item, nowValue) >= 80;
}

function compareNewsPriority(a, b, nowValue) {
  const scoreDiff = newsPriorityScore(b, nowValue) - newsPriorityScore(a, nowValue);
  if (scoreDiff) return scoreDiff;
  return (parseItemTime(b) || 0) - (parseItemTime(a) || 0);
}

function priorityReasonLabels(item) {
  const text = `${item.title || ""} ${item.source || ""} ${item.label || ""} ${item.description || ""}`.toLowerCase();
  const category = String(item.category || "").toLowerCase();
  const ionqText = `${item.title || ""} ${item.description || ""} ${item.companyName || ""} ${item.ticker || ""} ${item.source || ""} ${item.url || ""}`.toLowerCase();
  const sourceText = `${item.source || ""} ${item.label || ""} ${item.url || ""}`.toLowerCase();
  const reasons = [];
  if (item.ionqPortfolio) reasons.push("IonQグループ");
  else if (String(item.ticker || "").toUpperCase() === "IONQ" || /\bionq\b|\$ionq|ionq公式|ionq ir|nasdaq\/ionq/.test(ionqText)) reasons.push("IonQ直結");
  if (PRIMARY_SOURCE_RE.test(sourceText) || item.form) reasons.push("一次情報");
  if (HIGH_IMPACT_NEWS_RE.test(text) || isImportantSec(item)) reasons.push("重要材料");
  else if (MATERIAL_NEWS_RE.test(text)) reasons.push("関連材料");
  if (isImportantQuantumTechnology(item)) reasons.push("技術重要");
  if (category === "macro") reasons.push("市場全体");
  if (RECAP_NEWS_RE.test(text)) reasons.push("既報・振り返り");
  if (Number.isFinite(Number(item.aiPriorityScore))) reasons.push("AI確認済み");
  return [...new Set(reasons)].slice(0, 3);
}

function mergeDigestQueue(existing, incoming, nowValue, postedIds = new Set()) {
  const now = typeof nowValue === "number" ? nowValue : Date.parse(nowValue);
  const queue = [];
  [...existing, ...incoming].forEach((item) => {
    const itemTime = parseItemTime(item);
    if (!item || !item.id || idInSet(item, postedIds) || !itemTime) return;
    if (Number.isFinite(now) && (now - itemTime < -FUTURE_TOLERANCE_MS || now - itemTime > 24 * 60 * 60 * 1000)) return;
    const sameIndex = queue.findIndex((queued) => queued.id === item.id || (!item.form && !queued.form && isSimilarNews(queued, item)));
    if (sameIndex < 0) queue.push(item);
    else if (compareNewsPriority(item, queue[sameIndex], now) < 0) queue[sameIndex] = item;
  });
  const sorted = queue.sort((a, b) => compareNewsPriority(a, b, now));
  const selected = sorted.filter(isImportantQuantumTechnology).slice(0, 2);
  sorted.forEach((item) => {
    if (selected.length < 5 && !selected.includes(item)) selected.push(item);
  });
  return selected.sort((a, b) => compareNewsPriority(a, b, now));
}

function currentDigestSlot(nowValue) {
  const ms = typeof nowValue === "number" ? nowValue : Date.parse(nowValue);
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const values = {};
  parts.forEach((part) => { values[part.type] = part.value; });
  if (values.hour !== "08" && values.hour !== "20") return "";
  return `${values.year}-${values.month}-${values.day}-${values.hour}`;
}

function effectiveLookbackMinutes() {
  const configured = Number(process.env.WATCH_LOOKBACK_MINUTES || DEFAULT_LOOKBACK_MINUTES);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_LOOKBACK_MINUTES;
  return Math.min(Math.max(configured, 30), 1440);
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

function isCollectableItemTime(item, nowValue = Date.now()) {
  const itemTime = parseItemTime(item);
  const now = typeof nowValue === "number" ? nowValue : Date.parse(nowValue);
  if (!itemTime || !Number.isFinite(now)) return false;
  const age = now - itemTime;
  return age >= -FUTURE_TOLERANCE_MS &&
    age <= MAX_COLLECTION_AGE_HOURS * 60 * 60 * 1000;
}

// ---------------------------------------------------------------- 通知

async function sendNotification(items, options = {}) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) return;
  const total = options.totalCount || list.length;
  const title = options.title || (total > 1 ? `IONQ新着 ${total}件` : "IONQ新着");

  if (getDiscordWebhookUrl()) {
    await sendDiscord(list, title, total);
    return true;
  }

  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    const first = list[0];
    const message = `${title}\n${first.title}\n${first.source || ""} ${first.publishedAt || ""}\n${first.url}`;
    await sendPushover(title, message, first.url);
    return true;
  }

  if (options.requireTarget) {
    throw new Error("Notification target is not configured. Set DISCORD_WEBHOOK_URL in Netlify environment variables.");
  }
  console.log("No notification target configured.");
  return false;
}

// Discord embed上限に合わせて5件ずつ送り、6件目以降も捨てない。
async function sendNotificationBatches(items, options = {}) {
  const batches = splitNotificationBatches(items, MAX_NOTIFY_EMBEDS);
  for (let index = 0; index < batches.length; index += 1) {
    const suffix = batches.length > 1 ? ` (${index + 1}/${batches.length})` : "";
    const sent = await sendNotification(batches[index], {
      ...options,
      title: `${options.title || "IONQ新着"}${suffix}`,
      totalCount: batches[index].length
    });
    if (!sent) throw new Error("Notification target is not configured; items were kept unnotified for retry.");
  }
}

function splitNotificationBatches(items, size = MAX_NOTIFY_EMBEDS) {
  const list = Array.isArray(items) ? items : [];
  const batchSize = Math.max(1, Number(size) || MAX_NOTIFY_EMBEDS);
  const batches = [];
  for (let index = 0; index < list.length; index += batchSize) {
    batches.push(list.slice(index, index + batchSize));
  }
  return batches;
}

async function sendDiscord(items, title, total) {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is empty.");

  const embeds = items.slice(0, MAX_NOTIFY_EMBEDS).map((item) => {
    const jst = formatJst(item.acceptedAt || item.publishedAt);
    const reasons = priorityReasonLabels(item);
    const hasUrl = /^https?:\/\//i.test(String(item.url || ""));
    const descriptionLines = [
      item.titleJa ? truncate(item.titleJa, 200) : null,
      reasons.length ? `📌 ${reasons.join("・")}` : null,
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

async function readCacheItems() {
  try {
    const store = await openStore();
    const value = await store.get(CACHE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (error) {
    console.warn("Could not read previous cache.", error.message);
    return [];
  }
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

// 投稿済みIDの読み込み。posted.jsと同じ格納方式:
// - 旧形式: posted-state キーに {ids:[...]} をまとめて保存
// - 新形式: posted/1/<id>(チェック) と posted/0/<id>(チェック外し)の個別キー
// 個別キー方式は「全件読んで全件書き戻す」際の取りこぼし(チェック復活)を防ぐ。
async function readPostedIds() {
  try {
    const store = await openStore();
    const ids = new Set();
    try {
      const value = await store.get(POSTED_KEY);
      if (value) {
        const parsed = JSON.parse(value);
        (Array.isArray(parsed.ids) ? parsed.ids : []).forEach((id) => ids.add(String(id)));
      }
    } catch (error) {
      console.warn("Could not read legacy posted state.", error.message);
    }
    const checked = await listKeys(store, "posted/1/");
    const unchecked = await listKeys(store, "posted/0/");
    unchecked.forEach((id) => ids.delete(id));
    checked.forEach((id) => ids.add(id));
    return [...ids];
  } catch (error) {
    console.warn("Could not read posted state.", error.message);
    return [];
  }
}

async function listKeys(store, prefix) {
  try {
    const result = await store.list({ prefix });
    return (result && result.blobs ? result.blobs : []).map((blob) => String(blob.key).slice(prefix.length));
  } catch (error) {
    console.warn(`Could not list ${prefix} keys.`, error.message);
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
