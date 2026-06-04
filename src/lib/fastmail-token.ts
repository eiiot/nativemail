import * as SecureStore from 'expo-secure-store';

const FASTMAIL_JMAP_TOKEN_KEY = 'fastmail.jmapToken';

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getFastmailJmapToken() {
  const available = await SecureStore.isAvailableAsync();

  if (!available) {
    return null;
  }

  const token = await SecureStore.getItemAsync(FASTMAIL_JMAP_TOKEN_KEY, secureStoreOptions);
  const trimmedToken = token?.trim();

  return trimmedToken ? trimmedToken : null;
}

export async function hasFastmailJmapToken() {
  return Boolean(await getFastmailJmapToken());
}

export async function saveFastmailJmapToken(token: string) {
  const trimmedToken = token.trim();

  if (!trimmedToken) {
    await clearFastmailJmapToken();
    return;
  }

  await SecureStore.setItemAsync(FASTMAIL_JMAP_TOKEN_KEY, trimmedToken, secureStoreOptions);
}

export async function clearFastmailJmapToken() {
  await SecureStore.deleteItemAsync(FASTMAIL_JMAP_TOKEN_KEY, secureStoreOptions);
}
