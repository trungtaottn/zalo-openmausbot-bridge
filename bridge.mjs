// Zalo group ↔ OpenMausBot bot bridge.
// - Records every message in the configured group (text + downloaded files).
// - Only the owner's @mention of the Zalo account triggers a hand-off to the
//   OpenMausBot bot via its Bot API, carrying all messages buffered since the
//   last hand-off.
// - The bot's reply is posted to the group exactly once by this process.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loginZalo, normalizeGroupMessage, sendGroupText, ThreadType } from "./zalo.mjs";

const CONF_DIR = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
const STATE_DIR = process.env.ZALO_BRIDGE_STATE_DIR || path.join(os.homedir(), ".local/state/zalo-openmausbot-bridge");
const expandHome = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const cfg = {
  ownerName: "Anh",
  ownerLabel: "chủ nhóm",
  botName: "Bot",
  project: "",
  inboxDir: "~/zalo-inbox",
  maxBuffered: 200,
  extraRules: [],
  ombEventsDir: "~/.openmausbot/events",
  followUpHours: 72,
  ...JSON.parse(fs.readFileSync(path.join(CONF_DIR, "config.json"), "utf8")),
};
cfg.inboxDir = expandHome(cfg.inboxDir);
cfg.ombEventsDir = expandHome(cfg.ombEventsDir);
for (const k of ["groupId", "ownerUid", "botId", "botApiBase"]) {
  if (!cfg[k]) throw new Error(`config.json thiếu "${k}"`);
}
const botKey = () => fs.readFileSync(path.join(CONF_DIR, "bot_api_key"), "utf8").trim();
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const STATE_PATH = path.join(STATE_DIR, "state.json");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { buffer: [] }; }
};
let state = loadState();
state.watch ||= [];
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1), { mode: 0o600 });

