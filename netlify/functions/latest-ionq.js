const SEC_CIK = "0001824920";
const COMPETITOR_TICKERS = ["RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "MSFT", "AMZN", "HON", "NVDA"];
const QUANTUM_RSS_FEEDS = [
  { source: "The Quantum Insider", url: "https://thequantuminsider.com/feed/" },
  { source: "Quantum Computing Report", url: "https://quantumcomputingreport.com/feed/" },
  { source: "Inside Quantum Technology", url: "https://www.insidequantumtechnology.com/feed/" },
  { source: "Quantum Zeitgeist", url: "https://quantumzeitgeist.com/feed/" },
  { source: "HPCwire", url: "https://www.hpcwire.com/feed/" }
];

exports.handler = async () => {
  try {
    const [sec, officialNews, marketNews, quantumNews, competitorSec, competitorNews] = await Promise.all([
      getSecFilings(),
      getGoogleNews("site:investors.ionq.com/news/news-details IonQ"),
      getGoogleNews("IONQ OR $IONQ"),
      getQuantumNews(),
      getCompetitorSecFilings(),
      getGoogleNews("(Rigetti OR RGTI OR D-Wave OR QBTS OR \"Quantum Computing Inc\" OR QUBT OR Quantinuum OR \"IBM quantum\" OR \"Google quantum\" OR \"Microsoft quantum\" OR \"AWS Braket\" OR \"NVIDIA quantum\")")
    ]);

    const payload = await translateNewsTitles({
      updatedAt: new Date().toISOString(),
      sec,
      officialNews,
      marketNews,
      quantumNews,
      competitorSec,
      competitorNews
    });

    return json(200, payload);
  } catch (error) {
    return json(500, {
      updatedAt: new Date().toISOString(),
      error: "latest_fetch_failed",
      message: error.message
    });
  }
};

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
      "User-Agent": "IONQ Watchdesk contact@example.com",
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
      "User-Agent": "IONQ Watchdesk contact@example.com",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`SEC request failed for ${ticker}: ${response.status}`);
  }

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

function isImportantSec(item) {
  const form = String(item.form || "").toUpperCase();
  const description = String(item.description || "").toUpperCase();
  if (["3", "4", "5", "144"].includes(form)) return false;
  if (description.includes("OWNERSHIP")) return false;
  return /8-K|10-Q|10-K|S-3|424B|DEF 14A|PRE 14A|SC 13|13D|13G/.test(form) ||
    /PROSPECTUS|CURRENT REPORT|QUARTERLY|ANNUAL/.test(description);
}

async function getXPosts() {
  if (!process.env.X_BEARER_TOKEN) return { posts: [], status: "token_missing" };

  const bearerToken = process.env.X_BEARER_TOKEN
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!bearerToken) return { posts: [], status: "token_missing" };

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
    return { posts: [], status: `api_${response.status}` };
  }

  const payload = await response.json();
  const users = new Map((payload.includes && payload.includes.users || []).map((user) => [user.id, user]));

  const posts = (payload.data || []).map((post) => {
    const user = users.get(post.author_id) || {};
    return {
      title: post.text,
      url: user.username ? `https://x.com/${user.username}/status/${post.id}` : `https://x.com/i/web/status/${post.id}`,
      source: user.username ? `@${user.username}` : "X",
      curatedList: true,
      publishedAt: post.created_at,
      metrics: post.public_metrics || {}
    };
  });

  return { posts, status: posts.length ? "list_ok" : "no_recent_posts" };
}

async function getGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}%20when%3A7d&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "IONQ Watchdesk contact@example.com",
      "Accept": "application/rss+xml,text/xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Google News request failed: ${response.status}`);
  }

  const xml = await response.text();
  return parseItems(xml).slice(0, 8);
}

async function getQuantumNews() {
  const googleQueries = [
    "\"quantum computing\" OR \"quantum computer\" OR \"quantum technology\" -IONQ -$IONQ",
    "\"quantum computing\" (startup OR funding OR partnership OR contract OR government OR defense)",
    "\"quantum computing\" (institutional investor OR hedge fund OR asset manager OR ETF OR holdings OR stake OR portfolio)",
    "\"quantum computing stocks\" (analyst OR rating OR upgrade OR downgrade OR price target OR investor)",
    "(IONQ OR Rigetti OR D-Wave OR Quantinuum OR \"Quantum Computing Inc\") (institutional investor OR holdings OR ETF OR analyst OR price target)",
    "\"quantum computing\" (PRNewswire OR GlobeNewswire OR BusinessWire OR \"press release\")",
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
    return await getGoogleNews(query);
  } catch (error) {
    console.warn(`Google quantum query failed: ${error.message}`);
    return [];
  }
}

async function safeGetFeed(feed) {
  try {
    const response = await fetch(feed.url, {
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

function dedupeItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = normalizeKey(item.url || item.title);
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

async function translateNewsTitles(payload) {
  const keys = ["officialNews", "marketNews", "quantumNews", "competitorNews"];
  const titles = Array.from(new Set(keys
    .flatMap((key) => payload[key] || [])
    .map((item) => String(item.title || "").trim())
    .filter(Boolean)
    .filter(shouldTranslateTitle)
  ));

  if (!titles.length) return payload;

  const translated = new Map();
  await runLimited(titles, 4, async (title) => {
    const ja = await translateToJapanese(title);
    if (ja && ja !== title) translated.set(title, ja);
  });

  keys.forEach((key) => {
    payload[key] = (payload[key] || []).map((item) => {
      const title = String(item.title || "").trim();
      const titleJa = translated.get(title);
      return titleJa ? { ...item, titleJa } : item;
    });
  });

  return payload;
}

function shouldTranslateTitle(title) {
  if (!title) return false;
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title)) return false;
  return /[a-zA-Z]/.test(title);
}

async function translateToJapanese(text) {
  try {
    const endpoint = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=" + encodeURIComponent(text);
    const response = await fetch(endpoint, {
      headers: { "User-Agent": "IONQ Watchdesk contact@example.com" }
    });
    if (!response.ok) return "";
    const data = await response.json();
    return Array.isArray(data && data[0])
      ? data[0].map((part) => part && part[0] ? part[0] : "").join("").trim()
      : "";
  } catch (error) {
    console.warn(`Translate failed: ${error.message}`);
    return "";
  }
}

async function runLimited(items, limit, worker) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function parseItems(xml, fallbackSource = "") {
  const items = [];
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

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
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    },
    body: JSON.stringify(body)
  };
}
