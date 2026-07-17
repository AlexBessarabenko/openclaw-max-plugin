# OpenClaw MAX Messenger Plugin

Channel plugin connecting OpenClaw to [MAX Messenger](https://max.ru) — Russian messaging platform.
Tested with OpenClaw **2026.7.1**, MAX Bot API v2 (`platform-api2.max.ru`).

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

`platform-api2.max.ru` uses a certificate chained to the Russian national root CA
(Минцифры / "Russian Trusted Root CA"), which Node.js does not trust out of the box.
The plugin ships the required PEM files in `certs/` and installs them at startup via
`tls.setDefaultCACertificates` (Node ≥ 22.15) — no manual steps needed.

On older Node versions, install the certificates system-wide:

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

Leave `webhookUrl` empty — the plugin polls `GET /updates` automatically.

### Supported message types

| Type | Incoming | Outgoing | Notes |
|------|----------|----------|-------|
| Text | ✅ | ✅ | Markdown, chunked at 4000 chars |
| Images | ✅ | ✅ | Saved to media store, analyzed via imageModel |
| Audio/Voice | ✅ | ⚠️ | Transcribed via gateway STT (`tools.media.audio`) |
| Video | ✅ | ⚠️ | Saved to media store |
| Files | ✅ | ⚠️ | PDFs analyzed via pdfModel |
| `bot_started` | ✅ | — | Becomes `/start [payload]` |
| Group chats | ✅ | ✅ | Per-chat sessions |

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
