// Zalo group ↔ OpenMausBot bot bridge.
// - Records every message in the configured group (text + downloaded files).
// - Only the owner's @mention of the Zalo account triggers a hand-off to the
//   OpenMausBot bot via its Bot API, carrying all messages buffered since the
//   last hand-off.
// - The bot's reply is posted to the group exactly once by this process.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loginZalo, normalizeGroupMessage, sendGroupText, sendGroupFiles, quoteRefOf, ThreadType } from "./zalo.mjs";

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
  outboxDir: "~/zalo-outbox",
  followUpHours: 336,
  ...JSON.parse(fs.readFileSync(path.join(CONF_DIR, "config.json"), "utf8")),
};
cfg.inboxDir = expandHome(cfg.inboxDir);
cfg.ombEventsDir = expandHome(cfg.ombEventsDir);
cfg.outboxDir = expandHome(cfg.outboxDir);
fs.mkdirSync(cfg.outboxDir, { recursive: true, mode: 0o700 });
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

// While the group's thread is mid-turn the Bot API answers 409: retry every
// 20 s, and tag the owner once if it stays busy for 20 minutes (the longest
// observed coordinator turn was about 15 minutes).
const BUSY_RETRY_MS = 20_000;
const BUSY_ALERT_MS = 20 * 60_000;

// "#moi" / "#mới" / "#new" as the first word once the @mentions are cut out
// opens a new conversation. A bare "mới" is too common in Vietnamese to count.
const FRESH_TAG = /^#(?:moi|mới|new)(?=$|[\s:,.!])/iu;
const FRESH_TAG_ANYWHERE = /(^|\s)#(?:moi|mới|new)(?=$|[\s:,.!])[:,.!]?/iu;
function isFreshCommand(d) {
  let text = typeof d?.content === "string" ? d.content : "";
  const mentions = d?.mentions || [];
  const spans = mentions.filter((m) => Number.isInteger(m.pos) && m.len > 0).sort((a, b) => b.pos - a.pos);
  // Without mention positions the name can't be cut reliably; a hashtag is
  // deliberate enough to accept anywhere then.
  if (mentions.length && !spans.length) return FRESH_TAG_ANYWHERE.test(text.normalize("NFC"));
  for (const m of spans) text = text.slice(0, m.pos) + text.slice(m.pos + m.len);
  return FRESH_TAG.test(text.normalize("NFC").trim());
}

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

// Pulls "[[file: /abs/path]]" lines out of a reply. Only regular files under
// outboxDir or inboxDir (after resolving symlinks), up to 25 MB each and 10 per
// reply, are accepted, so the bot cannot post arbitrary files from the host.
const MAX_SEND_BYTES = 25 * 1024 * 1024;
function extractFiles(text) {
  const files = [];
  const rejected = [];
  const roots = [cfg.outboxDir, cfg.inboxDir].map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
  const body = text.replace(/^[ \t]*\[\[\s*file\s*:\s*(.+?)\s*\]\][ \t]*$/gim, (_, p) => {
    try {
      const real = fs.realpathSync(expandHome(p.trim()));
      const st = fs.statSync(real);
      const inside = roots.some((r) => real === r || real.startsWith(r + path.sep));
      if (!inside || !st.isFile() || st.size > MAX_SEND_BYTES || files.length >= 10) throw new Error("not allowed");
      files.push(real);
    } catch {
      rejected.push(p.trim());
    }
    return "";
  });
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), files, rejected };
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

