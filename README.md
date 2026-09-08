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
- ✅ **Inline keyboards** — the agent attaches buttons via `channelData.maxInlineKeyboard`; button presses arrive as inbound messages and are auto-acknowledged

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

Set `webhookUrl` to the public address of your gateway's `/max/webhook` route — the plugin registers the subscription with MAX itself (`update_types: message_created, bot_started`). Set `webhookSecret` so MAX signs deliveries.

### Long polling

Leave `webhookUrl` empty — the plugin polls `GET /updates` automatically. Restarts after
transient errors use exponential backoff with jitter (5 s → 5 min, reset after a healthy
minute) and are logged as `Long polling exited unexpectedly, restarting in Ns`.

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

Since **0.5.0** the agent can attach inline keyboards to the final reply and react to
button presses. Pass buttons via the `message` tool's `channelData.maxInlineKeyboard`
(one inner array = one row):

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
- MAX limits enforced by validation: ≤ **210** buttons, ≤ **30** rows, ≤ **7** buttons
  per row (≤ **3** when the row contains a `link`-type button), link URL ≤ **2048** chars.
- The keyboard rides only the **final** message (a streaming draft is edited into the
  final text with the keyboard attached; long replies carry it on the last chunk).
- Invalid keyboards are logged and dropped — the text reply still goes out.
- `message_callback` updates arrive as regular inbound messages carrying the button
  payload as text; the callback is auto-acknowledged (`POST /answers`), so no spinner
  is left hanging on the button. Make payloads self-describing — MAX does not echo the
  button label.
- **Reply-path only:** keyboards are delivered only on the agent's reply path. The
  durable path (`openclaw message send --channel max …`) does not carry `channelData`,
  so no keyboard can be attached there.

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
| Images | ✅ | ✅ | Saved to media store, analyzed via imageModel |
| Audio/Voice | ✅ | ⚠️ | Transcribed via gateway STT (`tools.media.audio`) |
| Video | ✅ | ⚠️ | Saved to media store |
| Files | ✅ | ⚠️ | PDFs analyzed via pdfModel |
| `bot_started` | ✅ | — | Becomes `/start [payload]` |
| Forwarded | ✅ | — | Content unwrapped from `link.message`, marked `[Forwarded from …]`; media processed as usual |
| Replies | ✅ | — | Quoted original shown as `[Reply to …: "…"]` (≤200 chars) |
| Group chats | ✅ | ✅ | Per-chat sessions |

### Outgoing media

Since **0.3.5** the plugin implements the `sendMedia` outbound adapter: the agent's
`message` tool can attach images, video, audio and files from a URL or a local path
(subject to the gateway's outbound-media access rules). Uploads go through the raw
`POST /uploads` endpoint because max-bot-api 0.2.5 drops the upload token on the
Buffer code path.

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
```

## Troubleshooting

### Bot is silent
- Check the token (`GET /me` is verified at startup in webhook mode)
- Without `webhookUrl` the plugin uses polling — make sure no webhook is stuck in MAX (delete it in bot settings)
- With `dmPolicy: "allowlist"`, add your MAX user ID to `allowFrom`

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
