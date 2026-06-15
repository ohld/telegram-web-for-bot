# Bot MTProto Overrides

This file tracks deliberate differences from upstream Telegram Web K for bot-token MTProto accounts.

Bot login uses `auth.importBotAuthorization` and stores the resulting MTProto session plus per-account `isBot` and `botToken` fields. The token is stored only in the local browser account slot so Bot API fallbacks keep working after refresh; it must never be logged, committed, or placed in source files.

## Flood Safety

Telegram bot-token login should behave like other MTProto clients: restore the saved DC/auth key first, and call `auth.importBotAuthorization` only when no valid bot session is available. Official Telegram docs describe `FLOOD_WAIT_X` as too many attempts for a method with given input parameters, but they do not publish a precise scope for bot-token login such as token-only, API-id-only, or IP-only. Treat the scope as unknown and conservative.

If bot import returns `FLOOD_WAIT_X`, store only a local wait-until timestamp and block further token submissions until it expires. Do not retry, do not sleep-and-retry, and do not test alternate tokens during the cooldown unless there is a separate reason to believe the wait is isolated to the original token. Clear the local cooldown only after a successful bot authorization.

The browser account slot stores the bot token after successful login because Bot API fallbacks need it later. This intentionally differs from server-side MTProto libraries like Telethon, which only persist the MTProto session and do not need a browser-side Bot API token fallback. MTProto restore must not require the token, because the saved DC/auth key is enough to avoid re-importing the token. During a submitted bot login, keep the token pending in memory until both bot self-lookup has succeeded and a non-empty auth-key session has been saved. Only then mark the slot `isBot=true` and store the token. This prevents a refresh from missing the restored-session path and accidentally re-importing the token.

The stored bot token is not a hidden MTProto restore credential. If the saved auth key is missing or invalid, prefer returning to the bot-token screen over automatically re-submitting the stored token. After a timeout or transport break during `auth.importBotAuthorization`, first check whether the session became authorized before asking for another deliberate token submission.

## Current Working Model

Telegram bot-token login is a real MTProto authorization, but the resulting account is not a normal Telegram user account. Some MTProto methods still work for bots, especially authorization, self lookup, update state/difference, username resolution, and sending to known peers. Many user-client methods return `BOT_METHOD_INVALID`.

The official Bot API does not expose a method to list all chats containing the bot, nor a method to fetch arbitrary message history for a chat. The current implementation therefore builds a local inbox from MTProto updates:

1. Restore an existing bot MTProto session, or authenticate the bot once with `auth.importBotAuthorization`.
2. Initialize update state with `updates.getState`.
3. Scan available updates with `updates.getDifference`.
4. Save returned `users`, `chats`, and `new_messages`.
5. Convert each returned message into `updateNewMessage` or `updateNewChannelMessage`.
6. Let tweb's normal update pipeline create dialogs and message storage from those updates.
7. For known channels, use `updates.getChannelDifference` as an additional recent-sync path.

The initial bot difference scan is deliberately bounded. It starts from the earliest possible update state, consumes returned `updates.differenceSlice` pages, and stops on time, iteration, or message-count limits instead of retrying indefinitely. If Telegram returns `updates.differenceTooLong`, follow the documented path: use the returned `pts` as the reset point once, then stop if Telegram still reports the gap as too long. Do not binary-search older `pts` ranges, because that creates extra requests and still cannot guarantee historical recovery.

Channel/supergroup catch-up is also bounded. `updates.getChannelDifference` processes a small number of pages per burst and backs off before continuing if Telegram still reports more pages. This avoids unbounded catch-up loops on busy known channels while preserving incremental progress.

Bot mode does not run Telegram Web's normal full dialog sync after a difference gap. Normal sync is based on `messages.getDialogs` and `messages.getHistory`; for bots those calls are unavailable and can also wipe update-derived local messages when refresh results are empty. Bot sync therefore marks the client as synced and keeps the existing update-derived cache intact.

