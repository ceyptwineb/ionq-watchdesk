// Generate a Japanese IonQ-focused report for one selected item.
// Uses OpenAI Chat Completions API and best-effort article fetching with plain fetch.
const MODEL = (process.env.REPORT_MODEL || "gpt-4o-mini").trim();
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_ARTICLE_CHARS = 14000;

const SYSTEM_PROMPT = `あなたはIONQ（イオンキュー／米国のイオントラップ型量子コンピュータ企業、ティッカー $IONQ）に特化した日本語の投資情報アナリストです。
渡されたニュース候補と、取得できた記事本文を材料に、X向けの日本語レポートを書いてください。

重要：
- 記事本文が取得できた場合は、必ず本文の数字・相手先・日付・発言を優先して拾う。
- 本文に無い数字、金額、相手先、日付、発言は捏造しない。
- 記事本文が取得できない場合は、タイトル・出典・種別から分かる範囲だけで書き、本文確認が必要だと明記する。
- 報道は二次情報、SEC/公式IRは一次情報として重要度を上げる。
- 出力はレポート本文のみ。前置きや説明は不要。

出力フォーマット（この見出し順。*や#などの装飾記号は使わずプレーンテキスト）
【分類ラベル】
（記事の要点を表す見出し1行）
ひとことで：（要約を1行。金額・%・社名・機関名があれば必ず含める）

要点：
（何が起きたかを2〜3文。金額・%・社名・機関名は必ず拾う）

押さえる数字：
・（金額はドルと日本円換算を併記。値動き、量子ビット数、関係機関など。該当が無ければこの節ごと省略）

ニュース内容：
（記事が何の話かを具体的に。各社の方式＝イオントラップ/超伝導/アニーリング等や論点に踏み込む。ただし本文から言えない内容は断定しない）

読み解き：
（投資家が見るべき点。IonQ固有の観点で、下の知識を使って具体的に）

（競合・他社比較の記事のときだけ）IonQの勝ち負け：
▼IonQ vs 〇〇（$XXX）
・IonQが勝っている点：…
・IonQが負けている点：…

評価：
・凄さ：★★★☆☆（★5段階。説明文は付けない）
・株価影響：★★★☆☆
・関連銘柄： $IONQ / …（記事に出る銘柄。RGTI/QBTS等の記号も拾う）

結論：
（投資家への一言）

出典：出典名
（記事URL）

IonQの基礎知識（読み解き・比較の根拠に使う）
- IonQはイオントラップ方式。強み＝高いゲート忠実度・全結合(all-to-all)・AWS/Azure/Google Cloudの3大クラウド提供。弱み＝ゲート速度が超伝導より遅い・量子ビット数の拡張ペース・赤字先行で高バリュエーション・大手より研究開発費が小さい。
- 性能はAQ(アルゴリズム量子ビット＝実効的に使える数)で見る。物理量子ビット数より忠実度×接続性×エラー率。
- 決算で見るべきは ①受注残(backlog)/予約(bookings) ②手元現金 ③純損失の縮小。赤字でも受注と現金が積み上がれば前進。
- 契約はPoC(実証)か複数年本契約かで価値が段違い。政府・防衛・大手＋金額/期間明示なら強い。
- 競合：RGTI(Rigetti,超伝導)／QBTS(D-Wave,アニーリング・実売上あり)／QUBT(Quantum Computing Inc,光・小型)／IBM(超伝導最大手・Qiskit)／GOOGL(超伝導・誤り訂正Willow)／MSFT(Azure＋トポロジカル)／AMZN(Braket＋自社ハード)／HON(Quantinuum,同じイオントラップの直接競合)／NVDA(GPU/CUDA-Q,補完)。

文章ルール：
- 日本語。
- 冗長にしない。
- Google Newsや報道記事の場合は、一次情報・数字・発表主体の確認が必要な点も必要に応じて明記する。`;

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  try {
    if (event.httpMethod === "GET") {
      const query = event.queryStringParameters || parseQuery(event.rawQuery || "");
      if (query.testFetch === "1") {
        const article = await fetchArticle(query.url || "");
        return cors(200, {
          ok: article.ok,
          result: "article_fetch_test",
          article: articleSummary(article, query.url || "", true)
        });
      }
      return cors(200, { ok: false, error: "use_post_or_testFetch" });
    }

    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) return cors(200, { ok: false, error: "no_api_key" });

    const item = parseBody(event.body);
    if (!item.title) return cors(200, { ok: false, error: "no_title" });

    const article = await fetchArticle(item.url);
    if (!article.ok) {
      return cors(200, {
        ok: false,
        error: "article_fetch_failed",
        article: {
          ok: false,
          error: article.error || "unknown",
          method: article.method || "",
          chars: article.text ? article.text.length : 0,
          finalUrl: article.finalUrl || item.url || ""
        }
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
        temperature: 0.25,
        max_tokens: 3200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserText(item, article) }
        ]
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return cors(200, { ok: false, error: `openai_${response.status}`, detail });
    }

    const data = await response.json();
    const draft = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!draft) return cors(200, { ok: false, error: "empty" });

    return cors(200, {
      ok: true,
      draft,
      article: articleSummary(article, item.url || "", false)
    });
  } catch (error) {
    return cors(200, { ok: false, error: error.message });
  }
};

