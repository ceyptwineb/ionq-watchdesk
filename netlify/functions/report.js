// 選択したニュース1件について、Claude(API)に日本語レポートを書かせる関数。
// 既存コードに合わせて素のfetchでAnthropic Messages APIを呼ぶ（依存追加なし）。
// APIキー未設定や失敗時は ok:false を返し、ページ側がテンプレ生成にフォールバックする。
const MODEL = (process.env.REPORT_MODEL || "claude-opus-4-8").trim();

const SYSTEM_PROMPT = `あなたはIONQ（イオンキュー／米国のイオントラップ型量子コンピュータ企業、ティッカー $IONQ）に特化した日本語の投資情報アナリストです。X(旧Twitter)向けに、与えられたニュース1件について日本語の解説投稿を書きます。

# 出力フォーマット（この見出し順。装飾記号(*や#)は使わずプレーンテキスト）
【分類ラベル】
（記事の要点を表す見出し1行）
ひとことで：（英語見出しの日本語要約を1行。金額・%・社名・機関名があれば必ず含める）
（YYYY/MM/DD HH:MM JST時点・出典名）

要点：
（何が起きたかを2〜3文。タイトルに金額・%・社名・機関名があれば必ず拾う）

押さえる数字：
・（金額はドルと日本円換算を併記。例 $54.5M（約5,450万ドル）。値動きは「株価上昇 12%」、量子ビット数、関係機関 等。該当が無ければこの節ごと省略）

ニュース内容：
（記事が何の話かを具体的に。各社の方式（イオントラップ/超伝導/アニーリング等）や論点に踏み込む。一般論で逃げない）

読み解き：
（投資家がこのニュースで実際に見るべき点。IonQ固有の観点で、下記の知識を使って具体的に）

（※競合・他社比較の記事のときだけ）IonQの勝ち負け：
▼IonQ vs 〇〇（$XXX）
・IonQが勝っている点：…
・IonQが負けている点：…

評価：
・凄さ：★★★☆☆（★5段階。説明文は付けない）
・株価影響：★★★☆☆
・関連銘柄： $IONQ / …（記事に出てくる銘柄。RGTI/QBTS等のティッカー記号も拾う）

結論：
（投資家への一言）

出典：出典名
（記事URL）

# IonQの基礎知識（読み解き・比較の根拠に使う）
- IonQはイオントラップ方式。強み＝高いゲート忠実度・全結合(all-to-all)・AWS/Azure/Google Cloudの3大クラウド提供。弱み＝ゲート速度が超伝導より遅い・量子ビット数の拡張ペース・赤字先行で高バリュエーション・大手より研究開発費が小さい。
- 性能はAQ(アルゴリズム量子ビット＝実効的に使える数)で見る。物理量子ビット数より忠実度×接続性×エラー率。
- 決算で見るべきは ①受注残(backlog)/予約(bookings) ②手元現金（増資なしで何年戦えるか）③純損失の縮小。赤字でも受注と現金が積み上がれば前進。
- 契約はPoC(実証)か複数年本契約かで価値が段違い。政府・防衛・大手＋金額/期間明示なら強い。
- 競合：RGTI(Rigetti,超伝導・小型)／QBTS(D-Wave,アニーリング・最適化特化で実売上あり)／QUBT(Quantum Computing Inc,光・小型)／IBM(超伝導最大手・量子ビット数とQiskit)／GOOGL(超伝導・誤り訂正研究Willow)／MSFT(Azure＋トポロジカル)／AMZN(Braket＋自社ハード)／HON(Quantinuum,同じイオントラップ方式の直接競合・資金力)／NVDA(GPU/CUDA-Q,競合でなく補完)。

# ルール
- 出力は投稿本文のみ。前置き・思考・「以下が投稿です」等は一切書かない。
- 入力はタイトル/出典/種別のみ。本文は読めないので、タイトルに無い具体的数字を捏造しない。無ければ「本文で確認」と書く。
- 報道は二次情報、SEC/公式IRは一次情報として重要度を上げる。
- 全体を日本語で。X長文想定だが冗長にしない（目安1500〜2500字）。`;

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) return cors(200, { ok: false, error: "no_api_key" });

    const item = parseBody(event.body);
    if (!item.title) return cors(200, { ok: false, error: "no_title" });

    const userText = buildUserText(item);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }]
      })
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return cors(200, { ok: false, error: `anthropic_${response.status}`, detail });
    }

    const data = await response.json();
    if (data.stop_reason === "refusal") {
      return cors(200, { ok: false, error: "refusal" });
    }

    const draft = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!draft) return cors(200, { ok: false, error: "empty" });

    return cors(200, { ok: true, draft, model: data.model || MODEL });
  } catch (error) {
    return cors(200, { ok: false, error: error.message });
  }
};

function buildUserText(item) {
  const lines = [
    "次のニュースについて投稿を書いてください。",
    "",
    `種別: ${typeLabel(item.type)}`,
    item.kind ? `分類ヒント: ${item.kind}` : "",
    `出典: ${item.source || "不明"}`,
    item.form ? `SECフォーム: ${item.form}` : "",
    `タイトル: ${item.title || ""}`,
    item.description ? `補足: ${item.description}` : "",
    `公開時刻(JST): ${formatJst(item.publishedAt) || "不明"}`,
    `記事URL: ${item.url || ""}`
  ];
  return lines.filter(Boolean).join("\n");
}

function typeLabel(type) {
  return {
    IR: "IonQ公式IR",
    SEC: "IonQのSEC開示（一次情報）",
    NEWS: "IonQ関連の市場ニュース（報道）",
    QNEWS: "量子業界ニュース（IonQ単体ではない）",
    CIRS: "競合・周辺企業の材料"
  }[type] || "IonQ関連情報";
}

function formatJst(value) {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date(ms));
}

function parseBody(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch (error) {
    return {};
  }
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
