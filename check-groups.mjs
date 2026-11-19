// Setup helper: find the values config.json needs.
//   node check-groups.mjs            → list groups this Zalo account is in (id, name, members)
//   node check-groups.mjs <groupId>  → list members of that group (uid, display name)
// Run it while the bridge service is stopped or running; it only makes HTTP calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginZalo } from "./zalo.mjs";

const dir = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
const api = await loginZalo(path.join(dir, "zalo_credentials.json"));
console.log("bot account uid:", String(api.getOwnId()));

const groupId = process.argv[2];
if (!groupId) {
  const all = await api.getAllGroups();
  const ids = Object.keys(all.gridVerMap || {});
  for (let i = 0; i < ids.length; i += 50) {
    const info = await api.getGroupInfo(ids.slice(i, i + 50));
    for (const [id, g] of Object.entries(info.gridInfoMap || {})) {
      console.log(`${id}\t${g.totalMember ?? "?"} members\t${g.name ?? ""}`);
    }
  }
} else {
  const info = await api.getGroupInfo(groupId);
  const g = info.gridInfoMap?.[groupId];
  if (!g) {
    console.log("group not found for this account");
    process.exit(1);
  }
  const ids = (g.memVerList || []).map((x) => String(x).split("_")[0]);
  const prof = ids.length ? await api.getGroupMembersInfo(ids) : { profiles: {} };
  console.log(`group: ${g.name ?? groupId} (${ids.length} members)`);
  for (const id of ids) {
    const p = prof.profiles?.[id] || prof.profiles?.[`${id}_0`] || {};
    console.log(`${id}\t${p.displayName || p.zaloName || ""}`);
  }
}
process.exit(0);