async function fetchArticle(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "no_url", text: "" };
  }

  const attempts = [
    { method: "direct", url },
    ...readerUrls(url).map((readerUrl) => ({ method: "reader", url: readerUrl }))
  ];

  let lastError = "unknown";
  for (const attempt of attempts) {
    const result = await fetchArticleAttempt(attempt.url, attempt.method);
    if (result.ok) return result;
    lastError = `${attempt.method}:${result.error || "failed"}`;
  }

  return { ok: false, error: lastError, text: "" };
}

async function fetchArticleAttempt(url, method) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), method === "reader" ? 16000 : 9000);
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; IonQWatchdesk/1.0; +https://ionqrnews.netlify.app/)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `fetch_${response.status}`, method, finalUrl: response.url, text: "" };
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();
    const text = method === "reader"
      ? cleanReaderText(raw)
      : contentType.includes("html") || /<html|<article|<body/i.test(raw)
        ? extractReadableText(raw)
        : cleanText(raw);

    if (!text || text.length < 300) {
      return { ok: false, error: "article_text_too_short", method, finalUrl: response.url, text: text.slice(0, MAX_ARTICLE_CHARS) };
    }

    return {
      ok: true,
      method,
      finalUrl: response.url,
      text: text.slice(0, MAX_ARTICLE_CHARS)
    };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "fetch_timeout" : error.message, method, text: "" };
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
    `https://r.jina.ai/http://http://${noScheme}`,
    `https://r.jina.ai/http://https://${noScheme}`
  ];
}

function extractReadableText(html) {
  const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => decodeHtml(stripTags(match[1])))
    .join("\n");

  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => decodeHtml(match[1]))
    .join("\n");

  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
  const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const base = articleMatch?.[0] || mainMatch?.[0] || bodyMatch?.[0] || html;

  const bodyText = base
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(p|br|li|h1|h2|h3|h4|div|section|tr)[^>]*>/gi, "\n")
    .replace(/<\/(p|li|h1|h2|h3|h4|div|section|tr)>/gi, "\n");

  return cleanText([meta, jsonLd, stripTags(bodyText)].filter(Boolean).join("\n"));
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
    .replace(/&#39;/g, "'");
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanReaderText(value) {
  return cleanText(value)
    .replace(/^Title:\s*/gim, "")
    .replace(/^URL Source:\s*.*$/gim, "")
    .replace(/^Markdown Content:\s*/gim, "")
    .trim();
}

function buildUserText(item, article) {
  const lines = [
    "次のニュース候補について、取得できた記事本文を優先して投稿レポートを書いてください。",
    "本文に無い数字・相手先・発言は捏造しないでください。",
    "",
    `種別: ${typeLabel(item.type)}`,
    item.kind ? `分類ヒント: ${item.kind}` : "",
    `出典: ${item.source || "不明"}`,
    item.form ? `SECフォーム: ${item.form}` : "",
    `タイトル: ${item.title || ""}`,
    item.description ? `補足: ${item.description}` : "",
    `公開時刻(JST): ${formatJst(item.publishedAt) || "不明"}`,
    `記事URL: ${item.url || ""}`,
    article.finalUrl && article.finalUrl !== item.url ? `取得後URL: ${article.finalUrl}` : "",
    "",
    article.ok ? "記事本文（取得済み）:" : `記事本文（取得失敗: ${article.error || "unknown"}）:`,
    article.text
  ];
  return lines.filter(Boolean).join("\n");
}

function typeLabel(type) {
  return {
    IR: "IonQ公式IR",
    SEC: "IonQのSEC開示（一次情報）",
    NEWS: "IonQ関連の市場ニュース（報道）",
    QNEWS: "量子業界ニュース（IonQ単体ではない）",
    CIRS: "競合・周辺企業の材料",
    X: "X投稿"
  }[type] || "IonQ関連情報";
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

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    return {};
  }
}

function parseQuery(raw) {
  return String(raw || "")
    .split("&")
    .filter(Boolean)
    .reduce((params, part) => {
      const [key, ...rest] = part.split("=");
      params[decodeURIComponent(key || "")] = decodeURIComponent(rest.join("=") || "");
      return params;
    }, {});
}

function articleSummary(article, fallbackUrl, includeSample) {
  return {
    ok: !!article.ok,
    error: article.error || "",
    method: article.method || "",
    chars: article.text ? article.text.length : 0,
    finalUrl: article.finalUrl || fallbackUrl || "",
    sample: includeSample ? String(article.text || "").slice(0, 900) : undefined
  };
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
