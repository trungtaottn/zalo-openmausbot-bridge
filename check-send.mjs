// Diagnostic: sends one short test message and prints Zalo's raw response.
// Usage: node check-send.mjs owner   (DM to the owner)
//        node check-send.mjs group   (to the configured group)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginZalo, ThreadType } from "./zalo.mjs";

const dir = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const api = await loginZalo(path.join(dir, "zalo_credentials.json"));
const target = process.argv[2] === "group" ? [cfg.groupId, ThreadType.Group] : [cfg.ownerUid, ThreadType.User];
const res = await api.sendMessage({ msg: "Kiểm tra gửi tin từ cầu Zalo (bỏ qua tin này)." }, ...target);
console.log(JSON.stringify(res));
process.exit(0);