This is not equivalent to `messages.getDialogs` plus `messages.getHistory`. It is an update-derived cache. Telegram can return `updates.differenceTooLong`, and old updates are not guaranteed to remain available forever. A browser reload should keep messages that were already saved into local IndexedDB for this account/profile, but a clean profile or cleared storage will lose that local cache. Messages older than the update window may be impossible to recover through this approach unless another allowed MTProto or Bot API path is found for that exact peer/message.

## Observed Bot MTProto Matrix

This matrix is based on the local capability probe in `src/tests/api/botTokenCapability.test.ts`, browser behavior from the current POC, and targeted code audits. Treat it as empirical, not a formal Telegram contract.

| MTProto method / family | Bot-token status | Current use or action |
| --- | --- | --- |
| `auth.importBotAuthorization` | Works | Primary bot-token login. Foreign DC bot authorization is still a follow-up for this Web A port. |
| `users.getUsers(inputUserSelf)` | Works | Hydrates the bot's own user record after login/reload. |
| `updates.getState` | Works | Initializes `pts`, `qts`, `date`, `seq` before difference scans. |
| `updates.getDifference` | Works, bounded by update availability | Primary source for update-derived dialogs and recent message cache. |
| `updates.getChannelDifference` | Works for known channel peers in current POC | Used for recent channel sync when the channel is already discovered and has input data. |
| `contacts.resolveUsername` | Works in live probes | Can seed known users/channels by username when update-derived discovery is insufficient. |
| `messages.sendMessage` | Works for known peers | Text send works when the peer is update-derived or explicitly resolved and has access hash where required. |
| `messages.getMessages` | Partially useful for known message ids | Can refresh known messages/reactions by id; not a history listing API. |
| `channels.getMessages` | Partially useful for known channel message ids | Same as above, channel-specific. Requires known channel input. |
| `help.getConfig` | Works | General config is safe enough to keep. |
| `messages.getDialogs` | `BOT_METHOD_INVALID` | Replaced by update-derived dialogs from `BotDialogsManager`. |
| `messages.getPeerDialogs` | `BOT_METHOD_INVALID` | Replaced by local dialog lookup/reload. |
| `messages.getHistory` | `BOT_METHOD_INVALID` | Replaced by local update-derived history only. No full backlog. |
| `contacts.getContacts`, `contacts.search`, `contacts.getTopPeers` | `BOT_METHOD_INVALID` or user-state only | Return empty local lists in bot mode. |
| `help.getNearestDc`, `help.getAppConfig`, peer color helpers | Observed invalid or unnecessary for bot mode | Use local/empty fallbacks where possible. |
| `account.*` user settings, privacy, themes, passkeys | User account surface | Disable or guard in bot mode. Do not fake success for visible writes unless UI cannot reach it. |
| `messages.receivedMessages`, read receipts, typing, scheduled messages | User-client surface | No-op or hide in bot mode. |
| `messages.sendReaction`, reaction list/tag/effect APIs | Invalid for bot use in this client | Use Bot API `getChat` and `setMessageReaction` where possible; avoid optimistic-only success. |
| `payments.*` gifts/stars APIs | Mostly user-client invalid for bot mode | Use Bot API `getMyStarBalance`, `getAvailableGifts`, `sendGift` for bot gifts. |
| `stories.*` user story APIs | User-client surface | Return empty state and hide/disable story UI. |
| `messages.sendMedia`, `messages.editMessage`, grouped/media paths | Not fully proven | Must reuse the same known-peer/access-hash preflight as text send before enabling broadly. |
| Admin/channel management methods | Unknown per method | Probe individually. Do not assume either user-client docs or Bot API docs fully describe MTProto bot behavior. |

## Dialog And History Discovery

The old `tweb` spike used `BotDialogsManager` for this flow. This Web A port keeps the same bounded update-derived model inside `src/api/gramjs/updates/updateManager.ts`.

Initial scan:

```text
BotDialogsManager.start()
  -> apiManager.setUpdatesProcessor(apiUpdatesManager.processUpdateMessage)
  -> scanInitialDialogs()
  -> updates.getDifference({pts: 1, qts: -1, date: 1, pts_total_limit})
  -> save users/chats
  -> messageToUpdate(message)
  -> apiUpdatesManager.saveUpdate(updateNewMessage/updateNewChannelMessage)
  -> appMessagesManager stores messages and creates local dialogs
```