// `items` are the owner's commands in arrival order, each with the group
// messages recorded before it. `fresh` means this opens a new conversation.
function buildPrompt(items, fresh) {
  const owner = cfg.ownerLabel;
  const Owner = owner[0].toUpperCase() + owner.slice(1);
  const sections = items.flatMap((it, i) => [
    ...(items.length > 1 ? [`=== LỆNH ${i + 1}/${items.length} ===`] : []),
    `CÁC TIN TRONG NHÓM TRƯỚC LỆNH NÀY:`,
    it.buffered.length ? it.buffered.map(formatRecord).join("\n") : "(không có tin nào)",
    ``,
    `LỆNH CỦA ${owner.toUpperCase()}:`,
    formatRecord(it.rec),
    ``,
  ]);
  const intro = fresh
    ? [
        `Tin từ nhóm Zalo${cfg.project ? ` dự án ${cfg.project}` : ""}, chuyển qua cầu Zalo. Đây là cuộc trò chuyện MỚI cho nhóm này: mọi lệnh sau của ${owner} trong nhóm sẽ tiếp tục ngay tại đây.`,
        `Trong nhóm có thể có khách hàng. ${Owner} vừa tag và ra lệnh, kèm các tin trong nhóm kể từ lần chuyển trước.`,
      ]
    : [
        `Tin tiếp theo từ nhóm Zalo${cfg.project ? ` dự án ${cfg.project}` : ""}, trong cùng cuộc trò chuyện. ${Owner} vừa tag và ra lệnh, kèm các tin trong nhóm kể từ lần chuyển trước.`,
        `Lệnh mới có thể bổ sung, đổi hướng hoặc hủy việc em đang làm hay đã giao. Nếu đổi hướng hoặc hủy, báo ngay teammate liên quan (coordinate_bots, rework) để họ dừng hoặc làm theo hướng mới, đừng để hai hướng chạy song song.`,
      ];
  return [
    ...intro,
    ...(items.length > 1 ? [`Có ${items.length} lệnh gửi liên tiếp trong lúc em đang bận; làm theo thứ tự, lệnh sau thắng nếu mâu thuẫn.`] : []),
    `File và ảnh đã được tải sẵn về máy chủ theo đường dẫn ghi bên dưới, em đọc trực tiếp được.`,
    ``,
    ...sections,
    `QUY ƯỚC TRẢ LỜI: toàn bộ câu trả lời của em sẽ được gửi NGUYÊN VĂN vào nhóm Zalo, mọi thành viên đọc được.`,
    `- Viết tiếng Việt, ngắn (1-5 câu), lịch sự, không markdown, không link nội bộ, không chi tiết kỹ thuật nội bộ.`,
    `- Việc nội bộ (giao việc cho team, issue, PR, tiến độ chi tiết) em xử lý và báo ${owner} trong OpenMausBot như bình thường, không đưa vào câu trả lời này.`,
    `- Cần ${owner} quyết định thì viết "@${cfg.ownerName}" kèm câu hỏi ngắn; hệ thống sẽ tag thật.`,
    `- Nếu không cần nói gì vào nhóm, trả lời đúng một từ: NO_REPLY`,
    `- Muốn gửi ảnh hoặc file vào nhóm (ảnh chụp màn hình, bản in, báo cáo...): lưu file vào thư mục ${cfg.outboxDir} rồi thêm một dòng riêng [[file: <đường dẫn tuyệt đối>]] cho mỗi file (tối đa 10 file, mỗi file ≤ 25MB). Gửi lại file khách đã gửi thì dùng đúng đường dẫn trong danh sách tin ở trên. File ngoài hai thư mục này sẽ không được gửi.`,
    `- Việc cần thời gian (giao team, chờ kết quả): khi xong hoặc có tiến triển đáng báo, hãy báo lại ngay trong chính cuộc trò chuyện này, dù là nhiều giờ sau. Mỗi lần báo thêm cũng lên nhóm, trả lời vào đúng tin yêu cầu gốc, nên hãy mở đầu bằng việc gì đã xong hoặc đang ở bước nào (nhắc lại yêu cầu thật ngắn), rồi kết quả và cách dùng hoặc kiểm tra; đừng chỉ viết "xong rồi".`,
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

const tagged = (err, flag) => Object.assign(err, { [flag]: true });

// Sends one prompt to the bot, continuing `thread` when given (otherwise the
// API opens a new one), and resolves with her final reply text (or null).
// Long work answers 202 "working"; an approval request answers 202
// "needs_approval" and waits for the owner in the app. Throws `busy` when the
// thread is mid-turn or the bot/key is at a limit (retry later), and `lost`
// when the thread can no longer be continued (open a new one).
async function askBot(prompt, { thread: target, onThread, onWorking, onApproval }) {
  let { status, body } = await botApi("POST", "", target ? { message: prompt, thread: target, wait: 50 } : { message: prompt, wait: 50 });
  const thread = body?.thread || target;
  log(`bot-api POST status=${status} thread=${thread ? thread.slice(0, 8) : "-"}${target ? " (continue)" : " (new)"} state=${body?.status || ""}`);
  if (status === 409 || status === 429) throw tagged(new Error(`Bot API ${status}`), "busy");
  if (target && (status === 404 || status === 403)) throw tagged(new Error(`Bot API ${status}: ${JSON.stringify(body).slice(0, 120)}`), "lost");
  if (thread && (status === 200 || status === 202)) onThread?.(thread);
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

// Threads with a hand-off in flight: the hand-off posts that answer itself, so
// the follow-up poller leaves them alone until it is done.
// Counted, since a queued command and a "#moi" can briefly target the same thread.
const inFlight = new Map();
const hold = (t) => inFlight.set(t, (inFlight.get(t) || 0) + 1);
const release = (t) => (inFlight.get(t) > 1 ? inFlight.set(t, inFlight.get(t) - 1) : inFlight.delete(t));

// Called after a hand-off's reply was posted. Answers that appeared during the
// hand-off (not in `before`) were part of that reply, so they count as seen;
// older unseen answers are left for the poller. Later follow-ups quote the
// newest request.
function watchThread(thread, quote, before) {
  if (!thread) return;
  const ids = completedAnswers(thread).map((a) => a.id);
  const until = Date.now() + cfg.followUpHours * 3600_000;
  const w = state.watch.find((x) => x.thread === thread);
  if (w) {
    for (const id of ids) if (!before.has(id) && !w.seen.includes(id)) w.seen.push(id);
    Object.assign(w, { quote, until });
  } else {
    state.watch.push({ thread, seen: ids, quote, until });
  }
  saveState();
  log(`watching thread=${thread.slice(0, 8)} seen=${(w || state.watch.at(-1)).seen.length}`);
}

function startFollowUps(post) {
  setInterval(async () => {
    const now = Date.now();
    const before = state.watch.length;
    state.watch = state.watch.filter((w) => w.until > now);
    let changed = state.watch.length !== before;
    for (const w of state.watch) {
      if (inFlight.has(w.thread)) continue;
      for (const a of completedAnswers(w.thread)) {
        if (inFlight.has(w.thread)) break;
        if (w.seen.includes(a.id)) continue;
        w.seen.push(a.id);
        changed = true;
        saveState();
        log(`follow-up thread=${w.thread.slice(0, 8)} item=${a.id.slice(-8)}`);
        await post(a.text, w.quote).catch((err) => log(`follow-up send failed: ${err.message}`));
      }
    }
    if (changed) saveState();
  }, 30_000);
}

async function main() {
  const api = await loginZalo(path.join(CONF_DIR, "zalo_credentials.json"));
  const selfId = String(api.getOwnId());
  log(`logged in as ${selfId}, watching group ${cfg.groupId}`);
  const send = async (t, quote = null) => {
    let r;
    try {
      r = await sendGroupText(api, cfg.groupId, t, cfg.ownerUid, cfg.ownerName, quote);
    } catch (err) {
      if (!quote) throw err;
      log(`quoted send failed (${err.message}), sending without quote`);
      r = await sendGroupText(api, cfg.groupId, t, cfg.ownerUid, cfg.ownerName);
    }
    log(`sent group msgId=${r?.message?.msgId || "none"} len=${t.length}`);
    return r;
  };
  // Posts one bot answer: text first (quoting the request), then any files it
  // attached with [[file: ...]] lines.
  const post = async (raw, quote) => {
    const { body, files, rejected } = extractFiles(raw || "");
    const text = stripMarkdown(body).trim();
    const hasText = text && text !== "NO_REPLY";
    if (!hasText && !files.length) { log("bot: NO_REPLY"); return; }
    if (hasText) {
      const parts = chunks(text);
      for (let i = 0; i < parts.length; i++) await send(parts[i], i === 0 ? quote : null);
    }
    if (files.length) {
      const r = await sendGroupFiles(api, cfg.groupId, files, hasText ? null : quote);
      log(`sent group files=${files.length} ok=${(r?.attachment || []).length}`);
    }
    if (rejected.length) {
      log(`rejected files=${rejected.length}`);
      await send(`@${cfg.ownerName} ${cfg.botName} muốn gửi ${rejected.length} file nhưng file nằm ngoài thư mục cho phép hoặc quá lớn, nên chưa gửi.`).catch(() => {});
    }
  };
  startFollowUps(post);

  // Hand-offs. Every command continues the group's one conversation
  // (state.thread), so a later command can change or cancel earlier work
  // instead of a second conversation doing it in parallel. "#moi" opens a new
  // conversation. A thread takes one turn at a time: while it is busy,
  // commands queue up and go together once it is free.
  const queue = [];
  let draining = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const deliver = async (items, fresh) => {
    const startedAt = Date.now();
    let toldQueued = false;
    let toldStuck = false;
    for (;;) {
      const target = fresh ? null : state.thread || null;
      const quote = items.at(-1).quote;
      const before = new Set(target ? completedAnswers(target).map((a) => a.id) : []);
      const held = target ? [target] : [];
      if (target) hold(target);
      try {
        const res = await askBot(buildPrompt(items, !target), {
          thread: target,
          onThread: (t) => {
            if (!held.includes(t)) { held.push(t); hold(t); }
            if (state.thread !== t) { state.thread = t; saveState(); log(`current thread=${t.slice(0, 8)}`); }
          },
          onWorking: () => (toldQueued ? null : send(`Đã nhận${target ? "" : " (việc mới)"}, ${cfg.botName} đang xử lý, có kết quả em báo ngay.`, quote)),
          onApproval: () => send(`@${cfg.ownerName} ${cfg.botName} cần duyệt một bước trong OpenMausBot.`, quote),
        });
        await post(res.reply, quote);
        watchThread(res.thread, quote, before);
        return;
      } catch (err) {
        if (err.busy) {
          if (!toldQueued) {
            toldQueued = true;
            await send(`Đã nhận, ${cfg.botName} đang làm dở việc trước, xong em chuyển ngay.`, items[0].quote).catch(() => {});
          }
          if (!toldStuck && Date.now() - startedAt > BUSY_ALERT_MS) {
            toldStuck = true;
            await send(`@${cfg.ownerName} ${cfg.botName} bận hơn ${BUSY_ALERT_MS / 60_000} phút, chưa nhận được lệnh mới, có thể đang kẹt. Em vẫn chờ; muốn bắt đầu cuộc mới thì tag kèm #moi.`, quote).catch(() => {});
          }
          await sleep(BUSY_RETRY_MS);
          items.push(...queue.splice(0));
          continue;
        }
        if (err.lost) {
          log(`thread=${target.slice(0, 8)} can't be continued (${err.message}), opening a new one`);
          if (state.thread === target) { state.thread = null; saveState(); }
          fresh = true;
          continue;
        }
        state.buffer.unshift(...items.flatMap((it) => it.buffered));
        saveState();
        log(`hand-off failed: ${err.message}`);
        await send(`@${cfg.ownerName} chưa chuyển được cho ${cfg.botName} (${err.message.slice(0, 120)}). Tag lại sau ít phút nhé.`, quote).catch(() => {});
        return;
      } finally {
        held.forEach(release);
      }
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) await deliver(queue.splice(0), false);
    } finally {
      draining = false;
    }
  };

  // "#moi" skips the queue: it may be how the owner gets past a stuck thread.
  // Commands still waiting go along with it into the new conversation.
  const handOff = (item) => {
    if (!item.fresh) { queue.push(item); drain(); return; }
    deliver([...queue.splice(0), item], true).catch((err) => log(`hand-off crashed: ${err.stack || err.message}`));
  };

  api.listener.on("message", async (msg) => {
    if (msg.type !== ThreadType.Group || msg.isSelf || msg.threadId !== cfg.groupId) return;
    const rec = await normalizeGroupMessage(msg, cfg.inboxDir, log, api);
    delete rec.raw;
    const quote = quoteRefOf(msg.data);
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
    const fresh = isFreshCommand(msg.data);
    if (fresh) rec.text = rec.text.normalize("NFC").replace(FRESH_TAG_ANYWHERE, "$1").replace(/\s{2,}/g, " ").trim();
    log(`trigger msg=${rec.msgId} buffered=${buffered.length}${fresh ? " fresh" : ""}`);
    handOff({ rec, buffered, quote, fresh });
  });

  api.listener.on("connected", () => log("listener connected"));
  api.listener.on("disconnected", (code, reason) => log(`listener disconnected code=${code} ${reason || ""}`));
  api.listener.on("closed", (code, reason) => { log(`listener closed code=${code} ${reason || ""}`); process.exit(1); });
  api.listener.start({ retryOnClose: true });
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
