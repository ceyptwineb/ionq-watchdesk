// Deep Japanese report generation for IonQ/quantum news.
// The function fetches the article body first, then sends the body to OpenAI.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = (process.env.REPORT_MODEL || "gpt-4o-mini").trim();
const MAX_ARTICLE_CHARS = 18000;
const MIN_ARTICLE_CHARS = 450;

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  // 簡易認証: REPORT_SECRET が設定されている場合、x-report-secret ヘッダーの一致を必須にする。
  // これが無いと誰でもこのエンドポイントを叩いてOpenAIクレジットを消費できてしまう。
  const requiredSecret = String(process.env.REPORT_SECRET || "").trim();
  if (requiredSecret) {
    const headers = event.headers || {};
    const given = String(headers["x-report-secret"] || headers["X-Report-Secret"] || "").trim();
    if (given !== requiredSecret) return cors(401, { ok: false, error: "unauthorized" });
  }

  try {
    if (event.httpMethod === "GET") {
      const query = event.queryStringParameters || parseQuery(event.rawQuery || "");
      if (query.testFetch === "1") {
        const article = await fetchArticle(query.url || "");
        return cors(200, {
          ok: article.ok,
          result: "article_fetch_test",
          article: summarizeArticle(article, query.url || "", true)
        });
      }
      return cors(200, { ok: false, error: "use_post" });
    }

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return cors(200, { ok: false, error: "no_api_key" });

    const item = parseBody(event.body);
    const url = String(item.url || "").trim();
    if (!url) return cors(200, { ok: false, error: "no_url" });

    const article = await fetchArticle(url);
    if (!article.ok) {
      return cors(200, {
        ok: false,
        error: "article_fetch_failed",
        article: summarizeArticle(article, url, false)
      });
    }

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 3200,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: buildUserPrompt(item, article) }
        ]
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      return cors(200, { ok: false, error: `openai_${response.status}`, detail });
    }

    const data = await response.json();
    const draft = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!draft) return cors(200, { ok: false, error: "empty_draft" });

    return cors(200, {
      ok: true,
      draft,
      article: summarizeArticle(article, url, false)
    });
  } catch (error) {
    return cors(200, { ok: false, error: error.message || "unknown_error" });
  }
};

async function fetchArticle(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "invalid_url", text: "" };

  const attempts = [
    { method: "direct", url },
    ...readerUrls(url).map((readerUrl) => ({ method: "reader", url: readerUrl }))
  ];

  let last = { ok: false, error: "not_attempted", text: "" };
  for (const attempt of attempts) {
    const result = await fetchArticleAttempt(attempt.url, attempt.method);
    if (result.ok) return result;
    last = result;
  }
  return { ...last, ok: false };
}

async function fetchArticleAttempt(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), method === "reader" ? 17000 : 10000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; IonQWatchdesk/2.0; +https://ionqwatchdesk.netlify.app/)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `fetch_${response.status}`, method, finalUrl: response.url, text: "" };
    }

    const raw = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const text = method === "reader"
      ? cleanReaderText(raw)
      : contentType.includes("html") || /<html|<article|<body/i.test(raw)
        ? extractReadableText(raw)
        : cleanText(raw);

    if (!text || text.length < MIN_ARTICLE_CHARS) {
      return {
        ok: false,
        error: "article_text_too_short",
        method,
        finalUrl: response.url,
        text: text ? text.slice(0, MAX_ARTICLE_CHARS) : ""
      };
    }

    return {
      ok: true,
      method,
      finalUrl: response.url,
      text: text.slice(0, MAX_ARTICLE_CHARS)
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false,
      error: error.name === "AbortError" ? "fetch_timeout" : (error.message || "fetch_failed"),
      method,
      finalUrl: url,
      text: ""
    };
  }
}

function readerUrls(url) {
  const normalized = String(url || "").trim();
  const noScheme = normalized.replace(/^https?:\/\//i, "");
  return [
    `https://r.jina.ai/http://r.jina.ai/http://${normalized}`,
    `https://r.jina.ai/http://r.jina.ai/http://https://${noScheme}`,
    `https://r.jina.ai/http://r.jina.ai/http://http://${noScheme}`,
    `https://r.jina.ai/http://${normalized}`,
    `https://r.jina.ai/http://https://${noScheme}`,
    `https://r.jina.ai/http://http://${noScheme}`
  ];
}

function extractReadableText(html) {
  const meta = [
    ...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)
  ].map((match) => decodeHtml(match[1])).join("\n");

  const jsonLd = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  ].map((match) => decodeHtml(stripTags(match[1]))).join("\n");

  const article = html.match(/<article[\s\S]*?<\/article>/i)?.[0];
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0];
  const body = html.match(/<body[\s\S]*?<\/body>/i)?.[0];
  const base = article || main || body || html;

  const readable = base
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<(p|br|li|h1|h2|h3|h4|blockquote|div|section|tr)[^>]*>/gi, "\n")
    .replace(/<\/(p|li|h1|h2|h3|h4|blockquote|div|section|tr)>/gi, "\n");

  return cleanText([meta, jsonLd, stripTags(readable)].filter(Boolean).join("\n"));
}

