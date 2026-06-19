const crypto = require("node:crypto");

const SEC_CIK = "0001824920";
const STORE_NAME = "ionq-watchdesk";
const STATE_KEY = "watch-state";
const DEFAULT_LOOKBACK_MINUTES = 18;

exports.handler = async () => {
  const startedAt = new Date().toISOString();

  try {
    const data = await collectLatest();
    const items = normalizeLatestItems(data);
    const state = await readState();
    const postedIds = new Set(state.postedIds || []);
    const notifiedIds = new Set(state.notifiedIds || []);
    const fresh = items.filter((item) =>
      !postedIds.has(item.id) &&
      !notifiedIds.has(item.id) &&
      !isNoisySecOwnership(item) &&
      shouldNotifyByTime(item, startedAt)
    );

    if (!fresh.length) {
      await writeState({
        ...state,
        lastCheckedAt: startedAt,
        lastResult: "no_new_items"
      });
      return json(200, { ok: true, result: "no_new_items", checkedAt: startedAt });
    }

    const item = fresh[0];
    await sendNotification(item, fresh.length);

    fresh.forEach((entry) => notifiedIds.add(entry.id));
    await writeState({
      ...state,
      notifiedIds: [...notifiedIds].slice(-500),
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
  const [sec, officialNews, marketNews, xPosts] = await Promise.all([
    getSecFilings(),
    getGoogleNews("site:investors.ionq.com/news/news-details IonQ"),
    getGoogleNews("IONQ OR $IONQ"),
    getXPosts()
  ]);

  return {
    updatedAt: new Date().toISOString(),
    sec,
    officialNews,
    marketNews,
    xPosts
  };
}

async function getSecFilings() {
  const response = await fetch(`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, {
    headers: {
      "User-Agent": process.env.SEC_USER_AGENT || "IONQ Watchdesk contact@example.com",
      "Accept": "application/json"
    }
  });

  if (!response.ok) throw new Error(`SEC request failed: ${response.status}`);

  const data = await response.json();
  const recent = data.filings && data.filings.recent ? data.filings.recent : {};
  const forms = recent.form || [];

  return forms.slice(0, 8).map((form, index) => {
    const accession = recent.accessionNumber[index];
    const accessionPath = accession.replace(/-/g, "");
    return {
      form,
      filingDate: recent.filingDate[index],
      reportDate: recent.reportDate[index] || "",
      acceptedAt: recent.acceptanceDateTime[index] || "",
      accessionNumber: accession,
      primaryDocument: recent.primaryDocument[index],
      description: recent.primaryDocDescription[index] || recent.form[index],
      url: `https://www.sec.gov/Archives/edgar/data/1824920/${accessionPath}/${recent.primaryDocument[index]}`
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

  const query = '(IONQ OR "$IONQ" OR "IonQ") -is:retweet';
  const params = new URLSearchParams({
    query,
    max_results: "10",
    "tweet.fields": "created_at,public_metrics,author_id,lang",
    expansions: "author_id",
    "user.fields": "username,name,verified"
  });

  const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: {
      "Authorization": `Bearer ${process.env.X_BEARER_TOKEN}`,
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
      publishedAt: post.created_at,
      metrics: post.public_metrics || {}
    };
  });
}

function normalizeLatestItems(data) {
  const items = [];

  data.sec.forEach((item) => items.push(withId({
    title: `SEC ${item.form}: ${item.description}`,
    url: item.url,
    source: "SEC",
    kind: "SEC開示",
    form: item.form,
    description: item.description,
    publishedAt: item.filingDate,
    acceptedAt: item.acceptedAt,
    notes: `提出日: ${item.filingDate}\nフォーム: ${item.form}\n内容はSEC本文で確認`
  })));

  data.officialNews.forEach((item) => items.push(withId({
    title: item.title,
    url: item.url,
    source: item.source || "IonQ IR / Google News",
    kind: "IR・提携",
    publishedAt: item.publishedAt,
    notes: `公式IR系の最新候補\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  data.marketNews.forEach((item) => items.push(withId({
    title: item.title,
    url: item.url,
    source: item.source || "Google News",
    kind: "株価材料",
    publishedAt: item.publishedAt,
    notes: `市場ニュースの最新候補\n公開時刻: ${item.publishedAt || "要確認"}`
  })));

  (data.xPosts || []).forEach((item) => items.push(withId({
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
    id: crypto.createHash("sha256").update(`${item.url || ""}|${item.title || ""}`).digest("hex")
  };
}

function isNoisySecOwnership(item) {
  if (item.kind !== "SEC開示") return false;
  const form = String(item.form || "").toUpperCase();
  const text = `${item.title || ""} ${item.description || ""}`.toUpperCase();
  return form === "4" || text.includes("FORM 4") || text.includes("OWNERSHIP");
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
  const lookbackMinutes = Number(process.env.WATCH_LOOKBACK_MINUTES || DEFAULT_LOOKBACK_MINUTES);
  const oldestAllowed = now - lookbackMinutes * 60 * 1000;

  return itemTime >= oldestAllowed && itemTime <= now + 2 * 60 * 1000;
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

async function sendNotification(item, count) {
  const title = count > 1 ? `IONQ新着 ${count}件` : "IONQ新着";
  const message = `${title}\n${item.title}\n${item.source || ""} ${item.publishedAt || ""}\n${item.url}`;

  if (process.env.DISCORD_WEBHOOK_URL) {
    await sendDiscord(item, title);
    return;
  }

  if (process.env.PUSHOVER_USER_KEY && process.env.PUSHOVER_APP_TOKEN) {
    await sendPushover(title, message, item.url);
    return;
  }

  console.log("No notification target configured. Set DISCORD_WEBHOOK_URL or PUSHOVER_USER_KEY/PUSHOVER_APP_TOKEN.");
}

async function sendDiscord(item, title) {
  const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `**${title}**\n${item.title}\n${item.source || ""} ${item.publishedAt || ""}\n${item.url}`
    })
  });

  if (!response.ok) throw new Error(`Discord webhook failed: ${response.status}`);
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

async function readState() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(STORE_NAME);
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

async function writeState(state) {
  try {
    if (state.storageUnavailable) return;
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(STORE_NAME);
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
