const SEC_CIK = "0001824920";
const COMPETITOR_TICKERS = ["RGTI", "QBTS", "QUBT", "IBM", "GOOGL", "MSFT", "AMZN", "HON", "NVDA"];

exports.handler = async () => {
  try {
    const [sec, officialNews, marketNews, quantumNews, competitorSec, competitorNews] = await Promise.all([
      getSecFilings(),
      getGoogleNews("site:investors.ionq.com/news/news-details IonQ"),
      getGoogleNews("IONQ OR $IONQ"),
      getGoogleNews("\"quantum computing\" OR \"quantum computer\" OR \"quantum technology\" -IONQ -$IONQ"),
      getCompetitorSecFilings(),
      getGoogleNews("(Rigetti OR RGTI OR D-Wave OR QBTS OR \"Quantum Computing Inc\" OR QUBT OR Quantinuum OR \"IBM quantum\" OR \"Google quantum\" OR \"Microsoft quantum\" OR \"AWS Braket\" OR \"NVIDIA quantum\")")
    ]);

    const payload = {
      updatedAt: new Date().toISOString(),
      sec,
      officialNews,
      marketNews,
      quantumNews,
      competitorSec,
      competitorNews
    };

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
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    },
    body: JSON.stringify(body)
  };
}
