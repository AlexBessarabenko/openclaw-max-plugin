# OpenClaw MAX Messenger Plugin

Channel plugin connecting OpenClaw to [MAX Messenger](https://max.ru) — Russian messaging platform.
Tested with OpenClaw **2026.9.3**, MAX Bot API v2 (`platform-api2.max.ru`).

> **OpenClaw ≥ 2026.9 note:** gateway 2026.9.x starts channel accounts inside a
> short-lived root-work admission context. Long-lived channel work (the polling
> loop, post-ACK webhook processing) must detach from it, otherwise every
> inbound dispatch is rejected with `GatewayDrainingError` — messages arrive,
> but replies are never sent. Since **0.3.4** the plugin detaches automatically
> (`runOutsideInheritedRootWork` in `channel.ts`). On plugin ≤ 0.3.3 replies
> silently stop after a gateway restart.

## Features

- ✅ Two-way messaging (text, Markdown, 4000-char chunking)
- ✅ **MAX Bot API v2** — `platform-api2.max.ru` by default, bundled Минцифры CA certificates
- ✅ Webhook (auto-subscription, `X-Max-Bot-Api-Secret` validation, immediate 200 ACK) + Long Polling fallback
- ✅ **Correct per-chat sessions** — canonical OpenClaw session keys, session recording and last-route updates (context no longer resets between messages)
- ✅ DM security (`dmPolicy`: open/allowlist/closed) + pairing flow for new contacts
- ✅ Direct messages and group chats (group sessions isolated per chat)
- ✅ **Media support** — images, video and files are downloaded into the OpenClaw media store and analyzed by the configured multimodal models
- ✅ **Voice transcription** — audio messages transcribed by the gateway's media-understanding pipeline (`tools.media.audio`, e.g. Groq Whisper) — no keys or uploads handled by the plugin itself
- ✅ `bot_started` support — the "Начать" button becomes `/start` (deep-link payload appended)
- ✅ Typing indicator with keepalive, bot-loop protection, message deduplication
- ✅ **Streaming replies** — partial model output edits a single draft message in place (`editMessage`), final text replaces it; can be disabled
- ✅ **Scoped HTTP proxy** — optional per-account proxy for MAX API traffic only, without touching the rest of the gateway
- ✅ **Agent prompt hints** — the plugin teaches the agent MAX Markdown rules, the 4000-char limit and delivery-target syntax via `agentPrompt`
- ✅ **Inline keyboards** — the agent attaches buttons via the `message` tool `presentation` param or `channelData.maxInlineKeyboard`; button presses arrive as inbound messages and are auto-acknowledged
- ✅ **Message actions** — the agent edits/deletes its own messages, pins/unpins in chats, echoes stickers and sends native location pins / contact cards via the `message` tool
- ✅ **`max_send_file` agent tool** — delivers a local file or an http(s) URL into the current MAX chat (media-roots confinement, SSRF-guarded download)
- ✅ **Group policies** — `groupPolicy` (open/allowlist/disabled), per-group config with a `*` wildcard, `requireMention` (a reply to the bot counts as a mention)
- ✅ **Reliable inbound** — persistent polling marker + dedup snapshot (at-least-once across restarts), `message_edited` tracking, send retry on `attachment.not.ready`
- ✅ **Security hardening** — SSRF-guarded downloads, media-roots confinement for local sends, access check before any attachment download, attachment limits (≤10 files, ≤25 MB each)
- ✅ **Send options** — per-message silent (`channelData.maxNotify`) and link-preview suppression (`maxDisableLinkPreview`), with channel-level defaults; remote images attach by URL without a re-upload
- ✅ **Pairing approval notice** — the user gets a ✅ confirmation in MAX after `openclaw pairing approve --notify`
- ✅ **Status diagnostics** — `openclaw channels status` reports a masked token preview, policies, transport mode and proxy state (`inspectAccount`)

## Installation

### Via ClawHub (Recommended)

```bash
openclaw plugins install clawhub:@alexbessarabenko/openclaw-max
```

### Via npm

```bash
openclaw plugins install npm:@alexbessarabenko/openclaw-max
```

### Via GitHub

```bash
openclaw plugins install github:AlexBessarabenko/openclaw-max-plugin
```

### Manual (Development)

```bash
cd ~/.openclaw/extensions
git clone https://github.com/AlexBessarabenko/openclaw-max-plugin.git max
cd max
npm install
npm run build
```

## Configuration

`~/.openclaw/config.json`:

```json
{
  "channels": {
    "max": {
      "token": "YOUR_MAX_BOT_TOKEN",
      "dmPolicy": "allowlist",
      "allowFrom": ["123456789"],
      "webhookUrl": "https://your-host/max/webhook",
      "webhookSecret": "random-long-secret"
    }
  }
}
```

| Option | Description |
|--------|-------------|
| `token` | Bot token from [MAX for Partners](https://partners.max.ru) (required) |
| `dmPolicy` | `allowlist` (default), `open`, `closed` — who can DM the bot |
| `allowFrom` | MAX user IDs allowed when policy is `allowlist` |
| `groupPolicy` | `open` (default), `allowlist`, `disabled` — how the bot behaves in group chats (see "Group chats") |
| `groupAllowFrom` | MAX user IDs allowed to trigger the bot in groups when `groupPolicy` is `allowlist` (empty = any member of an allowed group) |
| `requireMention` | `false` (default) — in groups the bot answers only when @-mentioned or replied to |
| `groups` | Per-group overrides keyed by chat id (or `"*"`): `{ "requireMention": bool, "enabled": bool }` |
| `notify` | Channel default for outbound notifications; `false` = send silently. Per-message override: `channelData.maxNotify` |
| `disableLinkPreview` | Channel default for suppressing link previews. Per-message override: `channelData.maxDisableLinkPreview` |
| `logInboundPreview` | `false` (default) — the inbound log line carries metadata only (chat, type, sender, text length); `true` adds a 50-char text preview for debugging |
| `webhookUrl` | Public URL of the `/max/webhook` route. When set, the plugin subscribes via `POST /subscriptions` automatically. When empty — long polling |
| `webhookSecret` | Optional secret; verified against the `X-Max-Bot-Api-Secret` header |
| `apiBaseUrl` | API override, default `https://platform-api2.max.ru` |
| `streaming` | `true` (default) — edit one draft message as the reply streams; `false` — send only the final message |
| `httpProxy` | Optional HTTP/HTTPS proxy URL (`http://host:port`) for MAX API requests only |

### Voice transcription

Since plugin **0.3.0**, transcription runs through the gateway's media-understanding
pipeline — the plugin itself holds no API keys and uploads nothing to third parties.
Enable and configure `tools.media.audio` in `~/.openclaw/openclaw.json`, and supply
the provider key to the **gateway** (e.g. `env.GROQ_API_KEY`, or the official Groq
provider plugin):

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "language": "ru",
        "models": [{ "provider": "groq", "model": "whisper-large-v3" }]
      }
    }
  }
}
```

`language` is an operator choice — omit it for provider auto-detection. With no STT
provider configured, voice messages are delivered as audio attachments, untranscribed.

**Migrating from 0.2.x:** up to 0.2.1 the plugin read `GROQ_API_KEY` from the
environment itself and sent audio to Groq with a hardcoded Russian locale. If you
relied on that, add the `tools.media.audio` block above — a 1:1 replacement that is
additionally consent-gated and locale-configurable.

**Inbound voice-note coverage is client-dependent.** Verified live: voice notes
recorded in the **iOS** app arrive over long polling; the same notes recorded in the
**Android** app may not be delivered to bots over polling at all. For full coverage
run the bot in **webhook** mode (`webhookUrl`) behind a public HTTPS endpoint —
e.g. Caddy or nginx with Let's Encrypt, or a tunnel like CloudPub.

### Voice replies (TTS)

Replies can be voiced through the gateway's TTS pipeline — the plugin only delivers
the resulting audio file. Verified working with the **free Microsoft Edge TTS**
provider (no API key required) — enable the bundled `microsoft` plugin and set it as
the TTS provider in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": { "entries": { "microsoft": { "enabled": true } } },
  "tts": {
    "auto": "inbound",
    "provider": "microsoft",
    "providers": {
      "microsoft": { "voice": "ru-RU-DmitryNeural", "lang": "ru-RU" }
    }
  }
}
```

