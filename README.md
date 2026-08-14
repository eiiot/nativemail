# NativeMail

An Expo/React Native email client prototype for Fastmail JMAP.

## Repository

GitHub remote:

```bash
git clone https://github.com/eiiot/nativemail.git
cd nativemail
```

For agent work, read `AGENTS.md` before editing. This app is on Expo SDK 56;
use the versioned Expo docs at https://docs.expo.dev/versions/v56.0.0/ when
checking Expo behavior.

## Setup

Install dependencies:

```bash
npm install
```

Run TypeScript checks:

```bash
npx tsc --noEmit --pretty false
```

Run Expo lint:

```bash
npm run lint
```

Run unit tests (do not add a `test` script to package.json — changes to the
scripts section alter the EAS runtime fingerprint and orphan OTA updates):

```bash
npx vitest run
```

## Development

Start the dev server for a dev-client build:

```bash
npm run start -- --dev-client
```

For physical-device testing through Tuft, expose Metro first and set
`EXPO_PACKAGER_PROXY_URL` so bundle URLs use the exposed HTTPS host:

```bash
tuft expose-port 8081 --name nativemail-dev &
EXPO_PACKAGER_PROXY_URL=https://staging-nativemail-dev.tuft.host npm run start -- --dev-client --lan --clear --port 8081
```

Verify the manifest points at the exposed host:

```bash
curl -sS \
  -H 'Accept: application/expo+json,application/json' \
  -H 'expo-platform: ios' \
  https://staging-nativemail-dev.tuft.host
```

## OTA Updates

Publish a dev OTA update to the installed dev-bundle build:

```bash
npx eas-cli@latest update \
  --channel nativemail-dev \
  --environment development \
  --platform ios \
  --message "Describe the change"
```

The `dev-bundle` native build profile is configured to receive the
`nativemail-dev` channel.

## Native Builds

Build the internal iOS dev bundle that includes a default update channel:

```bash
npm run build:dev-bundle
```

Equivalent command:

```bash
npx eas-cli@latest build --profile dev-bundle --platform ios
```

Other configured EAS profiles:

```bash
npx eas-cli@latest build --profile development --platform ios
npx eas-cli@latest build --profile preview --platform ios
npx eas-cli@latest build --profile production --platform ios
```

## Notification Relay

The local notification relay script is:

```bash
npm run notifications:relay
```

It is used for notification delivery and lightweight observability during
development.

### Fly.io deployment

The relay can run as a single always-on Fly Machine with its JSON store and
observability log on a persistent volume:

```bash
fly volumes create nativemail_data --region sjc --size 1
fly deploy
```

The Fly configuration deliberately runs one Machine. The relay keeps active
subscriber connections in memory and writes a single JSON store, so it is not
safe to scale horizontally without replacing that storage model.

Point app builds and updates at the deployed relay with:

```bash
EXPO_PUBLIC_NOTIFICATION_RELAY_URL=https://nativemail-relay.fly.dev
```

The Fly deployment is also the app's default relay. The environment variable
remains available for local or staging overrides.
