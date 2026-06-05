# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

# Expo dev server over Tuft

When exposing the Expo dev server for a physical device, start `tuft expose-port`
for the Metro port, then start or restart Expo with `EXPO_PACKAGER_PROXY_URL`
set to the exposed `https://...tuft.host` URL. Without that env var, Expo can
serve a manifest whose bundle URLs include `:8081`, which devices cannot reach
through the exposed HTTPS route.

Example:

```sh
tuft expose-port 8081 --name nativemail-dev
EXPO_PACKAGER_PROXY_URL=https://staging-nativemail-dev.tuft.host npm run start -- --dev-client --lan --clear --port 8081
```

Verify with:

```sh
curl -sS -H 'Accept: application/expo+json,application/json' -H 'expo-platform: ios' https://staging-nativemail-dev.tuft.host
```

The manifest `launchAsset.url` should use the exposed HTTPS host with no
`:8081` suffix.

# Deferred email rendering fixtures

Do not start this until explicitly requested. When we build an email rendering
regression suite, borrow/adapt from:

- Can I Email `tests/` fixtures for HTML/CSS email feature coverage.
- Emailens engine as a client-compatibility rule oracle.
- Mailpit/MailDev/GreenMail as harness options, not fixture corpora.
- Public Thunderbird/Bugzilla rendering bugs as pattern references only; avoid
  vendoring raw personal `.eml` messages.

Initial fixture categories should include multiple `<html>/<body>` documents in
one part, malformed/nested tables, duplicate heads, body-level styles, Outlook
`mso-*`/VML/conditional comments, Gmail/Yahoo/Outlook quote wrappers, CID image
edge cases, multipart/alternative ordering, hidden preheaders/tracking pixels,
wide fixed-width designed emails, and security stripping cases.

# Deferred mailbox pagination experiment

Do not start this until explicitly requested. For mailbox infinite scrolling,
consider separating scroll-content growth from message-data hydration:

- When the user reaches the bottom and no cached rows remain, append fixed-height
  skeleton rows immediately for the next page.
- Fetch the exact page positions in the background, then replace skeleton rows
  in place when JMAP returns.
- Keep skeletons out of the real mail store; represent them only in the list
  render layer.
- Do not body-prefetch or run debug disk checks for skeleton rows.
- Match skeleton row height to real `MessageRow` rows so hydration does not
  cause scroll jumps.
