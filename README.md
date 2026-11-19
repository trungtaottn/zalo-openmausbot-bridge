# zalo-openmausbot-bridge

Nối một nhóm Zalo với một bot trong [OpenMausBot](https://github.com/milind-soni/OpenMausBot).

Một tài khoản Zalo (gọi là tài khoản bot) ngồi trong nhóm và ghi lại mọi tin, ảnh, file. Chỉ khi **một người được chỉ định** (chủ nhóm) tag tài khoản đó, service mới gom các tin từ lần trước gửi cho bot OpenMausBot qua Bot API, rồi đưa câu trả lời của bot vào nhóm **đúng một lần**.

> Bridge a Zalo group to an OpenMausBot bot: the bridge records every group message (files included), hands everything off to the bot when the owner @mentions the bridge account, and posts the bot's reply exactly once. Docs below are in Vietnamese.

## Dùng khi nào

- Nhóm Zalo có khách hàng nhắn yêu cầu, gửi ảnh, gửi file. Bạn muốn một bot AI (ví dụ một bot điều phối giao việc cho team) nhận toàn bộ nội dung đó khi bạn bảo "nhận đi".
- Khách tag tài khoản bot không có tác dụng. Chỉ UID của chủ nhóm mới kích hoạt.

## Luồng chạy

```
Thành viên nhắn, gửi ảnh/file (không tag)        Chủ nhóm: "@<tài khoản bot> nhận đi ..."
            │                                                │
            ▼                                                ▼
  zca-js listener (Zalo Web, tài khoản bot) ──── bridge.mjs
            │ ghi vào bộ đệm, tải file về                    │ đúng UID chủ nhóm + có tag tài khoản bot?
            │ <inboxDir>/<nhóm>/<ngày>/                      │
            ▼                                                ▼
  ~/.local/state/zalo-openmausbot-bridge/state.json   gom lệnh + bộ đệm thành 1 tin
                                                             │ POST Bot API của OpenMausBot
                                                             ▼
                                                  Bot trong OpenMausBot (key "Acts as me")
                                                             │ reply (200) hoặc working (202)
                                                             ▼
                                   bridge.mjs gửi vào nhóm đúng 1 lần (code gửi, không phải model)
```

- **Không tag:** chỉ ghi lại, không trả lời ai. Giữ tối đa `maxBuffered` tin. Ảnh, file, video, voice được tải về `inboxDir`, kể cả ảnh/file nằm trong tin được trả lời (quote).
- **Kích hoạt:** người gửi phải có đúng `ownerUid` **và** tin phải tag tài khoản bot. Kiểm tra theo UID, không theo tên hiển thị.
- **Gửi cho bot:** mỗi lần là một thread Bot API mới. Prompt có sẵn quy ước:
  - Câu trả lời sẽ lên nhóm, mọi thành viên đọc được.
  - Việc nội bộ thì báo chủ nhóm trong OpenMausBot.
  - Cần chủ nhóm quyết định thì viết `@<ownerName>`.
  - Không cần nói gì thì trả `NO_REPLY`.
  - Có thể thêm luật riêng bằng `extraRules`.
- **Trả lời:**
  - `200`: gửi ngay.
  - `202 working`: báo "Đã nhận, <botName> đang xử lý" một lần, rồi 30 giây hỏi lại một lần, tối đa 6 giờ.
  - `202 needs_approval`: tag chủ nhóm để vào OpenMausBot duyệt.
  - Chữ `@<ownerName>` được đổi thành tag thật.
  - Câu dài hơn 1800 ký tự được tách nhiều tin. Markdown bị bỏ.
- **Lỗi khi gọi bot:** đưa tin trở lại bộ đệm và tag chủ nhóm để thử lại.

## Yêu cầu

- Linux có systemd (đã chạy trên Arch). macOS chạy tay được bằng `npm start`.
- Node.js ≥ 18.
- OpenMausBot chạy **trên cùng máy**, vì bridge gọi `http://127.0.0.1:8800`. Bot nhận được đường dẫn file đã tải về và đọc trực tiếp từ ổ đĩa.
- Một tài khoản Zalo cá nhân làm tài khoản bot, và tài khoản đó đã ở trong nhóm. Nên dùng tài khoản riêng, xem mục Rủi ro.

## Cài đặt

### 1. Lấy code

```bash
git clone https://github.com/trungtaottn/zalo-openmausbot-bridge.git ~/Code/zalo-openmausbot-bridge
cd ~/Code/zalo-openmausbot-bridge
npm install
```

Clone vào chỗ khác thì sửa `WorkingDirectory` và `ExecStart` trong `deploy/zalo-openmausbot-bridge.service`.

### 2. Bật Bot API cho bot trong OpenMausBot

1. Mở cài đặt của bot (biểu tượng bánh răng), vào Advanced: Access, mục **Bot API**, bật **Let apps talk to this bot**.
2. Copy key `bak_…` **ngay**, vì key chỉ hiện một lần.
3. Bật **Acts as me** cho key.
   - Nếu không bật, bot chỉ nhận Bot API khi AI của bot chạy được chế độ "confined". Theo [tài liệu Bot API](https://github.com/milind-soni/OpenMausBot/blob/main/docs/bot-api.md), chỉ Claude, Codex và các AI gọi bằng API key mới chạy được chế độ này. Các engine khác như `pi`, `antigravity` sẽ trả `403 This bot's AI can't take Bot API calls`.
   - "Acts as me" cho bot dùng đủ tool ở mức quyền của nó (ví dụ giao việc cho teammate). Đổi lại, **ai giữ key là điều khiển được bot như chính bạn**, nên giữ key như mật khẩu.
   - "Acts as me" chỉ bật được trên server một người dùng (self-hosted hoặc desktop, không có member khác).
4. Lấy `botId`: là id của bot trong OpenMausBot, nằm trong đường dẫn lệnh mẫu mà thẻ Bot API hiển thị: `/hooks/api/bots/<botId>/messages`.

### 3. Lưu key, không để hiện trên màn hình

```bash
mkdir -p ~/.config/zalo-openmausbot-bridge && chmod 700 ~/.config/zalo-openmausbot-bridge
read -rsp "Bot API key: " K; echo; umask 077; printf %s "$K" > ~/.config/zalo-openmausbot-bridge/bot_api_key
```

### 4. Đăng nhập tài khoản Zalo bot

```bash
node login-qr.mjs
```

Quét file `~/.config/zalo-openmausbot-bridge/qr.png` bằng app Zalo của **tài khoản bot**. Phiên đăng nhập được lưu vào `zalo_credentials.json` (0600). Nếu đã có sẵn phiên `{imei, cookie, userAgent}` xuất từ công cụ khác dùng cùng giao thức (ví dụ kênh Zalo cá nhân của goclaw), có thể ghi thẳng vào file đó; cookie thiếu `domain` hoặc `path` sẽ được tự gán `zalo.me` và `/`.

> **Mỗi tài khoản chỉ chạy được một listener Zalo Web.** Đừng mở Zalo Web của tài khoản bot trên trình duyệt, và tắt mọi công cụ khác đang đăng nhập tài khoản đó.

### 5. Cấu hình

```bash
cp deploy/config.example.json ~/.config/zalo-openmausbot-bridge/config.json
chmod 600 ~/.config/zalo-openmausbot-bridge/config.json
node check-groups.mjs              # liệt kê nhóm: <groupId>  <số thành viên>  <tên nhóm>
node check-groups.mjs <groupId>    # liệt kê thành viên: <uid>  <tên>, tìm UID của chủ nhóm
```

| Khóa | Bắt buộc | Ý nghĩa |
|---|---|---|
| `groupId` | có | Nhóm Zalo cần nghe |
| `ownerUid` | có | UID Zalo của người duy nhất được kích hoạt |
| `botId` | có | Id bot trong OpenMausBot |
| `botApiBase` | có | Thường là `http://127.0.0.1:8800/hooks/api/bots`. Nếu đổi `OMB_WEBHOOK_PORT` hoặc `OMB_PORT` thì đổi cổng theo |
| `ownerName` | | Chữ dùng để tag, mặc định `Anh`. Bot viết `@Anh` thì bridge đổi thành tag thật |
| `ownerLabel` | | Cách gọi chủ nhóm trong prompt, mặc định `chủ nhóm` |
| `botName` | | Tên bot trong các tin "đang xử lý", mặc định `Bot` |
| `project` | | Tên dự án hoặc nhóm, đưa vào prompt cho bot có ngữ cảnh |
| `inboxDir` | | Nơi lưu file tải về, mặc định `~/zalo-inbox` |
| `maxBuffered` | | Số tin tối đa giữ trong bộ đệm, mặc định 200 |
| `extraRules` | | Mảng câu dặn thêm cho bot, ví dụ `"Việc kỹ thuật giao cho trưởng IT"` |

Muốn đặt cấu hình và state ở chỗ khác thì dùng biến môi trường `ZALO_BRIDGE_CONFIG_DIR` và `ZALO_BRIDGE_STATE_DIR`.

### 6. Kiểm tra

```bash
node check-login.mjs         # phải in: login ok … group found: true … owner in group: true
node check-send.mjs owner    # gửi 1 tin nhắn riêng cho chủ nhóm, in phản hồi Zalo (có msgId là gửi được)
```

### 7. Chạy service

```bash
mkdir -p ~/.config/systemd/user
cp deploy/zalo-openmausbot-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zalo-openmausbot-bridge
loginctl enable-linger "$USER"     # để service chạy cả khi không đăng nhập
```

Thử: một thành viên nhắn vài tin kèm ảnh, rồi chủ nhóm tag tài khoản bot, ví dụ "nhận đi".

## Vận hành

- **Log:** `journalctl --user -u zalo-openmausbot-bridge -f`. Log chỉ có mã tin, số file và trạng thái, không có nội dung tin.
  - `buffered msg=… from=member files=N`: đã ghi một tin.
  - `trigger msg=… buffered=N`: chủ nhóm vừa tag, N tin được gửi kèm.
  - `bot-api POST status=200|202 thread=…`: bot đã nhận.
  - `sent group msgId=…`: tin đã lên Zalo.
- **Khởi động lại:** `systemctl --user restart zalo-openmausbot-bridge`. Bộ đệm lưu trong file nên không mất.
- **Phiên Zalo hết hạn** (log báo `Đăng nhập thất bại` hoặc `listener closed` lặp lại): `systemctl --user stop zalo-openmausbot-bridge`, chạy `node login-qr.mjs`, rồi `start` lại.
- **Xem tin gần nhất trong nhóm:** `node check-history.mjs 12`, chỉ in bản xem trước ngắn.
- **Tạm ngưng:** `systemctl --user stop zalo-openmausbot-bridge`. Tin gửi lúc service dừng sẽ không được ghi lại.

## Các file

| File | Vai trò |
|---|---|
| `bridge.mjs` | Service chính: bộ đệm, nhận diện lệnh, gọi Bot API, gửi trả lời |
| `zalo.mjs` | Đăng nhập bằng cookie, chuẩn hóa tin nhóm, tải ảnh/file/video/voice (kể cả trong quote), gửi tin có tag |
| `login-qr.mjs` | Đăng nhập Zalo bằng QR, lưu phiên |
| `check-groups.mjs` | Tìm `groupId` và `ownerUid` |
| `check-login.mjs` | Kiểm tra phiên và quyền thấy nhóm |
| `check-send.mjs` | Gửi tin thử (`owner` hoặc `group`) |
| `check-history.mjs` | Xem nhanh các tin gần nhất của nhóm |
| `deploy/` | Unit systemd và cấu hình mẫu |

## Bảo mật và rủi ro

- **Secret không nằm trong repo.** Mọi thứ nhạy cảm (`bot_api_key`, `zalo_credentials.json`, `config.json`) nằm trong `~/.config/zalo-openmausbot-bridge/` với quyền 0700/0600. Đừng commit chúng.
- **Key "Acts as me"** cho phép điều khiển bot ở mức quyền của bot. Nếu lộ thì bấm **New key** trong OpenMausBot, rồi bật lại "Acts as me" cho key mới.
- **`zca-js` là API Zalo không chính thức.** Tài khoản có thể bị khóa, và Zalo đổi giao thức thì phải nâng thư viện. Nên dùng tài khoản Zalo riêng cho bot.
- **Dữ liệu của khách:** tin và file được lưu trên máy chạy bridge (`inboxDir`, file state) và đi vào thread của bot trong OpenMausBot. Chưa có lịch tự xóa `inboxDir`. Hãy báo cho thành viên nhóm biết nếu cần.
- Bridge chỉ nghe được tin khi đang chạy. Tin gửi lúc dừng không được bù lại.

## Thư viện

Dùng [zca-js](https://github.com/RFS-ADRENO/zca-js) để giao tiếp với Zalo.