const ZALO_MAX = 1800;
function chunks(text) {
  const out = [];
  let rest = text.trim();
  while (rest.length > ZALO_MAX) {
    let cut = rest.lastIndexOf("\n", ZALO_MAX);
    if (cut < ZALO_MAX / 2) cut = ZALO_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function stripMarkdown(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/`{1,3}/g, "");
}

function formatRecord(r) {
  const t = new Date(r.ts).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const lines = [`[${t}] ${r.senderName}${r.senderId === cfg.ownerUid ? ` (${cfg.ownerLabel})` : ""}: ${r.text || ""}`.trim()];
  if (r.quote) {
    lines.push(`  (trả lời tin của ${r.quote.from}: "${r.quote.text.slice(0, 200)}")`);
    if (r.quote.error) lines.push(`  [${r.quote.error}]`);
  }
  for (const f of r.files) {
    const suffix = f.fromQuote
      ? ` (từ tin được trả lời của ${f.fromQuote}${f.name ? `: ${f.name}` : ""})`
      : f.name ? ` (${f.name})` : "";
    lines.push(`  [${f.kind}] ${f.path}${suffix}`);
  }
  return lines.join("\n");
}

function buildPrompt(trigger, buffered) {
  const history = buffered.length ? buffered.map(formatRecord).join("\n") : "(không có tin nào trước lệnh này)";
  const owner = cfg.ownerLabel;
  return [
    `Tin từ nhóm Zalo${cfg.project ? ` dự án ${cfg.project}` : ""}, chuyển qua cầu Zalo.`,
    `Trong nhóm có thể có khách hàng. ${owner[0].toUpperCase() + owner.slice(1)} vừa tag và ra lệnh, kèm các tin trong nhóm kể từ lần chuyển trước.`,
    `File và ảnh đã được tải sẵn về máy chủ theo đường dẫn ghi bên dưới, em đọc trực tiếp được.`,
    ``,
    `LỆNH CỦA ${owner.toUpperCase()}:`,
    formatRecord(trigger),
    ``,
    `CÁC TIN TRONG NHÓM TỪ LẦN TRƯỚC:`,
    history,
    ``,
    `QUY ƯỚC TRẢ LỜI: toàn bộ câu trả lời của em sẽ được gửi NGUYÊN VĂN vào nhóm Zalo, mọi thành viên đọc được.`,
    `- Viết tiếng Việt, ngắn (1-5 câu), lịch sự, không markdown, không link nội bộ, không chi tiết kỹ thuật nội bộ.`,
    `- Việc nội bộ (giao việc cho team, issue, PR, tiến độ chi tiết) em xử lý và báo ${owner} trong OpenMausBot như bình thường, không đưa vào câu trả lời này.`,
    `- Cần ${owner} quyết định thì viết "@${cfg.ownerName}" kèm câu hỏi ngắn; hệ thống sẽ tag thật.`,
    `- Nếu không cần nói gì vào nhóm, trả lời đúng một từ: NO_REPLY`,
    ...cfg.extraRules.map((r) => `- ${r}`),
  ].join("\n");
}

function extractReply(body) {
  if (!body || typeof body !== "object") return null;
  for (const k of ["reply", "text", "message", "content", "output", "answer"]) {
    if (typeof body[k] === "string" && body[k].trim()) return body[k];
  }
  if (body.reply && typeof body.reply === "object") return extractReply(body.reply);
  return null;
}

async function botApi(method, query, payload) {
  const url = `${cfg.botApiBase}/${cfg.botId}/messages${query ? `?${query}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botKey()}`, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { status: res.status, body };
}

// Sends one prompt to the bot in a fresh API thread and resolves with her final
// reply text (or null). Long work answers 202 "working"; an approval request
// answers 202 "needs_approval" and waits for the owner in the app.
async function askBot(prompt, { onWorking, onApproval }) {
  let { status, body } = await botApi("POST", "", { message: prompt, wait: 50 });
  const thread = body?.thread;
  log(`bot-api POST status=${status} thread=${thread ? thread.slice(0, 8) : "-"} state=${body?.status || ""}`);
  let toldWorking = false;
  let toldApproval = false;
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  for (;;) {
    if (status === 200) return { reply: extractReply(body), thread };
    if (status !== 202 || !thread) throw new Error(`Bot API ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    if (body.status === "needs_approval" && !toldApproval) { toldApproval = true; await onApproval(); }
    else if (!toldWorking) { toldWorking = true; await onWorking(); }
    if (Date.now() > deadline) throw new Error(`${cfg.botName} chưa trả lời sau 6 giờ`);
    await new Promise((r) => setTimeout(r, 30_000));
    ({ status, body } = await botApi("GET", `thread=${encodeURIComponent(thread)}`));
    if (status === 409) status = 202, body = { ...body, thread, status: "working" };
  }
}

// Follow-ups: a bot often answers once ("handed to the team"), then writes a
// second answer in the same thread when the work is done. The Bot API GET only
// returns the first answer, so completed answers are read from OpenMausBot's
// own event log for that thread (same machine) and posted once each.
function completedAnswers(thread) {
  const file = path.join(cfg.ombEventsDir, `${thread}.ndjson`);
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("assistant_text")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "item.completed" && e.itemType === "assistant_text" && typeof e.text === "string") {
        out.push({ id: e.itemId, text: e.text });
      }
    } catch { /* partial line while being written */ }
  }
  return out;
}

function watchThread(thread) {
  if (!thread || state.watch.some((w) => w.thread === thread)) return;
  const seen = completedAnswers(thread).map((a) => a.id);
  state.watch.push({ thread, seen, until: Date.now() + cfg.followUpHours * 3600_000 });
  saveState();
  log(`watching thread=${thread.slice(0, 8)} seen=${seen.length}`);
}

function startFollowUps(send) {
  setInterval(async () => {
    const now = Date.now();
    const before = state.watch.length;
    state.watch = state.watch.filter((w) => w.until > now);
    let changed = state.watch.length !== before;
    for (const w of state.watch) {
      for (const a of completedAnswers(w.thread)) {
        if (w.seen.includes(a.id)) continue;
        w.seen.push(a.id);
        changed = true;
        saveState();
        const text = stripMarkdown(a.text).trim();
        if (!text || text === "NO_REPLY") continue;
        log(`follow-up thread=${w.thread.slice(0, 8)} item=${a.id.slice(-8)}`);
        for (const part of chunks(text)) await send(part).catch((err) => log(`follow-up send failed: ${err.message}`));
      }
    }
    if (changed) saveState();
  }, 30_000);
}

async function main() {
  const api = await loginZalo(path.join(CONF_DIR, "zalo_credentials.json"));
  const selfId = String(api.getOwnId());
  log(`logged in as ${selfId}, watching group ${cfg.groupId}`);
  const send = async (t) => {
    const r = await sendGroupText(api, cfg.groupId, t, cfg.ownerUid, cfg.ownerName);
    log(`sent group msgId=${r?.message?.msgId || "none"} len=${t.length}`);
    return r;
  };
  startFollowUps(send);

  api.listener.on("message", async (msg) => {
    if (msg.type !== ThreadType.Group || msg.isSelf || msg.threadId !== cfg.groupId) return;
    const rec = await normalizeGroupMessage(msg, cfg.inboxDir, log, api);
    delete rec.raw;
    const isTrigger = rec.senderId === cfg.ownerUid && rec.mentions.includes(selfId);
    if (!isTrigger) {
      state.buffer.push(rec);
      if (state.buffer.length > cfg.maxBuffered) state.buffer.splice(0, state.buffer.length - cfg.maxBuffered);
      saveState();
      log(`buffered msg=${rec.msgId} from=${rec.senderId === cfg.ownerUid ? "owner" : "member"} files=${rec.files.length} total=${state.buffer.length}`);
      return;
    }
    // Take the buffer synchronously so two quick commands never share messages.
    const buffered = state.buffer.splice(0);
    saveState();
    log(`trigger msg=${rec.msgId} buffered=${buffered.length}`);
    try {
      const { reply, thread } = await askBot(buildPrompt(rec, buffered), {
        onWorking: () => send(`Đã nhận, ${cfg.botName} đang xử lý, có kết quả em báo ngay.`),
        onApproval: () => send(`@${cfg.ownerName} ${cfg.botName} cần duyệt một bước trong OpenMausBot.`),
      });
      const text = reply ? stripMarkdown(reply).trim() : "";
      if (!text || text === "NO_REPLY") log("bot: NO_REPLY");
      else {
        const parts = chunks(text);
        for (const part of parts) await send(part);
        log(`posted reply parts=${parts.length}`);
      }
      watchThread(thread);
    } catch (err) {
      state.buffer.unshift(...buffered);
      saveState();
      log(`hand-off failed: ${err.message}`);
      await send(`@${cfg.ownerName} chưa chuyển được cho ${cfg.botName} (${err.message.slice(0, 120)}). Tag lại sau ít phút nhé.`).catch(() => {});
    }
  });

  api.listener.on("connected", () => log("listener connected"));
  api.listener.on("disconnected", (code, reason) => log(`listener disconnected code=${code} ${reason || ""}`));
  api.listener.on("closed", (code, reason) => { log(`listener closed code=${code} ${reason || ""}`); process.exit(1); });
  api.listener.start({ retryOnClose: true });
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