Russian voices to choose from: **`ru-RU-DmitryNeural`** (male) or
**`ru-RU-SvetlanaNeural`** (female). `auto: "inbound"` voices replies only to voice
messages; `"always"` voices every reply. OpenRouter (`hexgrad/kokoro-82m`) also
works, but Kokoro has no Russian language support — use it for English only.

> Note: the `microsoft` plugin must be allowed by your `plugins.allow` list when one
> is configured, and a gateway **restart** is required after enabling it (speech
> providers register at startup; a hot reload is not enough).

### TLS certificates (platform-api2.max.ru)

MAX officially requires bots to migrate to `platform-api2.max.ru` and to trust the
Russian national root CA (Минцифры / "Russian Trusted Root CA", distributed via
[gosuslugi.ru/crt](https://www.gosuslugi.ru/crt)). Node.js does not trust this root
out of the box, so the plugin ships the required PEM files in `certs/`.

Since **0.3.6** the extra CAs are loaded into a dedicated undici dispatcher used
**only for requests to MAX infrastructure hosts** (`*.max.ru`, `*.oneme.ru`) — the
plugin passes a scoped `fetch` to the max-bot-api client and uses it for uploads,
attachment downloads and probes. The process-wide TLS trust store is **never
modified** (`tls.setDefaultCACertificates` is not called): every other plugin and
channel in the gateway keeps Node's default trust. This addresses the ClawHub
security-audit note from earlier versions.

On Node older than 22.15 the plugin cannot read the default CA list at runtime
and warns instead — install the certificates system-wide:

```bash
sudo cp certs/*.crt /usr/local/share/ca-certificates/mincifry/
sudo update-ca-certificates
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/russian_trusted_root_ca_pem.pem
```

## Security

- **Access check before download** — DM (`dmPolicy`/allowlist) and group policy gates
  run before any attachment is fetched or written; a blocked sender cannot make the
  plugin touch the network or disk.
- **SSRF-guarded downloads** — all remote fetches (inbound attachments, outbound
  media by URL, `max_send_file` URLs) go through the OpenClaw SSRF guard; image
  URLs attached by link (no download) still get their host screened for
  private/loopback addresses.
- **Media confinement** — local files are read only through the gateway's media
  reader or from the agent's allowed media roots; an agent-named arbitrary path is
  refused.
- **Attachment limits** — at most 10 attachments per message, 25 MB each; oversized
  downloads abort before buffering.
- **No token leakage** — diagnostics (`inspectAccount`) report only a masked
  first4…last4 preview; the token never leaves the config.

## ⚠️ Privacy & Consent Notice

This plugin talks **only** to the MAX Bot API. Any AI processing of message content
is performed by the OpenClaw gateway under the operator's control:

- **Voice / audio** is sent to a speech-to-text provider (e.g. Groq Whisper) **only**
  when the operator has explicitly enabled and configured `tools.media.audio` —
  provider, model, language and API key are all operator-chosen. With no STT provider
  configured, audio never leaves the gateway for transcription.
- **Images and PDFs** are analyzed **only** by the models the operator set in
  `agents.defaults.imageModel` / `agents.defaults.pdfModel`; that content leaves the
  host only towards those operator-configured providers.
- The plugin reads no third-party API keys and uploads nothing on its own.

If you operate this bot, inform your users — in DMs and especially in group chats —
that their messages and media may be processed by the third-party AI providers you
have configured.

## How sessions behave (context within one chat)

- Every DM partner gets their own session (`agent:<id>:max:default:direct:<userId>`), every group chat gets its own session. Context persists across messages.
- By default OpenClaw resets sessions **daily at 04:00** (`session.reset`) and honors `/new` and `/reset`. Tune via `session.reset`, `session.resetByType.{dm,group}`, `session.resetByChannel.max` or `session.idleMinutes` in the OpenClaw config.
- "🧹 Compacting context…" is **compaction** (history is summarized, not wiped). Configure via `agents.defaults.compaction.notifyUser` / `agents.defaults.compaction.model`.
- Session state lives in the agent store (`~/.openclaw/agents/<agentId>/sessions/sessions.json`); `bindings[]` routing of MAX peers to specific agents is respected.

## Usage

### Webhook (recommended)

Set `webhookUrl` to the public address of your gateway's `/max/webhook` route — the plugin registers the subscription with MAX itself (`update_types: message_created, message_callback, bot_started, message_edited`). Set `webhookSecret` so MAX signs deliveries.

### Long polling

Leave `webhookUrl` empty — the plugin polls `GET /updates` automatically. The polling
marker (plus a dedup snapshot) is **persisted after each fully processed batch**, so a
gateway restart replays at most one batch and the snapshot absorbs it (at-least-once
delivery). Restarts after transient errors use exponential backoff with jitter (5 s →
5 min, reset after a healthy minute) and are logged as
`Long polling exited unexpectedly, restarting in Ns`.

### Delivery targets (`message` tool, `openclaw message send`)

Since **0.3.5** the plugin ships a `messaging` target adapter, so the agent's `message`
tool and `openclaw message send --channel max --to <target>` accept MAX chat ids directly
(`max:` prefix optional).

**DMs:** since **0.4.0** you can address a user directly with `user:<userId>` — the
plugin then calls `sendMessageToUser`, which resolves the dialog itself
(`openclaw message send --channel max --to user:8740709 …`). A bare numeric id is still
treated as a **chat id** (the dialog chat id works too). Group/channel ids are negative.
The dialog chat id appears in the gateway log on every inbound message
(`[MAX] inbound: chat=<id> …`).

### Streaming replies

Since **0.4.0**, when the model streams partial output, the plugin sends one draft
message and keeps editing it in place (throttled, `format: "markdown"`); the final reply
replaces the draft text. Long final answers are still chunked at 4000 chars — the first
chunk edits the draft, the rest arrive as follow-up messages. Set
`channels.max.streaming: false` to restore the old send-once behavior.

### Inline keyboards (buttons)

The agent can attach inline keyboards to the final reply and react to button
presses. Two ways to describe buttons:

**Portable `presentation` param of the `message` tool** (works on the tool send
path, including `openclaw message send`-style deliveries):

```json
{
  "presentation": {
    "blocks": [
      {
        "type": "buttons",
        "buttons": [
          { "label": "Да", "value": "vote:yes" },
          { "label": "Нет", "action": { "type": "callback", "value": "vote:no" } },
          { "label": "Открыть", "url": "https://dev.max.ru" }
        ]
      }
    ]
  }
}
```

`value` (or `action` `callback`/`command`) makes a callback button; `url` (or
action type `url`/`web-app`) makes a link button. Buttons pack three per row.

**`channelData.maxInlineKeyboard`** — on the agent's reply path (one inner
array = one row), giving explicit control over row layout:

```json
{
  "channelData": {
    "maxInlineKeyboard": [
      [{ "text": "Да", "payload": "vote:yes" }, "Нет"],
      [{ "text": "Открыть", "url": "https://dev.max.ru" }]
    ]
  }
}
```

- Simplified `{text, url?, payload?}` (and plain strings — payload = label) or full wire
  buttons `{type: "callback"|"link"|"clipboard", …}`; URL buttons win over payload.
- On any single payload `channelData.maxInlineKeyboard` wins over `presentation`
  and legacy `interactive` buttons.
- MAX limits enforced by validation: ≤ **210** buttons, ≤ **30** rows, ≤ **7** buttons
  per row (≤ **3** when the row contains a `link`-type button), link URL ≤ **2048** chars.
- The keyboard rides only the **final** message (a streaming draft is edited into the
  final text with the keyboard attached; long replies carry it on the last chunk).
- Invalid keyboards are logged and dropped — the text reply still goes out.
- `message_callback` updates arrive as regular inbound messages carrying the button
  payload as text; the callback is auto-acknowledged (`POST /answers`), so no spinner
  is left hanging on the button. Make payloads self-describing — MAX does not echo the
  button label.

### Message actions (message tool)

Since **0.5.0** the plugin owns a set of actions on the agent's shared `message` tool
(plain text/media send stays on the core delivery path):

```
message(action="edit",    messageId="<mid>", message="new text")
message(action="delete",  messageId="<mid>")
message(action="pin",     target="<chat_id>", messageId="<mid>", notify=false)
message(action="unpin",   target="<chat_id>")
message(action="sticker", target="<chat_id>", stickerId="<code>")   // code optional
message(action="sendAttachment", type="location", target="<chat_id>", latitude="55.75", longitude="37.62")
message(action="sendAttachment", type="contact",  target="<chat_id>", contactName="Имя", vcfPhone="+79001234567")
message(action="sendAttachment", type="contact",  target="<chat_id>", contactId="<max_user_id>")
```

- **Edit limits:** the bot's own messages can be edited up to **7 days** in dialogs;
  messages with an inline keyboard and messages in groups/channels have **no time
  limit**. Deletion has **no time limit**. MAX allows at most **2 edit/delete
  operations per second per chat**.
- **Stickers are echo-only:** there is no public sticker catalog API in MAX (a
  scraped static catalog was rejected as brittle), so `stickerId` must be a code the
  bot has actually seen. Incoming stickers arrive as `[Sticker (code …)]` markers;
  the last code per chat is cached for 30 minutes — omitting `stickerId` resends it.
  `replyTo` (a message id) is supported on sticker/location/contact sends.
- **Contacts** use the snake_case wire payload (`vcf_info` VCard signed with an
  HMAC of the bot token, or `max_info` for a MAX user id).

### Sending files (`max_send_file` tool)

Since **0.5.0** agents get a `max_send_file` tool that delivers a file into the
**current** MAX chat (the chat is bound from the session's delivery context — the
agent cannot redirect it elsewhere):

- `path` — a local file inside the agent's allowed media roots (or session
  workspace); or