function cleanReaderText(value) {
  return cleanText(value)
    .replace(/^Title:\s*/gim, "")
    .replace(/^URL Source:\s*.*$/gim, "")
    .replace(/^Markdown Content:\s*/gim, "")
    .trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function systemPrompt() {
  return `あなたはIonQ（米国のイオントラップ型量子コンピュータ企業、ティッカー $IONQ）に詳しい日本語の投資情報アナリストです。
ユーザーはX向けに、速報性があり、短くても深い投資メモを作りたい。

絶対ルール:
- 渡された記事本文を最優先に読む。
- 本文にない数字、契約金額、提携先、日付、発言は捏造しない。
- タイトルだけの一般論で逃げない。
- 報道は二次情報、SEC/公式IRは一次情報として扱う。
- 投資助言ではなく、投資家が確認すべき論点として書く。
- 日本語で、X長文投稿向けに読みやすくする。

IonQの基礎知識:
- IonQはイオントラップ方式。強みは高いゲート忠実度、全結合、AWS/Azure/Google Cloudでの提供。
- 弱みはゲート速度、量子ビット数の拡張ペース、赤字先行、高バリュエーション、大手より小さい研究開発費。
- 性能は物理量子ビット数だけでなくAQ（アルゴリズム量子ビット）、忠実度、接続性、エラー率で見る。
- 決算では受注残/backlog、bookings、手元現金、純損失の推移を見る。
- 契約はPoCか複数年本契約かで価値が違う。政府、防衛、大手企業、金額と期間の明示は重要。
- 競合はRGTI、QBTS、QUBT、IBM、GOOGL、MSFT、AMZN、HON/Quantinuum、NVDA。

出力フォーマット:
【分類ラベル】
目を引く一言タイトル

ひとことで:
記事の核心を1文で。数字、企業名、機関名が本文にあれば必ず入れる。

要点:
2〜3文で、何が起きたかを具体的に。

押さえる数字:
・本文に出た重要数字を箇条書き。なければこの節は省略。

ニュース内容:
記事本文の内容を具体的に説明。業界用語があれば自然に補足する。

読み解き:
IonQ、量子業界、競争環境、株価材料として何を見るべきか。

IonQの勝ち負け:
競合・他社比較の記事の時だけ書く。1〜3行でよい。

評価:
・凄さ：★★★☆☆
・株価影響：★★★☆☆
・関連銘柄： $IONQ / $RGTI / $QBTS など本文に関係するもの

結論:
投資家への一言。

出典:
出典名
URL`;
}

function buildUserPrompt(item, article) {
  return [
    "以下の記事本文を読んで、IonQ/量子業界の投資家向けに深掘りレポートを書いてください。",
    "",
    `分類: ${item.type || item.kind || "NEWS"}`,
    `タイトル: ${item.title || ""}`,
    `出典: ${item.source || ""}`,
    `URL: ${item.url || article.finalUrl || ""}`,
    `公開時刻: ${formatJst(item.publishedAt) || ""}`,
    `本文取得方法: ${article.method || ""}`,
    `取得URL: ${article.finalUrl || ""}`,
    "",
    "記事本文:",
    article.text
  ].join("\n");
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
  }).format(new Date(ms));
}

function summarizeArticle(article, fallbackUrl, includeSample) {
  const summary = {
    ok: !!article.ok,
    error: article.error || "",
    method: article.method || "",
    chars: article.text ? article.text.length : 0,
    finalUrl: article.finalUrl || fallbackUrl || ""
  };
  if (includeSample) summary.sample = String(article.text || "").slice(0, 1200);
  return summary;
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    return {};
  }
}

function parseQuery(raw) {
  return String(raw || "").split("&").filter(Boolean).reduce((params, part) => {
    const [key, ...rest] = part.split("=");
    params[decodeURIComponent(key || "")] = decodeURIComponent(rest.join("=") || "");
    return params;
  }, {});
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-report-secret"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
