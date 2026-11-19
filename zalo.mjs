// Zalo side of the bridge: login with saved cookies, normalize incoming group
// messages, download attachments, and send text (with optional @owner mention).
import { Zalo, ThreadType } from "zca-js";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const HISTORY_TIMEOUT_MS = 5000;

export async function loginZalo(credentialsPath) {
  const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  const zalo = new Zalo({ selfListen: false, checkUpdate: false, logging: false });
  // Some exported sessions (e.g. from goclaw) store cookies with empty domain/path; scope
  // them to zalo.me so the cookie jar sends them to chat.zalo.me and wpa.
  const cookie = (Array.isArray(creds.cookie) ? creds.cookie : creds.cookie.cookies).map((c) => ({
    ...c,
    domain: c.domain || "zalo.me",
    path: c.path || "/",
  }));
  const api = await zalo.login({
    imei: creds.imei,
    cookie,
    userAgent: creds.userAgent,
    language: creds.language,
  });
  return api;
}

function safeName(name) {
  return String(name || "file").normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(0, 80) || "file";
}

function parseJsonObject(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? p : null;
    } catch { return null; }
  }
  return null;
}

function normalizeImageUrl(url) {
  if (typeof url !== "string") return url;
  // Zalo mobile quotes sometimes rewrite /jpg/.../*.jpg to /jxl/.../*.jxl
  if (/\/jxl\/.+\.jxl(\?|$)/i.test(url)) {
    return url.replace("/jxl/", "/jpg/").replace(/\.jxl(\?|$)/i, ".jpg$1");
  }
  return url;
}

function pickUrl(msgType, content) {
  const c = parseJsonObject(content);
  if (!c) return null;
  const p = parseJsonObject(c.params);
  const isImg = msgType === "chat.photo" || Number(msgType) === 32 || Boolean(p?.hd || c.hdUrl);
  const raw = (isImg && (p?.hd || c.hdUrl)) || c.href || c.normalUrl || c.oriUrl || c.hdUrl || null;
  return isImg ? normalizeImageUrl(raw) : raw;
}

function kindOf(msgType, content) {
  const n = Number(msgType);
  if (msgType === "chat.photo" || n === 32) return "image";
  if (msgType === "share.file" || n === 46) return "file";
  if ((typeof msgType === "string" && msgType.startsWith("chat.video")) || n === 44) return "video";
  if (msgType === "chat.voice" || n === 31) return "voice";
  if (msgType === "chat.sticker" || n === 36) return "sticker";
  const c = parseJsonObject(content);
  const p = parseJsonObject(c?.params);
  if (p?.hd || c?.hdUrl) return "image";
  if (p?.fileExt || p?.fileSize !== undefined) return "file";
  return "other";
}