- `url` — an http(s) URL, downloaded through the SSRF guard;
- `caption` — optional text sent with the file.

The file type (image/video/audio/file) is derived from the filename and uploaded via
the raw `POST /uploads` endpoint.

### Group chats

Since **0.5.0** group traffic is governed by `groupPolicy` (default `open`,
preserving pre-0.5 behavior):

- `disabled` — all group traffic is ignored;
- `allowlist` — the chat must appear in `groups` (a `"*"` entry allows any group);
  when `groupAllowFrom` is non-empty, the sender must be listed there too;
- `open` — every group the bot joins is served (a startup warning is logged).

`requireMention` (per-group → `"*"` → top-level, default `false`): the bot answers
only when @-mentioned by username or when its own message is replied to; button
presses on the bot's keyboard always count. A single group can be switched off with
`enabled: false`. Downloads are gated the same way — a dropped message never
triggers an attachment fetch.

```json
{
  "channels": {
    "max": {
      "token": "…",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["123456789"],
      "groups": {
        "-900100": { "requireMention": true },
        "-900200": { "enabled": false },
        "*": { "requireMention": true }
      }
    }
  }
}
```

### HTTP proxy

`channels.max.httpProxy` (e.g. `http://proxy.local:3128`) routes **only** MAX API
traffic (bot client, uploads, attachment downloads, probes) through an undici
`ProxyAgent`; every other plugin and channel keeps direct connections. The Минцифры CA
bundle stays in effect through the proxy (`CONNECT` + custom `requestTls.ca`). Proxy
authentication can be embedded in the URL (`http://user:pass@host:port`).

