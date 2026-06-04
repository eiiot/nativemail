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
