// 「投稿済み」チェックの状態を端末間で共有するための保存API。
// Netlify Blobs に保存し、PC・スマホどちらから見ても同じ状態になるようにする。
const STORE_NAME = "ionq-watchdesk";
const POSTED_KEY = "posted-state";
const MAX_IDS = 2000;

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const ids = new Set(await readIds(store));

    if (event.httpMethod === "GET" || !event.httpMethod) {
      return cors(200, { ok: true, ids: [...ids] });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event.body);

      // 一括追加（端末ローカルにしか無かった分をサーバーへ吸い上げる用途）
      if (Array.isArray(body.addIds)) {
        body.addIds.forEach((id) => ids.add(String(id)));
      }

      // 単一トグル（チェック=true、外す=false）
      if (body.id != null) {
        if (body.posted) ids.add(String(body.id));
        else ids.delete(String(body.id));
      }

      const arr = [...ids].slice(-MAX_IDS);
      await store.set(POSTED_KEY, JSON.stringify({ ids: arr }));
      return cors(200, { ok: true, ids: arr });
    }

    return cors(405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    return cors(500, { ok: false, error: error.message });
  }
};

async function readIds(store) {
  try {
    const value = await store.get(POSTED_KEY, { consistency: "strong" });
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch (error) {
    console.warn("posted: could not read state.", error.message);
    return [];
  }
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