Recent chat open sync:

```text
appMessagesManager.getHistory(bot mode)
  -> botDialogsManager.syncRecentUpdatesForPeer(peerId)
  -> if known channel: updates.getChannelDifference(...)
  -> also scan recent global windows via updates.getDifference(...)
  -> return local history slice from IndexedDB/in-memory storage
```

Important consequences:

- A chat can appear only after the bot receives or recovers at least one update for that peer.
- A chat's visible history is only the messages currently in local tweb storage.
- Opening a chat currently marks local bot history as ended (`SliceEnd.Both`), so the UI will not keep paginating for older messages.
- If the bot was added to a chat long ago and no recoverable updates remain, this POC may not discover that chat.
- If Telegram returns `updates.differenceTooLong`, reset to Telegram's returned `pts` at most once. This can keep the client current, not recover full history.
- Reloading the same browser profile should keep already-saved local messages. Clearing site data, using another profile, or starting from a new account slot loses that local cache.

## Bot API Fallbacks

Use Bot API only for features it actually exposes. The current useful fallbacks are:

| Feature | Bot API method(s) | Notes |
| --- | --- | --- |
| Bot Stars balance | `getMyStarBalance` | Official Bot API. Safe read-only fallback for the bot's own Stars balance. |
| Available gifts | `getAvailableGifts` | Official Bot API. Returns gifts that can be sent by the bot. |
| Send gift | `sendGift` | Official Bot API. Supports `user_id` or channel `chat_id`, but not arbitrary group history discovery. |
| Reactions | `getChat`, `setMessageReaction` | Can set a bot reaction on a known message. Must avoid permanent local overlay if the API call fails. |

Bot API still does not provide:

- `getDialogs` equivalent.
- `getHistory(chat)` equivalent.
- Arbitrary old message fetch by chat.
- Voting in an existing poll as the bot.
- Adding an option to an existing poll as the bot.

Official reference: https://core.telegram.org/bots/api

## Invalid Method Triage

When browser console shows `BOT_METHOD_INVALID`, classify it immediately:

| Bucket | Action |
| --- | --- |
| Startup/preload/decorative method | Guard in manager and return empty/default local data. |
| Visible UI feature backed by user-only method | Hide or disable the UI in bot mode. |
| Feature with Bot API equivalent | Route through a bot-specific manager/helper and keep token out of logs. |
| Message/chat discovery method | Do not fake a full server result. Use update-derived local cache and show limitations. |
| Write method with no Bot API equivalent | Prefer explicit unsupported UX over no-op success. |

Known invalid or high-risk methods to watch in console:

```text
messages.getDialogs
messages.getPeerDialogs
messages.getHistory
messages.receivedMessages
messages.setTyping
messages.getAvailableReactions
messages.sendReaction
contacts.getContacts
contacts.search
contacts.getTopPeers
help.getAppConfig
help.getNearestDc
account.getThemes
account.getGlobalPrivacySettings
account.getContentSettings
account.registerDevice
messages.getSavedGifs
payments.*
stories.*
```

## Debugging Rule

For future work, do not rely on raw console stack traces alone. Every `BOT_METHOD_INVALID` should be collected with at least:

- MTProto method name.
- manager method or UI surface that triggered it.
- whether it happened during startup, chat-list render, chat-open, profile/sidebar open, composer action, or popup action.
- chosen resolution: guard, hide UI, local fallback, Bot API fallback, or keep probing.

## Triage Plan

Last updated: 2026-06-14.

The immediate goal is not to make every console error disappear. It is to separate product-critical bot-mode regressions from upstream Telegram Web K noise, known Telegram API limits, and low-value decorative preload failures.

### Fix First

