# Telegram Web for Bots 

Manage chats of your Telegram bot from Telegram Web. All you need is a Telegram Bot token from Botfather.

Made by [@danokhlopkov](https://t.me/danokhlopkov) / [okhlopkov.com](https://okhlopkov.com).

Based on [Telegram Web A](https://github.com/Ajaxy/telegram-tt). 

------

## Local setup

```sh
mv .env.example .env

npm i
```

Obtain API ID and API hash on [my.telegram.org](https://my.telegram.org) and populate the `.env` file.

## Dev mode

```sh
npm run dev
```

Open [http://localhost:1234](http://localhost:1234).

## Testing with a bot token

Use a disposable bot token from [@BotFather](https://t.me/BotFather) when testing locally. Do not commit the token, paste it into issue logs, or share browser console output that contains it.

Manual checklist:

1. Start the dev server with `npm run dev` and open [http://localhost:1234](http://localhost:1234).
2. Log in with the bot token on the bot-token login screen.
3. Confirm the app opens the bot account without uncaught browser console errors.
4. Search for an exact public username, with or without `@`, for example `@username`. Bot sessions should resolve exact usernames through MTProto and open the matching user, bot, group, or channel when Telegram returns one.
5. Search with a broad text query. Bot sessions do not use Telegram's broad contact search, so only local/cache results and exact username matches are expected.
6. Open a phone-number link such as `https://t.me/+1234567890` while logged in as a bot. The app should show that phone-number links are unavailable for bot accounts, without a `BOT_METHOD_INVALID` console error.

Agent checklist before claiming a local build is ready:

1. Run the TypeScript check: `npm run check:ts`.
2. Start the dev server and open [http://localhost:1234](http://localhost:1234) in a browser-controlled session.
3. Verify that the login screen renders and the browser console has no uncaught startup errors.
4. Authenticated bot-token checks require a disposable token entered through the local UI. If no token is available to the agent, report that only the unauthenticated boot path was verified.

### Invoking API from console

Start your dev server and locate GramJS worker in the console context.

All constructors and functions available in global `GramJs` variable.

Run `npm run gramjs:tl full` to get access to all available Telegram methods.

Example usage:
``` javascript
await invoke(new GramJs.help.GetAppConfig())
```

### Dependencies
* [GramJS](https://github.com/gram-js/gramjs) ([MIT License](https://github.com/gram-js/gramjs/blob/master/LICENSE))
* [fflate](https://github.com/101arrowz/fflate) ([MIT License](https://github.com/101arrowz/fflate/blob/master/LICENSE))
* [cryptography](https://github.com/spalt08/cryptography) ([Apache License 2.0](https://github.com/spalt08/cryptography/blob/master/LICENSE))
* [emoji-data](https://github.com/iamcal/emoji-data) ([MIT License](https://github.com/iamcal/emoji-data/blob/master/LICENSE))
* [twemoji-parser](https://github.com/jdecked/twemoji-parser) ([MIT License](https://github.com/jdecked/twemoji-parser/blob/master/LICENSE.md))
* [rlottie](https://github.com/Samsung/rlottie) ([MIT License](https://github.com/Samsung/rlottie/blob/master/COPYING))
* [opus-recorder](https://github.com/chris-rudmin/opus-recorder) ([Various Licenses](https://github.com/chris-rudmin/opus-recorder/blob/master/LICENSE.md))
* [qr-code-styling](https://github.com/kozakdenys/qr-code-styling) ([MIT License](https://github.com/kozakdenys/qr-code-styling/blob/master/LICENSE))
* [music-metadata](https://github.com/Borewit/music-metadata) ([MIT License](https://github.com/Borewit/music-metadata/blob/master/LICENSE.txt))
* [lowlight](https://github.com/wooorm/lowlight) ([MIT License](https://github.com/wooorm/lowlight/blob/main/license))
* [idb-keyval](https://github.com/jakearchibald/idb-keyval) ([Apache License 2.0](https://github.com/jakearchibald/idb-keyval/blob/main/LICENCE))
* [fasttextweb](https://github.com/karmdesai/fastTextWeb)
* fastblur

## Bug reports and Suggestions
If you find an issue with this app, let Telegram know using the [Suggestions Platform](https://bugs.telegram.org/c/4002).
