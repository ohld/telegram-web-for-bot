# Telegram WebBot Porting Notes

Date: 2026-06-14.

Purpose: portable notes for rebuilding the bot-token web client in another Telegram Web codebase, such as Telegram Web A. This file intentionally avoids Telegram Web K-specific implementation details unless they explain an observed behavior.

## Core Product Reality

A bot-token web client cannot be implemented by simply replacing Telegram user login with bot-token login.

Bot-token MTProto authorization works, but the resulting account is not a normal Telegram user account. Many methods used by Telegram Web clients are user-client methods and return `BOT_METHOD_INVALID` for bot sessions.

The official Bot API is useful, but it also does not expose a full Telegram-client surface:

- No complete dialog list equivalent.
- No "list all chats where this bot exists" endpoint.
- No arbitrary `getHistory(chat)` endpoint.
- No full old backlog retrieval for every chat.

Official Bot API reference: https://core.telegram.org/bots/api

Important Bot API update constraint: Bot API updates are a delivery queue, not permanent history. Telegram currently documents that incoming updates are retained only for a limited time, not as a full chat archive.

## Recommended Build Order

Do not start with media, reactions, gifts, avatars, profile panes, or Telegram-Web parity.

Build in this order:

1. Bot-token login.
2. Bot session persistence, self-user hydration, and bot-mode flag.
3. `updates.getState` initialization.
4. Dialog discovery from MTProto updates.
5. Open one known chat and render locally known text messages.
6. Targeted chat/channel sync when a chat is opened.
7. Simple text send to known peers.
8. Known-message refresh by id.
9. Media/files.
10. Reactions.
11. Gifts/stars.
12. Wider UI parity.

## Bot MTProto Method Matrix

This matrix is empirical from the current Web K spike and should be re-probed in the new project. It is still the best current knowledge to carry over.

### Works Or Appears Useful

| MTProto method | Bot-token status | Notes |
| --- | --- | --- |
| `auth.importBotAuthorization` | Works | Primary bot-token MTProto login. |
| `users.getUsers(inputUserSelf)` | Works | Hydrates the bot's own user record. |
| `updates.getState` | Works | Required before difference-based sync. |
| `updates.getDifference` | Works, bounded | Main source for update-derived dialogs/messages. Not full history. |
| `updates.getChannelDifference` | Works for known channels in current probe | Use when opening a known channel/supergroup. Needs correct/persisted channel `pts`. |
| `contacts.resolveUsername` | Works in current probe | Useful to seed known users/channels by username. |
| `messages.sendMessage` | Works for known peers | Requires known peer/access hash where applicable. |
| `messages.getMessages` | Partially useful | Can refresh known message ids. Not a history listing API. |
| `channels.getMessages` | Partially useful | Same idea for known channel message ids. |
| `help.getConfig` | Works in probe | Basic config is safe enough. |

### User-Client Methods That Failed For Bot Sessions

These are normal Telegram Web user-account methods, but bot-token sessions returned `BOT_METHOD_INVALID` in the current spike/probes.

| MTProto method / family | Expected bot result | Replacement strategy |
| --- | --- | --- |
| `messages.getDialogs` | `BOT_METHOD_INVALID` | Build local dialog list from `updates.getDifference`; optionally seed known peers by username. |
| `messages.getPeerDialogs` | `BOT_METHOD_INVALID` | Use local dialog storage or refresh known peer via updates/known-message APIs. |
| `messages.getHistory` | `BOT_METHOD_INVALID` | No full replacement. Render update-derived local cache; do targeted update sync. |
| `contacts.getContacts` | `BOT_METHOD_INVALID` | Hide contacts UI or return empty decorative state. |
| `contacts.search` | `BOT_METHOD_INVALID` | Use `contacts.resolveUsername` for explicit username lookup only. |
| `contacts.getTopPeers` | `BOT_METHOD_INVALID` / irrelevant | Hide top peers/recent contacts in bot mode. |
| `messages.receivedMessages` | `BOT_METHOD_INVALID` | No-op local acknowledgement only; do not expose user read-receipt semantics. |
| `messages.setTyping` | User-client behavior | No-op or use a Bot API equivalent only where one exists. |
| `messages.getAvailableReactions` and related reaction list APIs | Invalid/unsafe | Use Bot API reaction methods where possible. |
| `messages.sendReaction` | Invalid in current client path | Use Bot API `setMessageReaction` for known chat/message ids. |
| `account.*` settings/privacy/themes/passkeys | User-account surface | Hide or disable in bot mode. |
| `stories.*` | User-account surface | Hide stories in bot mode. |
| `payments.*` user payments/gifts | Mostly invalid for bot mode | Use Bot API stars/gifts methods instead. |
| `messages.getAllDrafts`, `messages.saveDraft` | User-account state | Ignore or store local-only drafts if needed. |
| `messages.getAllStickers`, `messages.getSavedGifs`, sticker account state | User-account/decorative | Disable initially. |
| `help.getAppConfig`, `help.getNearestDc` | Observed invalid or unnecessary in bot mode | Prefer local fallback unless proven needed. |

### Probe Before Using