| Problem | Why it matters | Current diagnosis | Preferred action |
| --- | --- | --- | --- |
| Chat open can wait too long for history, or show nothing until fresh updates arrive | This is the core UX: selecting a chat must quickly show whatever the bot already knows | `appMessagesManager.getHistory()` waits for `botDialogsManager.syncRecentUpdatesForPeer()` before returning local history, then marks the local slice as fully ended | Return local cached history immediately, run peer sync in the background, then publish/reload when new messages arrive. Do not block first paint on a 6s sync. |
| Opened channel sync is not sticky enough | User-observed symptom: sometimes opening a channel does not visibly run `updates.getChannelDifference` | `syncRecentChannel()` starts from `dialog?.pts || 1`, advances local `pts`, but does not persist the new channel `pts` back into dialog/update state | Persist channel `pts` after successful `updates.getChannelDifference`; log the peer id, starting pts, result type, and new pts in dev. |
| Bot history is marked as complete even when it is only update-derived | The UI stops trying to paginate and can imply full history exists | `getBotLocalHistoryResult()` sets `SliceEnd.Both` and returns `isEnd.both=true` for the local slice | Keep a separate "local update cache exhausted" concept. Do not present it as full server history. |
| `qts` bot updates are not fully sequenced | Some bot update constructors use `qts`, so missed `qts` gaps can lose bot-specific events | The current Web A update manager stores `qts` from remote state/difference, but live `qts` updates do not have a dedicated queue | Add real `qts` gap handling. Do not just advance `qts` on gaps, because that can hide missing updates. |
| Chat open still triggers user-client participant/rank calls | These calls add noisy errors and can slow open for megagroups/channels | `ChatBubbles` loads `channelParticipantsAdmins` for ranks on megagroups | Disable rank preload in bot mode unless a specific admin feature needs it and the method is proven for that peer. |
| `BOT_METHOD_INVALID` is hard to map back to UX actions | Raw console errors are too noisy during stream/debug sessions | The worker error includes the payload, but not always the manager/UI surface in a main-window-readable list | Keep collecting method + manager description + current route/action. Treat this as instrumentation, not a user-facing fix. |

### Fix Or Revert As Self-Inflicted

| Area | Risk | Decision needed |
| --- | --- | --- |
| Auth flow maps `authStateSignIn` and `authStateSignQr` to `signBot` | This breaks the original Telegram user login surface if this branch is expected to remain a normal Telegram Web K fork | If the product is bot-only, keep it but make that choice explicit. If the fork must preserve upstream login, revert this mapping and add bot login as a separate entry point. |
| Visible writes that fake success | A user can believe an action worked when the bot/API rejected it | Hide unsupported controls or show explicit unsupported state. Only optimistic-update UI when the Bot API/MTProto call succeeds or can be reconciled. |
| Bot reaction local overlay | Can diverge from server state if Bot API fails or if MTProto refresh does not report the bot reaction | Roll back the overlay on Bot API failure and keep a clear "best effort local state" boundary. |
| Old bot sessions without token | Bot API fallbacks cannot work after refresh without the token | Keep invalidating these sessions, but document that bot tokens live only in local browser account storage. |

### Ignore Or Deprioritize For Now

| Item | Reason |
| --- | --- |
| Full arbitrary old chat history | The official Bot API has no `getHistory(chat)` equivalent, and bot MTProto rejects `messages.getHistory`. This is a platform limit, not a local bug. |
| Full list of chats containing the bot | The official Bot API has no `getDialogs` equivalent. The current list is update-derived via `updates.getDifference` plus known-peer seeding. |
| Some `getFile`/media/avatar errors | The user observed similar console noise in original Telegram Web K. Fix only if media is visibly broken in the bot-critical flow. |
| Missing avatars in bot-mode v1 | Nice-to-have unless it blocks identifying chats. Initials fallback is acceptable while dialog/history correctness is unstable. |
| Decorative preloads: colors, stickers, stories, app config | These should be guarded quietly. They are not core bot inbox functionality. |

### Probe Before Enabling

