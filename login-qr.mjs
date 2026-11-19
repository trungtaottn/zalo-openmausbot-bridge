// Fresh Zalo login by QR, for when the saved session expires or for a new account.
// Stop the bridge service first (only one Zalo Web listener per account), run:
//   node login-qr.mjs
// then scan ~/.config/zalo-openmausbot-bridge/qr.png with the bot account's Zalo app.
// The new session is written to ~/.config/zalo-openmausbot-bridge/zalo_credentials.json (0600).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Zalo, LoginQRCallbackEventType } from "zca-js";

const dir = process.env.ZALO_BRIDGE_CONFIG_DIR || path.join(os.homedir(), ".config/zalo-openmausbot-bridge");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const qrPath = path.join(dir, "qr.png");
const credPath = path.join(dir, "zalo_credentials.json");

const zalo = new Zalo({ selfListen: false, checkUpdate: false, logging: false });
const api = await zalo.loginQR({ qrPath, language: "vi" }, async (event) => {
  if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
    await event.actions.saveToFile(qrPath);
    console.log(`QR saved to ${qrPath}; scan it with the bot account's Zalo app.`);
  }
  if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
    fs.writeFileSync(credPath, JSON.stringify({ ...event.data, language: "vi" }), { mode: 0o600 });
    console.log(`Session saved to ${credPath}`);
  }
});
const me = String(api.getOwnId());
console.log("login ok, own id", `${me.slice(0, 4)}…${me.slice(-3)}`);
fs.rmSync(qrPath, { force: true });
process.exit(0);
