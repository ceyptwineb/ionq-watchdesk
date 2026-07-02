// 「投稿済み」チェックの状態を端末間で共有するための保存API。
// Netlify Blobs に保存し、PC・スマホどちらから見ても同じ状態になるようにする。
//
// 格納方式(2026-07-02変更):
// - 旧形式: posted-state キーに {ids:[...]} を丸ごと保存(読み→書きの競合で
//   直前のチェックが消え「記事が復活する」原因になっていた)。読み込み時のみ使う。
// - 新形式: 1チェック = 1キー。
//     posted/1/<id> … チェック済み
//     posted/0/<id> … 明示的にチェックを外した(旧形式に残るIDを打ち消す墓標)
//   トグルは自分のキーだけを書くので、他端末のチェックを巻き込まない。
const STORE_NAME = "ionq-watchdesk";
const POSTED_KEY = "posted-state";
const CHECKED_PREFIX = "posted/1/";
const UNCHECKED_PREFIX = "posted/0/";

exports.handler = async (event = {}) => {
  if (event.httpMethod === "OPTIONS") return cors(204, "");

  try {
    const blobs = await import("@netlify/blobs");
    // Lambda形式の関数ではBlobsコンテキストをイベントから接続する（必須）
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
      return cors(200, { ok: true, ids: await readMergedIds(store) });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event.body);

      // 全クリア: 個別キーも旧形式キーも全部消す
      if (body.clear === true) {
        const keys = [
          ...(await listKeys(store, CHECKED_PREFIX)).map((id) => CHECKED_PREFIX + id),
          ...(await listKeys(store, UNCHECKED_PREFIX)).map((id) => UNCHECKED_PREFIX + id)
        ];
        await Promise.all(keys.map((key) => store.delete(key).catch(() => {})));
        await store.set(POSTED_KEY, JSON.stringify({ ids: [] }));
        return cors(200, { ok: true, ids: [] });
      }

      // 一括追加（端末ローカルにしか無かった分をサーバーへ吸い上げる用途）
      if (Array.isArray(body.addIds)) {
        await Promise.all(body.addIds.map((id) => setPostedKey(store, String(id), true)));
      }

      // トグル: {id, posted} または {ids:[...], posted}
      const ids = Array.isArray(body.ids)
        ? body.ids
        : (body.id != null ? [body.id] : []);
      if (ids.length) {
        await Promise.all(ids.map((id) => setPostedKey(store, String(id), Boolean(body.posted))));
      }

      return cors(200, { ok: true });
    }

    return cors(405, { ok: false, error: "method_not_allowed" });
  } catch (error) {
    return cors(500, { ok: false, error: error.message });
  }
};

async function setPostedKey(store, id, posted) {
  if (!id) return;
  if (posted) {
    await store.set(CHECKED_PREFIX + id, "1");
    await store.delete(UNCHECKED_PREFIX + id).catch(() => {});
  } else {
    await store.set(UNCHECKED_PREFIX + id, "1");
    await store.delete(CHECKED_PREFIX + id).catch(() => {});
  }
}

async function readMergedIds(store) {
  const ids = new Set(await readLegacyIds(store));
  const checked = await listKeys(store, CHECKED_PREFIX);
  const unchecked = await listKeys(store, UNCHECKED_PREFIX);
  unchecked.forEach((id) => ids.delete(id));
  checked.forEach((id) => ids.add(id));
  return [...ids];
}

async function readLegacyIds(store) {
  try {
    const value = await store.get(POSTED_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return (Array.isArray(parsed.ids) ? parsed.ids : []).map(String);
  } catch (error) {
    console.warn("posted: could not read legacy state.", error.message);
    return [];
  }
}

async function listKeys(store, prefix) {
  try {
    const result = await store.list({ prefix });
    return (result && result.blobs ? result.blobs : []).map((blob) => String(blob.key).slice(prefix.length));
  } catch (error) {
    console.warn(`posted: could not list ${prefix}.`, error.message);
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
