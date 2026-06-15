# Bot Mode Triage Snapshot - 2026-06-14

This is the recovery snapshot for the current bot-token experiment.

The goal is to stop chasing individual console errors and decide what to keep, revert, ignore, or re-apply on a clean branch.

## Current State

- Branch: `master`.
- HEAD: `c29dfcf84` (`origin/master`) before local bot-mode edits.
- Working tree: large dirty diff, about 79 tracked files changed plus untracked bot-mode files/docs/tests.
- Local dev server was started at `http://127.0.0.1:8080/`.
- Vite checker reported 0 TypeScript errors and 0 ESLint warnings at startup.
- `tsc --noEmit --pretty false` passed after the latest instrumentation/doc work.
- Focused tests passed: `src/tests/appManagersBotSafeFallbacks.test.ts` and `src/tests/appMessagesManagerBotSend.test.ts`.
- Full live bot capability probing is intentionally gated and was not run during this snapshot.

This repo state should be treated as an experimental spike, not as a clean product branch.

## Dirty Tree Inventory

The dirty tree touches too many surfaces to reason about as one change.

High-risk changed areas:

- Auth flow:
  - `src/pages/AuthCardsHost.tsx`
  - `src/pages/authFlow.tsx`
  - `src/pages/mountAuthFlow.tsx`
  - `src/pages/cards/SignInCard.tsx`
  - untracked `src/pages/cards/SignBotCard.tsx`
- Account/session/root state:
  - `src/lib/accounts/types.d.ts`
  - `src/lib/apiManagerProxy.ts`
  - `src/lib/rootScope.ts`
  - `src/types.d.ts`
- MTProto/API core:
  - `src/lib/appManagers/apiManager.ts`
  - `src/lib/appManagers/apiManagerMethods.ts`
  - `src/lib/appManagers/apiUpdatesManager.ts`
  - `src/lib/superMessagePort.ts`
- Bot dialog/history experiment:
  - untracked `src/lib/appManagers/botDialogsManager.ts`
  - `src/lib/appManagers/appMessagesManager.ts`
  - `src/lib/appDialogsManager.ts`
  - `src/lib/storages/dialogs.ts`
  - `src/components/sortedDialogList.ts`
  - `src/components/autonomousDialogList/base.ts`
- User-account manager fallbacks:
  - drafts, privacy, profile, stories, stickers, payments, gifts, reactions, polls, attach-menu bots, emoji, photos, chats, users.
- Chat UI:
  - `src/components/chat/*`
  - topbar, input, bubbles, reactions menu, reply container, message render.
- Media/avatar/decorative surfaces:
  - `src/components/avatarNew.tsx`
  - `src/components/appMediaViewerAvatarVideo.ts`
  - sticker/custom emoji wrappers
  - notification image helper
- Gifts/stars UI:
  - `src/components/popups/sendGift.tsx`
  - `src/components/popups/sendGift.module.scss`
  - stargift components.
- Tests/docs:
  - untracked docs.
  - bot capability and bot fallback tests.

This is why clean reapply is preferred: the spike mixes protocol research, auth routing, core manager behavior, UI guards, media behavior, and feature work in one dirty state.

## Latest Stream Notes

The user-visible state feels badly broken and too noisy to keep patching blindly.

Current working decision:

- Stop code fixes in this session.
- Preserve observations and audit notes.
- Prefer starting the next implementation from a clean repo/branch unless a very small and obvious stabilization patch is chosen deliberately.
- Do not try to fix media/files/gifts/reactions first.
- First recover the basic read-only bot inbox flow.

Additional observations from manual testing:

- The site can feel very slow; some UI such as reactions may eventually load after a delay.
- Some images/media appear to load, while other file/photo requests produce errors.
- This points less to a single missing config value and more to sequencing, cache, DC auth, and sync-order problems.
- The bot MTProto update algorithm likely needs to be intentionally different from the user-account Telegram Web K algorithm.
- Current code may be applying user-account assumptions too early or too broadly during startup, chat open, media preload, and UI preload.

Working hypothesis:

- The core issue is not one bad method. It is an ordering/state-machine problem:
  - bot auth completes,
  - update state/difference scan starts,
  - UI starts rendering before bot-derived peer/message storage is coherent,
  - user-account preload surfaces fire in parallel,
  - media/avatar download starts before foreign DC auth and file references are proven,
  - chat history is treated as complete even though it is only update-derived local cache.

This should be debugged as a staged bot-mode bootstrap/sync pipeline, not as a series of isolated console-error fixes.

## Ground Truth So Far

### Telegram Bot API Limits

The official Bot API does not provide:

