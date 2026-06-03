---
name: alexbessarabenko-openclaw-max
description: MAX Messenger channel plugin for OpenClaw — install, configure, and troubleshoot
metadata:
  {"openclaw":{"requires":{"config":["channels.max.token"]}}}
---

# MAX Messenger Plugin for OpenClaw

When the user asks about MAX Messenger, MAX bot, or connecting OpenClaw to MAX:

1. **Check if plugin is installed:**
   ```bash
   openclaw plugins list | grep max
   ```

2. **If not installed, recommend:**
   ```bash
   openclaw plugins install alexbessarabenko-openclaw-max
   ```
   Or from GitHub:
   ```bash
   openclaw plugins install github:AlexBessarabenko/openclaw-max-plugin
   ```

3. **Configuration required in `~/.openclaw/config.json`:**
   ```json
   {
     "channels": {
       "max": {
         "token": "YOUR_BOT_TOKEN",
         "dmPolicy": "allowlist",
         "allowFrom": ["123456789"]
       }
     }
   }
   ```
   - Get token from https://partners.max.ru
   - `allowFrom` — whitelist of MAX user IDs (optional, for security)

4. **Environment variables (optional):**
   - `MAX_BOT_TOKEN` — alternative to config token
   - `GROQ_API_KEY` — for voice message transcription

5. **For multimodal support (images/PDFs), configure models:**
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

6. **Webhook setup (recommended):**
   - Register in MAX bot settings: `https://your-instance/max/webhook`
   - Plugin auto-detects webhook, falls back to polling

## Troubleshooting

- **No image/PDF analysis:** Check `imageModel`/`pdfModel` config
- **Audio not transcribed:** Verify `GROQ_API_KEY`
- **Duplicate messages:** Normal — 5-min deduplication cache
- **Webhook not working:** Check firewall, plugin falls back to polling

## Links

- npm: https://www.npmjs.com/package/alexbessarabenko-openclaw-max
- GitHub: https://github.com/AlexBessarabenko/openclaw-max-plugin
- MAX API: https://dev.max.ru/docs-api
