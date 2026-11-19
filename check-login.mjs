// One-off health check: logs in with the saved Zalo session and confirms the
// bot can see the configured group. Prints only masked identifiers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginZalo } from "./zalo.mjs";

const dir = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const api = await loginZalo(path.join(dir, "zalo_credentials.json"));
const me = String(api.getOwnId());
console.log("login ok, own id", `${me.slice(0, 4)}…${me.slice(-3)}`);
const info = await api.getGroupInfo(cfg.groupId);
const g = info.gridInfoMap?.[cfg.groupId];
const members = (g?.memVerList || []).map((x) => String(x).split("_")[0]);
console.log("group found:", Boolean(g), "members:", g?.totalMember, "owner in group:", members.includes(cfg.ownerUid));
process.exit(0);