### Supported message types

| Type | Incoming | Outgoing | Notes |
|------|----------|----------|-------|
| Text | ✅ | ✅ | Markdown, chunked at 4000 chars |
| Images | ✅ | ✅ | Saved to media store, analyzed via imageModel; remote image URLs attach by link (no re-upload) |
| Audio/Voice | ✅* | ⚠️ | Transcribed via gateway STT (`tools.media.audio`). *Inbound voice notes verified from iOS via polling; Android may require webhook mode |
| Video | ✅ | ⚠️ | Saved to media store; token-only videos resolve a playback URL via `GET /videos/{token}` |
| Files | ✅ | ⚠️ | PDFs analyzed via pdfModel; agent-served files via the `max_send_file` tool |
| Polls | ❌ | — | MAX does not deliver poll events to bots at all (neither polling nor webhook) |
| Stickers | ✅ | ✅ | Incoming arrive as `[Sticker (code …)]` (cached 30 min per chat); outgoing = echo by code (`action="sticker"`) |
| Contacts | ✅ | ✅ | Incoming `[Contact: Name]`; outgoing via `sendAttachment type="contact"` |
| Locations | ✅ | ✅ | Incoming as a Yandex Maps link; outgoing via `sendAttachment type="location"` |
| Share cards | ✅ | — | Marked `[Shared: title (url)]` |
| `bot_started` | ✅ | — | Becomes `/start [payload]` |
| Forwarded | ✅ | — | Content unwrapped from `link.message`, marked `[Forwarded from …]`; media processed as usual |
| Replies | ✅ | — | Quoted original shown as `[Reply to …: "…"]` (≤200 chars) |
| Edited messages | ✅ | ✅ | `message_edited` arrives marked `[Edited]`; the bot edits its own messages via `action="edit"` |
| Keyboard buttons | ✅ | ✅ | Attach via the `message` tool `presentation` param or `channelData.maxInlineKeyboard`; presses arrive as inbound messages |
| Unknown types | ✅ | — | Marked `[Unsupported attachment: <type>]` so the agent knows something arrived |
| Group chats | ✅ | ✅ | Per-chat sessions; `groupPolicy` / `requireMention` gates |

