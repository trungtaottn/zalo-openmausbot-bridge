// Diagnostic: prints the last few messages of the configured group (short
// previews only) to confirm what actually reached Zalo. HTTP only, no listener.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginZalo } from "./zalo.mjs";

const dir = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const api = await loginZalo(path.join(dir, "zalo_credentials.json"));
const me = String(api.getOwnId());
const count = Number(process.argv[2] || 12);
const res = await api.getCloudMessage(cfg.groupId);
const msgs = (res.groupMsgs || []).map((m) => m.data || m).sort((a, b) => Number(a.ts) - Number(b.ts));
for (const d of msgs.slice(-count)) {
  const who = String(d.uidFrom) === me || String(d.uidFrom) === "0" ? "BOT" : String(d.uidFrom) === cfg.ownerUid ? "OWNER" : "MEMBER";
  const t = new Date(Number(d.ts)).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const text = typeof d.content === "string" ? d.content : `[${d.msgType}]`;
  console.log(t, who, text.replace(/\s+/g, " ").slice(0, 50));
}
process.exit(0);
