const SEC_CIK = "0001824920";

exports.handler = async () => {
  try {
    const [sec, officialNews, marketNews, xPosts] = await Promise.all([
      getSecFilings(),
      getGoogleNews("site:investors.ionq.com/news/news-details IonQ"),
      getGoogleNews("IONQ OR $IONQ"),
      getXPosts()
    ]);

    const payload = {
      updatedAt: new Date().toISOString(),
      sec,
      officialNews,
      marketNews,
      xPosts
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
  const response = await fetch(`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, {
    headers: {
      "User-Agent": "IONQ Watchdesk contact@example.com",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`SEC request failed: ${response.status}`);
  }

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
      accessionNumber: accession,
      primaryDocument: recent.primaryDocument[index],
      description: recent.primaryDocDescription[index] || recent.form[index],
      url: `https://www.sec.gov/Archives/edgar/data/1824920/${accessionPath}/${recent.primaryDocument[index]}`
    };
  });
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
      publishedAt: post.created_at,
      metrics: post.public_metrics || {}
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
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