| Feature | Probe |
| --- | --- |
| App ID/hash impact on media download | Current local `.env` already provides `VITE_API_ID` and `VITE_API_HASH`. If media remains broken, compare with a known-good `.env.local` without committing or printing values. |
| Bot gift sending | Use Bot API `getMyStarBalance`, `getAvailableGifts`, and manual `sendGift` confirmation only. Do not automate live gift sends. |
| Media sending | Reuse the same known-peer/access-hash preflight as text send, then test one controlled upload path. |
| Known message refresh | Continue probing `messages.getMessages` and `channels.getMessages` for message ids already discovered through updates. This can refresh reactions/content, but it is not a history listing API. |
| Admin/channel methods | Probe one method at a time for the actual bot role in the actual chat. Do not infer support from user-client behavior. |

### Recommended Next Implementation Slice

1. Make chat open render local history immediately.
2. Run targeted peer sync after render and expose dev logs for `updates.getChannelDifference`.
3. Persist channel `pts` after successful channel difference.
4. Stop marking bot local history as full server history.
5. Disable participant rank preload in bot mode.

This slice is intentionally narrow: it addresses the observed "opened chat does not fetch/appear reliably" problem without expanding the surface area into gifts, avatars, or media downloads.

## Implemented Overrides

| Area | Upstream MTProto path | Bot-mode behavior | Reason |
| --- | --- | --- | --- |
| Login | phone / QR / imported user auth | `auth.importBotAuthorization` | Bot-token MTProto auth is valid, but not a full user account. |
| Startup dialogs | `messages.getDialogs` and user startup preload | `updateManager` builds dialogs from update-derived messages | Bots cannot rely on user dialog/history APIs. |
| Dialog refresh | `messages.getPeerDialogs` | Return local update-derived dialog | Telegram returns `BOT_METHOD_INVALID` for bot accounts. |
| History display | arbitrary `messages.getHistory` plus user restriction checks | Return plain local update-derived history before `isPeerRestricted()` and include cached messages in the result | Bots can see updates they are allowed to receive, not arbitrary user history. Avoids user privacy/content settings paths during chat open. |
| Bot dialog top message | upstream dialog save converts server ids later | Bot-created local dialogs store `message.mid` for `top_message` and read cursors | Channel/supergroup messages use local mids inside tweb history storage. |
| Drafts | `messages.getAllDrafts`, `messages.saveDraft`, `updateDraftMessage` | Ignore server drafts in bot mode | Server drafts are user account state. |
| App config for sending | `help.getAppConfig` during send preflight | Use empty local app-config fallback | `help.getAppConfig` can be bot-invalid and is not required for simple send. |
| Content settings | `account.getContentSettings`, `account.setContentSettings` | Return local default / no-op write | User account settings are bot-invalid. |
| Global privacy | `account.getGlobalPrivacySettings`, `account.setGlobalPrivacySettings` | Return local default / no-op write | User privacy settings are bot-invalid. |
| Language pack bootstrap | `langpack.getLangPack`, `langpack.getStrings`, `langpack.getDifference`, `help.getCountriesList` | Return bundled local language/countries data in bot mode | These decorative/bootstrap calls can be bot-invalid or slow before bot startup; local language assets are enough for the POC. |
| Peer colors | `help.getPeerColors`, `help.getPeerProfileColors` | Return empty `help.peerColors` fallback | Bot accounts can reject decorative peer-color preload calls. |
| Stories preload | `stories.getAllStories`, `stories.getStealthMode` | Return empty local stories state and skip user-auth stories preload | Stories/stealth mode are user account surfaces and were observed as long-pending bot-mode startup tasks. |
| Top peers | `contacts.getTopPeers` | Return empty local top-peer lists | Top peers are contact/account ranking state and can hang or fail for bot accounts. |
| Sticker preload | `messages.getAllStickers`, `messages.getEmojiStickers` | Return empty sticker-set lists | Bot accounts currently reject these preload calls. |
| Custom emoji document preload | `messages.getCustomEmojiDocuments` | Return cached docs when present, otherwise local empty results | Decorative custom emoji should not block bot chat rendering or produce long-pending worker tasks. |
| Reactions preload/actions | `messages.getAvailableReactions`, `messages.getSavedReactionTags`, `messages.getPaidReactionPrivacy`, `messages.getMessagesReactions`, `messages.getMessageReactionsList` | Return local/default capabilities and skip reaction list preload in bot mode | Reaction/premium reaction state is user-client functionality and was observed as bot-invalid. |
| Reaction send/list fallback | `messages.sendReaction` for user accounts | Use Bot API `getChat.available_reactions` when available and `setMessageReaction` for bot accounts | Telegram Bot API supports bot reactions where MTProto user-client reaction methods return `BOT_METHOD_INVALID`. |
| Bot reaction persistence | Server history reaction state | Store a local per-account overlay keyed by tweb peer/mid and Bot API chat/message ids | Bot API can set bot reactions, but MTProto `messages.getMessages` did not return the bot's chosen reaction for known @okhlopkov messages during live probing. |
| Poll answer/add-option | `messages.sendVote`, `messages.addPollAnswer` | Render polls read-only in bot mode; hide add-option and ignore vote toggles | MTProto rejects add-option for bots; Bot API can create/stop polls but has no method to vote in an existing poll or add an option to an existing poll as the bot. |
| Bot gifts/stars | `payments.*` star gift popup | Use Bot API `getMyStarBalance`, `getAvailableGifts`, and user-triggered `sendGift` | Telegram Bot API supports bot Stars balance and gift sending while MTProto payments/gift methods are bot-invalid in this client. |
| Old bot sessions without token | Signed-in account slot with `isBot=true` but no token | Restore MTProto session from saved auth key; Bot API fallbacks remain unavailable until a future successful token login stores the token | Re-importing only to recover a local token field risks auth flood; the saved auth key is enough for MTProto reuse. |
| Self user for send | assumes `appUsersManager.getSelf()` is hydrated | Hydrate `inputUserSelf`; fall back to account peer id | Restored bot sessions can start before self is cached. |
| Update sync state | `updates.getDifference` may run with missing `pts`/`date` during early startup | Initialize with `updates.getState` first when state is incomplete | Avoids long-running `updates.getDifference` calls with undefined state. |
| Avatars/media preload | Unbounded avatar/video-avatar download during list render | Disable bot video avatars and bound photo avatar loads with initials fallback | Prevents avatar downloads from blocking bot dialog rendering or surfacing delayed upload timeouts. |
| Typing actions | `messages.setTyping` | No-op in bot mode | Avoid user-style typing calls that can be bot-invalid. |
| Received message ACK | `messages.receivedMessages` | Update local max-seen state only; skip server ACK | Telegram returns `BOT_METHOD_INVALID` for bot accounts on this user-client read-receipt path. |
| Chat-open auxiliary calls | `messages.getHistory`, `messages.readHistory`, `channels.readHistory`, `messages.getPinnedMessages`, `messages.getMessageReadParticipants`, `messages.getSendAs`, unread mention/reaction/poll reads, quick replies, outbox read dates, and message-delivery reports | Return local update-derived history or empty/no-op results in bot mode | These are user-client history, read-state, participant, or account convenience paths; they should not block opening a bot-derived chat. |
| Scheduled messages | `messages.getScheduledHistory`, `schedule_date` send fields | Return empty scheduled list, strip schedule fields, and hide Schedule/Reminder/Send when online menu actions | Scheduling is user-client state for this POC. |
| Send peer resolution | Synchronously build `InputPeer` from cache | Refuse bot send if peer is missing or user/channel access hash is empty | Bots can only send to known update-derived or explicitly resolved peers. |
| Hash/deep-link open | Hash route can run before update-derived peers are cached | Retry hash open after bot dialog scan and catch missing-peer route promises | Direct URLs like `#-880284755` should open after updates hydrate local peer storage instead of throwing an unhandled promise. |
| Gift/paid-message composer affordances | Gift/privacy/paid controls assume user-account acked results | Keep these controls hidden/no-op in bot mode and guard missing acked results | Prevents `Cannot read properties of undefined (reading 'result')` when opening bot-visible direct peers. |
| Right profile/sidebar | chat header opens `sharedMediaTab` | No-op when bot mode has no shared-media/profile tab installed | Bot-mode v1 does not load user shared-media/profile panes, so topbar clicks must not crash. |
| Worker stuck diagnostics | `SuperMessagePort` stuck watchdog only logged ids | Include concrete manager/API method names, use longer thresholds for file/media and cold bootstrap tasks | Bot-mode debugging needs actionable console logs without false startup warnings. |