- A `getDialogs` equivalent.
- A full "list all chats where this bot exists" endpoint.
- A `getHistory(chat)` equivalent.
- Arbitrary old message history retrieval by chat.

So a Telegram-Web-like bot inbox cannot be built by only replacing user login with bot-token login.

### Bot MTProto Reality

Bot-token MTProto auth works through `auth.importBotAuthorization`, but the account is not a full user session.

Empirically useful MTProto methods include:

- `auth.importBotAuthorization`.
- `users.getUsers(inputUserSelf)`.
- `updates.getState`.
- `updates.getDifference`.
- `updates.getChannelDifference` for known channels.
- `contacts.resolveUsername`.
- `messages.sendMessage` for known peers.
- `messages.getMessages` / `channels.getMessages` for known message ids, with limits.

Common user-client methods return `BOT_METHOD_INVALID`, including:

- `messages.getDialogs`.
- `messages.getPeerDialogs`.
- `messages.getHistory`.
- many `contacts.*`.
- many `account.*`.
- many `stories.*`.
- many `payments.*`.
- user-client reaction APIs.

The current POC therefore builds chat list/history from update-derived local state, not from complete Telegram history.

## Observed Product Problems

### Chat List And History

Symptom:

- Some chats appear from updates.
- Fresh events arrive.
- Opening a chat can show only events received since the local page/session started.
- Sometimes opening a channel does not visibly trigger useful `updates.getChannelDifference`.
- Reload behavior depends on whether the update-derived messages were already saved in local IndexedDB.

Likely current causes:

- `appMessagesManager.getHistory()` in bot mode waits for `botDialogsManager.syncRecentUpdatesForPeer()` before returning local history.
- That sync has a 6 second default runtime budget.
- The result is still only local cache, not server history.
- `getBotLocalHistoryResult()` marks the local slice as ended (`SliceEnd.Both`) and returns `isEnd.both=true`, even though this is not full server history.
- `botDialogsManager.syncRecentChannel()` starts from `dialog?.pts || 1`, advances a local `pts`, but does not appear to persist the new channel `pts`.

Decision:

- This is product-critical and likely partly self-inflicted.
- Fixing it should be the first implementation slice, but only after we finish triage.

Preferred future action:

1. Return local history immediately on chat open.
2. Run targeted peer sync in the background.
3. Publish/reload when new messages arrive.
4. Persist channel `pts` after successful `updates.getChannelDifference`.
5. Stop presenting update-derived local cache as complete server history.

### `upload.getFile` 401 `AUTH_KEY_UNREGISTERED`

Observed log:

```text
Error 401 AUTH_KEY_UNREGISTERED 2 4 upload.getFile
location: inputPhotoFileLocation
offset: 0
limit: 65536
```

Interpretation:

- This is not `BOT_METHOD_INVALID`.
- This is a file/media download on a non-base DC, likely an avatar/photo thumb path.
- It means the current auth key for that target DC is not accepted.
- The code path is risky because `apiManager.invokeApi()` retries 401 on foreign DC by authorizing the foreign DC and then recursively re-running the same request.
- If foreign DC authorization fails or does not create the right file auth context, one media request can create repeated 401 attempts.

App ID/hash finding:

- `.env` already contains `VITE_API_ID` and `VITE_API_HASH`.
- `src/config/app.ts` reads these values on localhost.
- `~/.zshrc` also exports `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, but tweb does not consume those names unless they are explicitly passed as `VITE_API_ID/HASH`.
- Missing App ID/hash is therefore unlikely to be the direct cause if normal MTProto login and updates work.

Safety decision:

- Treat repeated 401 file downloads as a safety issue, not harmless console noise.
- While triaging, avoid opening media/profile/avatar-heavy surfaces in bot mode.
- If 401s keep streaming, close the localhost tab. Stopping Vite alone may not stop an already-loaded page from talking to Telegram.

Preferred future action:

1. Add a hard retry limit for foreign-DC 401 recovery.
2. Add a short-lived suppression map for identical failed file locations.
3. Disable nonessential bot-mode media/avatar downloads until foreign-DC bot auth is proven.
4. Compare `src/lib/appManagers/apiManager.ts`, `src/lib/appManagers/apiFileManager.ts`, `src/lib/appManagers/appAvatarsManager.ts`, and `src/lib/appDownloadManager.ts` against upstream before patching.

This may be self-inflicted because media reportedly worked earlier and current bot-mode changes touched foreign DC auth and avatar/media guards.

### Auth Flow

Current risk:

- `src/pages/mountAuthFlow.tsx` maps both `authStateSignIn` and `authStateSignQr` to `signBot`.

Impact:

- If this fork should preserve original Telegram Web K user login, this is a regression.
- If the product is intentionally bot-only, the behavior should be explicit and documented, not an accidental fallthrough.

Preferred future action:

- Decide product direction.
- If bot-only: keep bot screen as first screen.
- If dual-mode: restore normal login and add bot-token login as a separate entry point.

### Bot API Fallbacks And Fake Success

Current risk:

- Some bot-mode manager fallbacks return local/default/no-op success for unsupported user-client methods.
- That is acceptable for decorative preload surfaces.
- It is not acceptable for visible user actions if the UI makes the user believe an action succeeded.

Preferred future action:

- Decorative preload: quiet fallback.
- Visible unsupported feature: hide or disable.
- Feature with real Bot API equivalent: route through Bot API and update UI only after success or reconcile failure.
- Message/chat discovery: never fake a complete server result.

### Reactions

Current risk:

- Bot reaction flow uses Bot API fallback and local overlay.
- If Bot API fails or MTProto refresh does not report the bot's chosen reaction, local UI can diverge from server.

Preferred future action:

- Roll back local overlay on Bot API failure.
- Mark this as "best effort" until known-message refresh is reliable.

### Gifts And Stars

Current state:

- Bot API has useful methods for bot stars/gifts: `getMyStarBalance`, `getAvailableGifts`, `sendGift`.
- Telegram Web K's existing gift UI is user-account/payment oriented and not enough by itself.

Decision:

- Do not run automated live `sendGift` tests.
- Add gift send UI only after inbox/history safety is stable.

## What To Ignore For Now

These should not drive the next implementation slice:

- Full arbitrary old chat history. Telegram platform limitation for bots.
- Full list of all bot chats. Telegram platform limitation for Bot API; current approach is update-derived.
- Some upstream-like console noise from original Telegram Web K.
- Decorative colors, stickers, stories, profile previews, and app-config preloads.
- Missing avatars, unless they cause repeated 401s or block chat identification.

## What To Compare Against Upstream

Before further fixes, inspect original behavior for:

- `src/lib/appManagers/apiManager.ts`: foreign DC auth, 401 handling, retry behavior.
- `src/lib/appManagers/apiFileManager.ts`: `upload.getFile`, file references, download queue behavior.
- `src/lib/appDownloadManager.ts`: duplicate download suppression and cancellation.
- `src/lib/appManagers/appAvatarsManager.ts`: avatar download path and cache semantics.
- `src/components/avatarNew.tsx`: bot-mode avatar short-circuit might leave unresolved or cached undefined states.
- `src/lib/appManagers/appMessagesManager.ts`: bot history branch, local slice semantics, known-message refresh.
- `src/lib/appManagers/botDialogsManager.ts`: initial update scan, recent peer sync, channel `pts`.
- `src/pages/mountAuthFlow.tsx`: normal login vs bot login routing.
- `src/lib/superMessagePort.ts`: instrumentation only, but keep it separate from product changes.

## Subagent Findings Already Collected

### Auth/startup Audit

- Normal sign-in and QR states currently route to bot login.
- `SignBotCard` has no clear back path to normal login.
- `setUser()` became async and some older flows may not await it.
- Some `user_auth` listeners still call user-account methods in bot mode.
- Old bot accounts without stored token need logout/invalidation because Bot API fallbacks cannot survive refresh.

### Fallback/API Audit

- Bot reaction overlay can diverge if Bot API fails.
- Bot history marks local cache as fully ended after incomplete sync.
- Text send has better known-peer/access-hash preflight than other send/media paths.
- `canSendToPeer` is too optimistic for bot peers.
- Some write-like fallbacks fake success.
- Avatar fallback does not cover all media paths.

### Dialog/history Audit

- Bot mode bypasses normal dialog loading.
- Dialogs and messages come from local update storage.
- `ChatBubbles` can call `getParticipants(channelParticipantsAdmins)` and hit `CHAT_ADMIN_REQUIRED`.
- `getHistory` waits up to 6 seconds for recent sync before returning local cache.
- `syncRecentChannel` does not persist new `pts`, so it can repeat from an old point.
- Bot history is marked as fully loaded even when it is only update-derived.

### App ID/hash Audit

- `.env` has both `VITE_API_ID` and `VITE_API_HASH`.
- `.env.local` is gitignored and can safely override them locally.
- `TELEGRAM_API_ID/HASH` from shell are not automatically visible to Vite unless passed as `VITE_API_ID/HASH`.
- Missing App ID/hash is unlikely to explain only media/file errors if MTProto auth and updates otherwise work.

## Proposed Recovery Strategy

### Option A: Clean Reapply, Preferred

1. Preserve this snapshot and `docs/bot-mtproto-overrides.md`.
2. Create a patch/archive of the current dirty spike only for reference.
3. Reset or reclone from clean `origin/master`.
4. Reapply only proven slices in order:
   - bot-token auth data model and login card.
   - minimal bot session bootstrap.
   - empirical bot capability probes.
   - update-derived dialog discovery.
   - immediate local chat render plus background targeted sync.
   - Bot API fallbacks for one feature at a time.
5. After each slice, run a narrow browser QA checklist and record console errors by method and surface.

This avoids continuing from a broad, tangled diff.

### Option B: Stabilize Current Spike

1. Add safety guard for repeated foreign-DC 401 file downloads.
2. Fix chat open first-render/sync semantics.
3. Persist channel `pts`.
4. Disable participant rank preload in bot mode.
5. Audit visible fake-success fallbacks.
6. Only then revisit avatars, media, gifts, and profile panes.

This is faster short term but riskier because the current diff has a large blast radius.

## Priority Order

The next session should not start with files, avatars, reactions, gifts, or UI polish.

Priority 0: Preserve research

- Keep this file and `docs/bot-mtproto-overrides.md`.
- Optionally keep a patch/archive of the current spike for reference only.
- Do not treat the current dirty tree as the product baseline.

Priority 1: Clean baseline

- Start from clean upstream/fork state.
- Reintroduce the smallest possible bot-token login path.
- Confirm normal Telegram Web K behavior is not accidentally damaged unless the product is explicitly bot-only.

Priority 2: Bot session bootstrap

- `auth.importBotAuthorization`.
- persist bot session metadata locally.
- hydrate self user.
- initialize `updates.getState`.
- avoid user-account startup calls before bot-mode guards are active.

Priority 3: Chat list

- Build a visible chat list from `updates.getDifference` and local storage.
- Record exactly which updates create each dialog.
- Make clear that the list is update-derived, not "all chats the bot belongs to".

Priority 4: Open one chat

- Opening a known chat must immediately show whatever local messages are already known.
- Chat open should trigger targeted sync for that peer in the background.
- For channels, `updates.getChannelDifference` should run from a persisted `pts`.
- The UI must not mark update-derived cache as full Telegram history.

Priority 5: Text messages

- After a chat is readable, verify simple text sending only for known peers.
- Use strict known-peer/access-hash checks.
- Do not generalize text-send success to media-send success.

Priority 6: Sync sequencing

- Refactor bot sync as an explicit pipeline if needed:
  - login,
  - self hydration,
  - update state,
  - global difference scan,
  - peer-specific sync,
  - local storage update,
  - UI notification/reload.
- Add dev logs around these phases before expanding feature scope.

Priority 7: Media/files

- Only after chat list/open/text are stable.
- Add safety around repeated `upload.getFile` 401s before heavy media testing.
- Compare against upstream file/DC auth code before changing anything.

Priority 8: Reactions, gifts, profile panes, avatars

- Reactions can use Bot API fallback where possible, but must not fake success.
- Gifts/stars are Bot API-specific and should be a separate feature slice.
- Profile panes and avatars are lower priority unless they cause request storms or crashes.

## Smallest Recommended Implementation Slice

Do not start with media/files/gifts.

Start with the smallest core inbox slice:

1. Bot login works.
2. App starts without user-account startup calls.
3. Dialog list is update-derived.
4. Opening a known chat immediately shows local messages.
5. Opening a known channel triggers targeted `updates.getChannelDifference` in the background.
6. `pts` is persisted.
7. Local cache is clearly not treated as complete history.

After that, add media and gifts as separate slices.

## Browser QA Checklist For Next Session

Do this only after closing old noisy localhost tabs or after adding 401 suppression.

1. Open local app.
2. Confirm whether this browser profile already has a bot session.
3. If not logged in, do not enter token during stream unless explicitly intended.
4. If logged in, wait 5 to 10 seconds on dialog list.
5. Record console errors grouped by method:
   - `BOT_METHOD_INVALID`.
   - `AUTH_KEY_UNREGISTERED`.
   - `FILE_REFERENCE_*`.
   - `FLOOD_WAIT_*`.
   - app-level uncaught exceptions.
6. Open exactly one low-risk chat.
7. Record whether `updates.getChannelDifference` runs for that peer.
8. Wait 5 to 10 seconds.
9. Record whether messages appear from local cache before sync finishes.
10. Do not open profile/media/gifts until the core chat-open path is understood.

## Gbrain Note

No `gbrain` command or callable Gbrain MCP tool was available in this session, so this markdown file is the source of truth for now.