### Outgoing media

Since **0.3.5** the plugin implements the `sendMedia` outbound adapter: the agent's
`message` tool can attach images, video, audio and files from a URL or a local path
(subject to the gateway's outbound-media access rules). Uploads go through the raw
`POST /uploads` endpoint because max-bot-api 0.2.5 drops the upload token on the
Buffer code path. Since **0.5.0** http(s) **image** URLs are attached by link
(`payload.url`, no re-upload) after a private/loopback host check; every other
remote file is still downloaded through the SSRF guard and uploaded.

Per-message send options (reply path, alongside the keyboard pattern):
`channelData.maxNotify: false` sends silently, `channelData.maxDisableLinkPreview: true`
suppresses link previews. Channel-wide defaults: `channels.max.notify` /
`channels.max.disableLinkPreview`. The core `silent` flag maps to `notify: false`
on the outbound adapter.

### Multimodal models (images & PDFs)

```json
{
  "agents": {
    "defaults": {
      "imageModel": "kimi/kimi-for-coding",
      "pdfModel": "kimi/kimi-for-coding"
    }
  }
}
```

## Development

```bash
npm run dev    # watch mode
npm run build  # build to dist/
npm test       # vitest + SDK import guard (check:sdk)
```

## Troubleshooting

### Bot is silent
- Check the token (`GET /me` is verified at startup in webhook mode)
- Without `webhookUrl` the plugin uses polling — make sure no webhook is stuck in MAX (delete it in bot settings)
- With `dmPolicy: "allowlist"`, add your MAX user ID to `allowFrom`

### Bot is silent in a group chat
- With `groupPolicy: "allowlist"` the chat id (negative) must appear in `groups` (or be covered by `"*"`), and the sender in `groupAllowFrom` when it is non-empty
- With `requireMention` the bot answers only when @-mentioned by username or replied to — check the log for `group message dropped: bot not mentioned`
- Drops are always logged: `[MAX] group message dropped: <reason> (chat=<id>)`

### A sticker action fails with "stickerId is required"
- Stickers are echo-only: pass a code from a `[Sticker (code …)]` marker of a
  recently received sticker (cached 30 minutes per chat), or have the user send a
  sticker first. There is no sticker catalog.

### Edit fails with "7 days in dialogs"
- Bot messages in dialogs can be edited within 7 days; messages with an inline
  keyboard or in groups/channels have no time limit. Deletion has no time limit.
  Bursts are capped at 2 operations per second per chat.

### Messages arrive but no replies (`GatewayDrainingError`)
- Symptom: gateway logs show `[MAX] inbound: …` followed by
  `Gateway is draining; new tasks are not accepted`. This is the OpenClaw ≥ 2026.9
  root-work admission issue described at the top of this README — update the plugin
  to ≥ 0.3.4.
- `openclaw channels status` should show `MAX Messenger default: enabled, configured, running, connected`; if it shows `not-running`, update to ≥ 0.3.4 (earlier versions never reported channel status).

### TLS errors to platform-api2.max.ru
- Update to plugin ≥ 0.2.0 (bundles the Минцифры CAs) or install them system-wide (see above)

### Context feels reset
- Daily 04:00 reset and `/new` are default OpenClaw behavior, not a bug — see "How sessions behave"
- Repeated 🧹 notices on small-context models were fixed in OpenClaw 2026.7.1 (#100621)

## License

MIT — see [LICENSE](LICENSE).

## Links

- [MAX Bot API docs](https://dev.max.ru/docs-api)
- [max-bot-api-client-ts](https://github.com/max-messenger/max-bot-api-client-ts)
- [OpenClaw](https://github.com/openclaw/openclaw)
- Issues: [github.com/AlexBessarabenko/openclaw-max-plugin/issues](https://github.com/AlexBessarabenko/openclaw-max-plugin/issues)