| Area | Why |
| --- | --- |
| `messages.sendMedia` | Text send success does not prove media send success. Needs access-hash and upload/file checks. |
| `messages.editMessage` | May work in specific bot-owned contexts, but should be probed per peer/message. |
| Admin/channel methods | Bot permission and MTProto bot support vary by method. Probe one method at a time. |
| Forum/topic methods | Do not assume user-account behavior maps to bot sessions. |
| File/media download via `upload.getFile` | Current spike saw `AUTH_KEY_UNREGISTERED` on foreign DC for photo/file downloads. Needs separate DC auth investigation. |

## Dialog And History Model

The working model is not `getDialogs + getHistory`.

The bot-mode model should be:

```text
bot login
  -> users.getUsers(inputUserSelf)
  -> updates.getState
  -> updates.getDifference
  -> save users/chats/messages locally
  -> derive dialog list from local update storage
  -> on chat open: render local cache immediately
  -> in background: peer-specific sync
  -> merge new updates into local storage
  -> notify UI to re-render
```

For channels/supergroups:

```text
known channel peer
  -> read persisted channel pts
  -> updates.getChannelDifference(channel, pts)
  -> save users/chats/messages/other_updates
  -> persist new channel pts
  -> notify UI
```

Key constraints:

- A bot can only show chats/messages it has learned from updates, explicit peer resolution, or known message ids.
- Local IndexedDB/cache can make reloads look better, but it is not Telegram server history.
- A clean browser profile may have much less visible history.
- `updates.differenceTooLong` means the client cannot assume it can recover the entire missing range. Use Telegram's returned `pts` as the reset point; do not probe older ranges in a retry loop.
- Do not mark update-derived local history as complete server history.

## Known Failure Pattern From Web K Spike

Current Web K spike likely mixed too many concerns:

- auth routing,
- bot session storage,
- user-account startup fallbacks,
- update-derived dialogs,
- chat history override,
- reactions,
- gifts,
- avatar/media guards,
- file DC auth,
- UI profile/sidebar guards.

That made debugging hard. In the new project, keep these slices separate.

## Critical Sequencing Hypothesis

The bot client likely needs an explicit bot sync pipeline. Reusing the user-account Telegram Web startup order can trigger methods before bot-derived local state is ready.

Failure shape to watch:

```text
bot auth succeeds
  -> UI starts rendering
  -> user-account preload methods fire
  -> dialog list is still incomplete
  -> chat open calls history before peer sync/storage is ready
  -> media/avatar downloads start in parallel
  -> errors appear unrelated, but root cause is ordering
```

Suggested dev instrumentation:

- log bot auth complete,
- log self-user hydration,
- log `updates.getState`,
- log each `updates.getDifference` request/result,
- log each `updates.getChannelDifference` request/result with peer id and pts,
- log local dialog creation,
- log chat-open local render,
- log background sync completion,
- collect `BOT_METHOD_INVALID` with method name and UI surface,
- collect repeated `AUTH_KEY_UNREGISTERED upload.getFile` by file location/DC.

## Media/File Warning

Observed in the Web K spike:

```text
401 AUTH_KEY_UNREGISTERED ... upload.getFile ... inputPhotoFileLocation
```

Treat this as a safety issue if it repeats. It is not a normal bot-method invalid error.

Before enabling heavy media/avatar/profile rendering:

1. Verify foreign DC authorization for bot sessions.
2. Add a retry limit for 401 foreign-DC recovery.
3. Add temporary suppression for identical failed file locations.
4. Avoid opening profile/media-heavy UI while debugging core inbox behavior.

The App ID/hash was probably not the direct cause in the old spike because localhost already had `VITE_API_ID` and `VITE_API_HASH`, and MTProto auth/updates worked.

## Bot API Fallbacks To Carry Forward

Use Bot API when it directly supports the feature:

| Feature | Bot API method(s) | Notes |
| --- | --- | --- |
| Bot identity | `getMe` | Useful sanity check for token. |
| Bot updates | `getUpdates` / webhook | Event queue, not history. |
| Chat metadata | `getChat` | Works for known chats. Not a global chat list. |
| Chat admins/member info | `getChatAdministrators`, `getChatMember` | Requires known chat and permissions. |
| Reactions | `setMessageReaction`, related newer reaction methods | Use only for known chat/message ids. |
| Stars balance | `getMyStarBalance` | Bot-specific stars balance. |
| Available gifts | `getAvailableGifts` | Bot gift catalog. |
| Send gift | `sendGift` | Side-effecting; test manually. |
| Send messages/media | `sendMessage`, `sendPhoto`, etc. | Bot API path can be simpler than MTProto for bot-owned sends. |

Do not fake full server results through Bot API:

- no fake full dialog list,
- no fake old chat history,
- no fake successful write when Bot API call failed.

## UI Policy

In bot mode:

- Hide unsupported user-account surfaces.
- Return empty/default only for decorative preload.
- For visible actions, either implement a real bot-specific path or show unsupported.
- Do not let user-client errors drive the main UX.
- Keep the first product goal narrow: read chats, open chat, read text messages.

## What To Copy Into The New Repo

Copy these docs first:

- `docs/telegram-webbot-porting-notes.md`
- `docs/bot-mtproto-overrides.md`
- `docs/bot-mode-triage-snapshot-2026-06-14.md`

Then rebuild the implementation from a clean baseline rather than copying the entire Web K dirty diff.