async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large (${buf.length} bytes)`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destPath, buf, { mode: 0o600 });
  return destPath;
}

async function lookupQuotedMessage(api, groupId, quote, log) {
  if (!api || typeof api.getCloudMessage !== "function" || !groupId) return null;
  const targetGlobal = quote.globalMsgId != null ? String(quote.globalMsgId) : "";
  const targetCli = quote.cliMsgId != null ? String(quote.cliMsgId) : "";
  if (!targetGlobal && !targetCli) return null;
  let timer = null;
  try {
    const res = await Promise.race([
      api.getCloudMessage(groupId),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), HISTORY_TIMEOUT_MS);
      }),
    ]);
    const list = (res?.groupMsgs || []).map((m) => m.data || m);
    return list.find((m) =>
      (targetGlobal && String(m.msgId) === targetGlobal) ||
      (targetCli && String(m.cliMsgId) === targetCli)
    ) || null;
  } catch (err) {
    log?.(`quote history lookup failed msg=${targetGlobal || targetCli}: ${err.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Converts a zca-js GroupMessage into a plain record. Downloads attachments
// (including quoted attachments) into inboxDir/<groupId>/<yyyy-mm-dd>/ and lists local paths.
export async function normalizeGroupMessage(msg, inboxDir, log, api = null) {
  const d = msg.data;
  const ts = new Date(Number(d.ts) || Date.now());
  const day = ts.toISOString().slice(0, 10);
  const rec = {
    msgId: d.msgId,
    ts: ts.toISOString(),
    senderId: String(d.uidFrom),
    senderName: d.dName || String(d.uidFrom),
    text: "",
    files: [],
    quote: null,
    mentions: (d.mentions || []).map((m) => String(m.uid)),
    raw: d,
  };

  if (d.quote) {
    const q = d.quote;
    const qFrom = q.fromD || String(q.ownerId || "");
    let qAttach = parseJsonObject(q.attach);
    let qMsgType = q.msgType || q.cliMsgType;
    let qUrl = pickUrl(qMsgType, qAttach);
    let qKind = kindOf(qMsgType, qAttach);
    const expectsMedia = Number(q.cliMsgType) === 32 || Number(q.cliMsgType) === 46 ||
      Number(q.cliMsgType) === 44 || Number(q.cliMsgType) === 31 ||
      qKind === "image" || qKind === "file" || qKind === "video" || qKind === "voice" || Boolean(qUrl);

    let lookedUp = null;
    if (!qUrl && api) {
      lookedUp = await lookupQuotedMessage(api, msg.threadId, q, log);
      if (lookedUp) {
        if (typeof lookedUp.content === "object" && lookedUp.content) {
          qAttach = lookedUp.content;
          qMsgType = lookedUp.msgType || qMsgType;
          qUrl = pickUrl(qMsgType, qAttach);
          qKind = kindOf(qMsgType, qAttach);
        }
      }
    }

    const qTitle = typeof qAttach?.title === "string" ? qAttach.title.trim() : "";
    const qDesc = typeof qAttach?.description === "string" ? qAttach.description.trim() : "";
    const lookedUpText = typeof lookedUp?.content === "string" ? lookedUp.content.trim() : "";
    const qText = (q.msg && String(q.msg).trim()) || [qTitle, qDesc].filter(Boolean).join(" — ") || lookedUpText || "";
    rec.quote = { from: qFrom, text: qText };

    if (qUrl && qKind !== "sticker") {
      const qId = String(q.globalMsgId || q.msgId || q.cliMsgId || d.msgId);
      const base = qKind === "file" ? safeName(qAttach?.title) : `${qKind}${qKind === "image" ? ".jpg" : ""}`;
      const dest = path.join(inboxDir, msg.threadId, day, `${qId}-${base}`);
      try {
        rec.files.push({
          kind: qKind,
          path: await download(qUrl, dest),
          name: qKind === "file" ? (qAttach?.title || "") : "",
          fromQuote: qFrom,
        });
      } catch (err) {
        log?.(`quote download failed msg=${d.msgId} qmsg=${qId} kind=${qKind}: ${err.message}`);
        rec.quote.error = `không lấy được ảnh tin được trả lời (${err.message})`;
      }
    } else if (expectsMedia && qKind !== "sticker") {
      log?.(`quote media missing url msg=${d.msgId} qmsg=${q.globalMsgId || q.cliMsgId || ""}`);
      rec.quote.error = "không lấy được ảnh tin được trả lời";
    }
  }

  if (typeof d.content === "string") {
    rec.text = d.content;
    return rec;
  }
  const kind = kindOf(d.msgType, d.content);
  const c = d.content || {};
  rec.text = [c.title, c.description].filter((s) => typeof s === "string" && s.trim()).join(" — ");
  if (kind === "sticker") {
    rec.text = rec.text || "[sticker]";
    return rec;
  }
  const url = pickUrl(d.msgType, c);
  if (!url) {
    rec.text = rec.text || `[${d.msgType}]`;
    return rec;
  }
  const base = kind === "file" ? safeName(c.title) : `${kind}${kind === "image" ? ".jpg" : ""}`;
  const dest = path.join(inboxDir, msg.threadId, day, `${d.msgId}-${base}`);
  try {
    rec.files.push({ kind, path: await download(url, dest), name: c.title || "" });
  } catch (err) {
    log?.(`download failed msg=${d.msgId} kind=${kind}: ${err.message}`);
    rec.text = `${rec.text} [${kind}: không tải được]`.trim();
  }
  return rec;
}

// Sends text to a group. Every "@<ownerName>" occurrence becomes a real mention of ownerUid.
export async function sendGroupText(api, groupId, text, ownerUid, ownerName) {
  const tag = `@${ownerName}`;
  const mentions = [];
  let i = text.indexOf(tag);
  while (i !== -1) {
    mentions.push({ pos: i, uid: ownerUid, len: tag.length });
    i = text.indexOf(tag, i + tag.length);
  }
  const content = mentions.length ? { msg: text, mentions } : { msg: text };
  return api.sendMessage(content, groupId, ThreadType.Group);
}

export { ThreadType };
