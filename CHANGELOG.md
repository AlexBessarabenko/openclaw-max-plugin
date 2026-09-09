# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-08

Tested with OpenClaw **2026.9.3**.

### Added

- **Inline keyboards** — the agent attaches buttons via `channelData.maxInlineKeyboard`
  (simplified `{text, url?, payload?}` rows or full wire buttons; ≤210 buttons,
  ≤30 rows, ≤7 per row); `message_callback` presses arrive as inbound messages with a
  quote of the source message and are auto-acknowledged (`POST /answers`).
- **Message actions adapter** — channel-owned actions on the shared `message` tool:
  `edit` (7 days in dialogs; no time limit with an inline keyboard or in
  groups/channels), `delete` (no time limit; ≤2 ops/sec per chat), `pin`/`unpin`
  (with optional `notify=false`), `sticker` (echo-only) and `sendAttachment`
  (native location pin, contact card with snake_case `vcf_info`/`max_info` payload,
  HMAC-signed by the bot token).
- **Sticker echo cache** — incoming sticker codes are cached per chat (30-minute TTL,
  FIFO cap of 1000 chats); `action="sticker"` without a code resends the last one seen.
- **Inbound markers** — stickers (`[Sticker (code …)]`), contacts (`[Contact: Name]`),
  locations (Yandex Maps link), share cards (`[Shared: title (url)]`) and unknown
  attachment types (`[Unsupported attachment: <type>]`) are surfaced to the agent
  instead of being silently dropped.
- **`max_send_file` agent tool** — sends a local file (confined to the agent's media
  roots) or an http(s) URL (SSRF-guarded download) into the session's current MAX chat.
- **Group policies** — `groupPolicy` (`open`/`allowlist`/`disabled`), `groupAllowFrom`,
  per-group `groups` overrides with a `"*"` wildcard (`requireMention`, `enabled`),
  `requireMention` gating where a reply to the bot counts as a mention; group policy
  gates run before any attachment download.
- **Reliability** — the polling marker and dedup snapshot are persisted after each
  fully processed batch (at-least-once across restarts); sends with fresh attachments
  retry on `attachment.not.ready` (1.5 s → 4 s backoff); token-only video attachments
  resolve a playback URL via `GET /videos/{token}`.
- **`message_edited` inbound** — user edits arrive marked `[Edited]`; echoes of the
  bot's own streaming-draft edits are filtered out.
- **Pairing approval notice** — after `openclaw pairing approve --notify` the user
  receives a ✅ confirmation message in MAX.
- **Account diagnostics** — `config.inspectAccount` powers `openclaw channels status`
  with a masked token preview, policies, transport mode (webhook/polling) and proxy
  state.
- **Send options** — per-message `channelData.maxNotify` (silent) and
  `channelData.maxDisableLinkPreview`, with channel defaults `channels.max.notify` /
  `disableLinkPreview`; the core `silent` flag maps to `notify: false`.
- **Image send-by-URL** — remote image URLs attach by link (`payload.url`) without a
  re-upload, after a private/loopback host check.
- **SDK import guard** — `npm run check:sdk` verifies every imported
  `openclaw/plugin-sdk/*` subpath and named binding against the installed OpenClaw
  package and loads the built entry points; wired into `npm test`.

### Changed

- OpenClaw dev dependency: 2026.7.1 → **2026.9.3**; deprecated plugin-sdk subpaths
  (`channel-lifecycle`, `channel-reply-pipeline`) migrated to `channel-outbound`.
- The pairing adapter is now a full adapter with `notifyApproval` (previously the
  approval notification reused the challenge text).

### Security

- All remote fetches (inbound attachments, outbound media by URL, `max_send_file`)
  go through the OpenClaw SSRF guard.
- Local file sends are confined to the gateway's media roots.
- DM/group access gates run before any attachment download or disk write.
- Attachment limits: at most 10 per message, 25 MB each; oversized downloads abort
  before buffering.

### Fixed

- **Reply-path media delivery** — payloads carrying `mediaUrl`/`mediaUrls` (TTS audio
  from the media store, tool attachments) are uploaded and sent; the text-only path
  previously swallowed them.
- **Voice (TTS) delivery** — at most one audio per turn: the `tts` tool result and the
  auto-TTS supplement no longer deliver the same spoken reply twice (the tool copy can
  arrive without the voice markers, so the dedup is marker-independent). Voice payloads
  go out as audio only — MAX renders an auto-transcript, so a text copy is suppressed;
  when TTS replies are enabled (`tts.auto` ≠ `off`) any reply-path audio is treated as
  the spoken reply and the streaming draft is skipped/deleted instead of flickering.
  Plain text fallback when synthesis failed. Honors the agent's own `tts.auto` mode.
- **Inline keyboards via the `message` tool** — the channel now implements the
  `prepareSendPayload` action hook: core's `executeSendAction` drops payloads that carry
  only `channelData` unless the plugin prepares them, which silently stripped
  `maxInlineKeyboard` on tool sends. Both syntaxes now work on every path:
  `presentation.blocks[].buttons` (preferred; the channel declares the `presentation`
  capability) and `channelData.maxInlineKeyboard`.
- **Callback acknowledgement** — `answerOnCallback` sends a zero-width-space
  notification; the MAX API rejects a truly empty answer (400), leaving the button
  spinner running.

## [0.4.0] - 2026-09-05

### Added

- **Streaming draft replies** — partial model output edits a single draft message in
  place; the final reply replaces it (`channels.max.streaming: false` disables).
- **`user:<id>` delivery targets** — address a user directly via `sendMessageToUser`.
- **Scoped HTTP proxy** — `channels.max.httpProxy` routes only MAX API traffic.
- **Agent prompt hints** — MAX Markdown rules, 4000-char limit and target syntax are
  taught to the agent via `agentPrompt`.

[0.5.0]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AlexBessarabenko/openclaw-max-plugin/releases/tag/v0.4.0
