// 「投稿済み」チェックの状態を端末間で共有するための保存API。
//
// 【設計変更の理由】
// 旧方式は「全IDの配列を1つのBlobに読み書き」だったため、
// 同時に飛んだ操作が古いリストを書き戻して削除やクリアが復活する
// 競合バグがあった(チェック連打・クリア直後の操作で必発)。
// 現方式はIDごとに独立したキー(posted/<id>)で保存する。
// 追加=setキー、解除=deleteキー、一覧=prefix list。
// 操作同士が別キーなので原理的に衝突しない。
const STORE_NAME = "ionq-watchdesk";
const PREFIX = "posted/";
const LEGACY_KEY = "posted-state"; // 旧方式の残骸。初回GETで移行して消す。

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  try {
    const blobs = await import("@netlify/blobs");
    if (typeof blobs.connectLambda === "function") blobs.connectLambda(event);
    const opts = { name: STORE_NAME };
    const siteID = process.env.BLOBS_SITE_ID || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
    if (siteID && token) {
      opts.siteID = siteID;
      opts.token = token;
    }
    const store = blobs.getStore(opts);

    if (event.httpMethod === "GET" || !event.httpMethod) {
      await migrateLegacy(store);
      const ids = await listIds(store);
      return cors(200, { ok: true, ids });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event.body);

      // 全クリア: 全キーを削除
      if (body.clear === true) {
        const ids = await listIds(store);
        await runLimited(ids, 10, (id) => store.delete(PREFIX + encodeURIComponent(id)));
        try { await store.delete(LEGACY_KEY); } catch (e) { /* 無ければ無視 */ }
        return cors(200, { ok: true, ids: [] });
      }

      // 一括追加(ローカル→サーバー吸い上げ用)
      if (Array.isArray(body.addIds)) {
        await runLimited(body.addIds.map(String), 10, (id) => store.set(PREFIX + encodeURIComponent(id), "1"));
      }

      // 単一トグル: キーの有無だけを操作する。他のIDには一切触れない。
      if (body.id != null) {
        const key = PREFIX + encodeURIComponent(String(body.id));
        if (body.posted) await store.set(key, "1");
        else await store.delete(key);
      }

      return cors(200, { ok: true });
    }

    return cors(405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    return cors(500, { ok: false, error: error.message });
  }
};

async function listIds(store) {
  const result = await store.list({ prefix: PREFIX });
  const blobsList = (result && result.blobs) || [];
  return blobsList.map((entry) => decodeURIComponent(String(entry.key).slice(PREFIX.length)));
}

// 旧方式(1つのBlobに配列)からの移行。旧データがあれば個別キーに展開して消す。
async function migrateLegacy(store) {
  try {
    const value = await store.get(LEGACY_KEY);
    if (!value) return;
    const parsed = JSON.parse(value);
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    await runLimited(ids.map(String), 10, (id) => store.set(PREFIX + encodeURIComponent(id), "1"));
    await store.delete(LEGACY_KEY);
  } catch (error) {
    console.warn("posted: legacy migration skipped.", error.message);
  }
}

async function runLimited(list, limit, worker) {
  const queue = [...list];
  const runners = Array.from({ length: Math.min(limit, Math.max(queue.length, 1)) }, async () => {
    while (queue.length) {
      const entry = queue.shift();
      if (entry === undefined) return;
      try { await worker(entry); } catch (e) { console.warn("posted op failed:", e.message); }
    }
  });
  await Promise.all(runners);
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
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}