## UI To Disable Or Replace

These controls should be hidden, disabled, or replaced with bot-specific copy when `rootScope.isBotAccount` is true:

| UI surface | Why |
| --- | --- |
| Privacy/settings/content settings | Backed by `account.*` user-only methods. |
| Contacts/global contact search | Backed by `contacts.*` user-only methods. |
| Full Telegram folders/dialog management | Depends on user dialog APIs. |
| Arbitrary chat history preload/search | Depends on user history/search APIs. |
| Saved messages/user account features | Bot accounts are not user accounts. |
| Sticker set management/faved stickers | Sticker account state is user-only for this POC. |
| Premium/contact/start/unblock composer gates | These are user-client affordances and can hide the bot composer. |
| Poll voting and add-option controls | Bot API has `sendPoll` and `stopPoll`, but no fallback for voting or adding an option to an existing poll. |

## Still To Probe

Keep probing before hard-disabling richer bot-admin features:

| Method family | Status |
| --- | --- |
| `messages.sendMessage` / media sending | Text send is confirmed both in harness and via local UI for a known direct peer. Media sending still needs UI coverage. |
| `messages.getMessages` / `channels.getMessages` for known IDs | Promising for update-derived message IDs. |
| `updates.getDifference` / `updates.getChannelDifference` | Primary source for bot inbox discovery. |
| admin/channel/group methods | Probe per method; do not assume docs are complete. |
| Bot API fallbacks | Use when MTProto cannot cover a needed bot-admin action; browser use exposes token locally, so store only per-account local credentials and never commit them. |
| Bot API `sendGift` | UI exists, but do not run automated live send tests. User should manually choose the cheapest gift and confirm the external side effect. |

