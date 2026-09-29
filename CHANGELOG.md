# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-09-29

### Added

- **Markdown tables in plain replies render aligned.** GitHub-style pipe tables
  in outbound text are rewritten as monospace ``` blocks with columns aligned
  by display width (MAX markdown has no table syntax, so raw pipes rendered
  misaligned). Applies to replies, streaming drafts and the `message` tool;
  content already inside code fences is untouched.

## [0.6.0] - 2026-09-29

### Added

- **Platform voice transcription wins over gateway STT.** When a MAX audio
  attachment already carries a server-side `transcription` (schema 0.0.33), it
  is used directly and the gateway STT call is skipped. Downloads of
  attachments get one retry on transient network failures.
- **Outbound rate limiting.** A per-chat sliding-window limiter (2 messages per
  second, the MAX platform limit) with FIFO queueing now covers every send
  path: replies, streaming drafts, media/albums, stickers, pairing notices.
  Edits, typing/read receipts and callback answers are not throttled.
- **Webhook watchdog.** In webhook mode the subscription is re-verified every
  12 minutes and transparently re-created (with the same URL/secret/update
  types) when MAX dropped it.
- **`channels.max.markSeen`** (default `true`) — the bot sends a `mark_seen`
  read receipt once per inbound message, next to the typing indicator.
- **`channels.max.commands`** — declarative bot-command registration
  (`PATCH /me/commands`, up to 32 commands) applied at channel start.
- **Structured mentions.** In groups with `requireMention`, a `user_mention`
  element in `body.markup` referencing the bot by user id or `@user_link`
  counts as a mention even when the visible text has no plain `@username`.
- **Media albums.** Several attached images/videos are grouped into one album
  message (up to 12, the MAX limit); audio and files always send individually.
  The `message` tool result carries every sent message id
  (`meta.messageIds`).
- **Full presentation rendering.** `select` blocks render as inline buttons
  (two per row, `placeholder` as an italic prompt); tables and charts render
  as aligned monospace blocks; `presentation.title` renders bold with a tone
  emoji (`info` ℹ️ / `success` ✅ / `warning` ⚠️ / `danger` ⛔). Presentation
  buttons carry private callback envelopes: opaque values arrive labelled
  `callback_data: <value>`, commands re-enter as slash commands.
- **Operator buttons.** Presentation `approval` and ask-user `question` actions
  resolve through OpenClaw's canonical approval/question gateway runtimes and
  never enter the agent pipeline; the keyboard message is replaced with a
  status line so a resolved control cannot be pressed twice. Approvals require
  the pressing user to be listed explicitly in `channels.max.allowFrom` (a `*`
  wildcard suffices for questions only).
- **All MAX button wire types**: `callback`, `link`, `clipboard`, `message`
  (sends the label as a user message), `request_contact`,
  `request_geo_location` (`quick` supported), `open_app` (`web_app` + optional
  slug `payload`/`contact_id`). Field limits validated against the schema
  (label ≤ 128 chars, callback payload ≤ 1024 bytes, link URL ≤ 2048 chars).
- **Schema-conformance test** against a snapshot of the official MAX API
  schema (`src/__fixtures__/max-schema-0.0.33.yaml`); refresh with
  `npm run schema:update`.

### Changed

- Pin/unpin in direct chats no longer calls the MAX API (pins are group-only):
  the action returns `{ pinned: false, reason: "pins are not supported in
  direct chats" }` instead of failing.
- Update types the channel deliberately does not handle (`bot_added`,
  `dialog_*`, `comment_*`, chat-administration events) are noted once per type
  at debug level instead of vanishing silently.
- Dev SDK bumped to OpenClaw 2026.9.6.

## [0.5.3] - 2026-09-09

### Security

- **Moderation message actions are now scoped to policy-admitted chats.**
  `edit` / `delete` / `pin` / `unpin` / `sticker` / `sendAttachment` could
  previously target ANY chat the bot sits in, so a prompt injection in one
  chat could act on another. Dialogs (DMs) stay open; group/channel chats
  must pass the channel's group policy (`groupPolicy` / `groups`, shared with
  the inbound gate via `src/chat-policy.ts`). `edit`/`delete` resolve the
  message's chat via `GET /messages/{mid}` (`recipient.chat_type`/`chat_id`,
  cached per process) and refuse to run when the chat cannot be resolved
  (fail-closed). Explicit chat targets are typed by the MAX id convention
  (positive = dialog, negative = group/channel) without extra API calls.

## [0.5.2] - 2026-09-09

### Added

- `channels.max.logInboundPreview` (default `false`) — opt back into logging a
  50-char preview of inbound message text for debugging; by default the inbound
  log carries metadata only (chat id, type, sender id, text length).

## [0.5.1] - 2026-09-09

### Changed

- The inbound info log no longer includes a message-text preview — only chat id,
  chat type, sender id and text length are logged (`[MAX] inbound: chat=…
  type=… from=… chars=…`), so message content stays out of the gateway log.

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

[0.6.1]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/AlexBessarabenko/openclaw-max-plugin/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AlexBessarabenko/openclaw-max-plugin/releases/tag/v0.4.0
