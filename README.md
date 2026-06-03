# OpenClaw MAX Messenger Plugin

Plugin for connecting OpenClaw to [MAX Messenger](https://max.ru) — Russian messaging platform with 30+ million users.
Tested with OpenClaw 2026.5.28

## Features

- ✅ Two-way messaging (receive and send)
- ✅ Markdown formatting support
- ✅ Webhook primary + Long Polling fallback
- ✅ DM security with allowlist
- ✅ Pairing/approval flow for new contacts
- ✅ Session persistence
- ✅ Works with both direct messages and group chats
- ✅ **Media support** — handles images, audio, video, and file attachments
- ✅ **Audio transcription** — voice messages are transcribed via Groq Whisper API
- ✅ **Message deduplication** — prevents duplicate processing from webhook + polling overlap
- ✅ **Typing indicator**
- ✅ **PDF document analysis** — PDF files are processed via configured PDF model
- ✅ **Image analysis** — photos are analyzed via configured image model (multimodal)

## Installation

### Via npm (Recommended)

```bash
openclaw plugins install alexbessarabenko-openclaw-max
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

Add to your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "channels": {
    "max": {
      "token": "YOUR_MAX_BOT_TOKEN",
      "dmPolicy": "allowlist",
      "allowFrom": ["123456789"]
    }
  }
}
```

Or set environment variable:
```bash
export MAX_BOT_TOKEN=***
```

For audio transcription, also set:
```bash
export GROQ_API_KEY=***
```

### Multimodal Models (Images & PDFs)

To enable image and PDF analysis, configure multimodal-capable models in your OpenClaw config:

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

Supported models:
- `kimi/kimi-for-coding` — Kimi (Moonshot AI), supports images and PDFs
- `openrouter/auto` — Auto-selected multimodal model via OpenRouter
- Other OpenRouter multimodal models

### Getting a Bot Token

1. Go to [MAX for Partners](https://partners.max.ru)
2. Create a new bot
3. Copy the token from bot settings

## Usage

Once configured, the bot will:
- Receive messages from MAX users (text, images, audio, video, files)
- Transcribe voice messages to text via Groq Whisper
- Analyze images and PDFs via configured multimodal models
- Process them through OpenClaw agent
- Send replies back to MAX

### Webhook Setup (Recommended)

1. Register webhook URL in MAX bot settings:
   ```
   https://your-openclaw-instance/max/webhook
   ```
2. The plugin automatically uses webhook mode if the health check passes
3. Falls back to Long Polling if webhook is unavailable

### Supported Message Types

| Type | Incoming | Outgoing | Notes |
|------|----------|----------|-------|
| Text | ✅ | ✅ | Markdown formatting |
| Images | ✅ | ✅ | Analyzed via imageModel (multimodal) |
| Audio/Voice | ✅ | ⚠️ | Transcribed via Groq Whisper |
| Video | ✅ | ⚠️ | Received as placeholder |
| Files | ✅ | ⚠️ | PDFs analyzed via pdfModel |
| Group chats | ✅ | ✅ | Basic support |

## Architecture

```
MAX User → MAX API → Webhook/Polling → OpenClaw Plugin → Agent → Reply → MAX API → User
                              ↓
                    [Audio] → Groq Whisper → Text
                    [Image] → Image Model (Kimi, etc.)
                    [PDF]   → PDF Model (Kimi, etc.)
```

## API Reference

### Webhook Endpoint

Default webhook path: `/max/webhook`

Configure in MAX bot settings to point to your OpenClaw instance.

### Audio Transcription

Voice messages are automatically:
1. Downloaded from MAX servers
2. Sent to Groq Whisper API (`whisper-large-v3`, Russian language)
3. Transcribed text appended to message as `[Voice]: <transcription>`

Requires `GROQ_API_KEY` environment variable.

### Image Analysis

Photos are automatically:
1. Downloaded from MAX servers (via `payload.ls[0]` or `payload.url`)
2. Passed to configured `imageModel` (e.g., `kimi/kimi-for-coding`)
3. Analyzed with prompt "Что изображено на фото?"

### PDF Analysis

PDF files are automatically:
1. Downloaded from MAX servers (via `payload.url`)
2. Passed to configured `pdfModel` (e.g., `kimi/kimi-for-coding`)
3. Text extracted and analyzed

### Message Deduplication

The plugin maintains an in-memory deduplication cache (5-minute TTL) to prevent processing the same message twice when both webhook and polling are active during fallback transitions.

### MAX Attachment Payload Structures

The plugin handles different MAX API payload structures:

**Images:**
```json
{
  "type": "image",
  "payload": {
    "photo_id": 12345,
    "token": "***",
    "ls": ["https://i.oneme.ru/i?r=..."]
  }
}
```

**Files:**
```json
{
  "type": "file",
  "payload": {
    "url": "https://fd.oneme.ru/getfile?sig=...",
    "token": "***",
    "fileId": 12345,
    "filename": "document.pdf",
    "size": 123456
  }
}
```

**Audio:**
```json
{
  "type": "audio",
  "payload": {
    "url": "https://...",
    "token": "***"
  }
}
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build
```

## Troubleshooting

### No image/PDF analysis
- Check that `imageModel` and `pdfModel` are configured in OpenClaw config
- Verify the model supports multimodal input (images + text)
- Check logs for `[tools] image failed: No image model is configured`

### Audio not transcribed
- Verify `GROQ_API_KEY` is set
- Check Groq API limits and availability

### Duplicate messages
- Deduplication is automatic (5-min TTL)
- Check logs for `Duplicate message ... ignored`

### Webhook not working
- Ensure webhook URL is accessible from internet
- Check firewall/proxy settings
- Plugin falls back to polling automatically

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License — see [LICENSE](LICENSE) file.

## Links

- [MAX API Documentation](https://dev.max.ru/docs-api)
- [MAX Bot SDK](https://github.com/max-messenger/max-bot-api-client-ts)
- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Groq Whisper API](https://console.groq.com/docs/speech-text)
- [Kimi](https://kimi.com)

## Support

- GitHub Issues: [github.com/AlexBessarabenko/openclaw-max-plugin/issues](https://github.com/AlexBessarabenko/openclaw-max-plugin/issues)
- MAX Developer Community: [dev.max.ru](https://dev.max.ru)

---

Made with ❤️ for the OpenClaw community