## Live Probe Notes

- `messages.sendMessage` returned `updateShortSentMessage` for an approved target resolved by username.
- Hand-picked live matrix: `users.getUsers`, `updates.getState`, `updates.getDifference`, `messages.getMessages([])`, and `help.getConfig` work; `messages.getDialogs`, `messages.getPeerDialogs`, `messages.getHistory`, contacts/search APIs, `help.getNearestDc`, and `help.getAppConfig` return `BOT_METHOD_INVALID`.
- Broad `TG_BOT_AUTO_SAFE_PROBE=1` is useful for research, but many expected `BOT_METHOD_INVALID` replies can surface as low-level unhandled rejections in the Node harness. Use the hand-picked matrix for deterministic verification and the auto scan for exploratory runs.
- Local browser QA on `127.0.0.1:5173` from a clean profile confirmed bot-token auth as the first screen, no QR auth, update-derived dialogs, chat title rendering, route `#-880284755`, message history display, editable composer, send button, and zero relevant console errors after the chat was open.
- Local UI send QA confirmed a known direct peer resolved from `#49820636` to `#@okhlopkov`; the exact active composer had `data-peer-id="49820636"`, sending via Enter cleared the composer, rendered the outgoing bubble, and produced zero relevant console errors. The test message was sent intentionally; no bot token or message body is stored in this file.
- Live read-only Bot API probe confirmed this bot account has a Stars balance, `getAvailableGifts` returns sendable gift ids, and `getChat`/`getChatMember` for `@groupflexer` resolves a channel where the bot is an administrator with post/edit/delete/change-info rights.
- Live MTProto username probe confirmed `contacts.resolveUsername` works for both `@okhlopkov` and `@groupflexer`; the latter returns a broadcast channel peer with admin rights, so username resolution can seed bot-admin channel workflows even when update-derived dialogs do not include the channel yet.
