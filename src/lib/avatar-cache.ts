import { Directory, File, Paths } from 'expo-file-system';
import { sha256 } from 'js-sha256';

import { getFastmailDomainAvatarUrl } from '@/lib/avatar-photos';
import type { Message } from '@/lib/mock-mail';

const avatarCacheDirectoryName = 'nativemail-avatars';
const fastmailAvatarCdnHost = 'www.fastmailcdn.com';
const fastmailAvatarOrigin = 'https://app.fastmail.com';

const memoryCachedAvatarUris = new Map<string, string>();
const failedAvatarUrls = new Set<string>();
const inFlightAvatarFetches = new Map<string, Promise<string | undefined>>();

let avatarCacheDirectory: Directory | null = null;

export function getMessageAvatarSourceUrl(message: Message) {
  return getFastmailDomainAvatarUrl(message.fromEmail);
}

export function getCachedAvatarFileUri(sourceUrl?: string | null) {
  if (!sourceUrl) {
    return undefined;
  }

  const memoryUri = memoryCachedAvatarUris.get(sourceUrl);

  if (memoryUri) {
    return memoryUri;
  }

  const file = getAvatarFile(sourceUrl);

  if (!file.exists) {
    return undefined;
  }

  memoryCachedAvatarUris.set(sourceUrl, file.uri);
  return file.uri;
}

export async function cacheAvatarFile(sourceUrl?: string | null) {
  if (!sourceUrl || failedAvatarUrls.has(sourceUrl)) {
    return undefined;
  }

  const cachedUri = getCachedAvatarFileUri(sourceUrl);

  if (cachedUri) {
    return cachedUri;
  }

  const inFlight = inFlightAvatarFetches.get(sourceUrl);

  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = downloadAvatarFile(sourceUrl).finally(() => {
    inFlightAvatarFetches.delete(sourceUrl);
  });

  inFlightAvatarFetches.set(sourceUrl, fetchPromise);
  return fetchPromise;
}

export async function cacheAvatarFiles(
  sourceUrls: string[],
  onAvatarCached?: (sourceUrl: string, fileUri: string) => void,
) {
  for (const sourceUrl of sourceUrls) {
    const fileUri = await cacheAvatarFile(sourceUrl);

    if (fileUri) {
      onAvatarCached?.(sourceUrl, fileUri);
    }
  }
}

async function downloadAvatarFile(sourceUrl: string) {
  const file = getAvatarFile(sourceUrl);

  try {
    await File.downloadFileAsync(sourceUrl, file, {
      headers: getAvatarRequestHeaders(sourceUrl),
      idempotent: true,
    });

    memoryCachedAvatarUris.set(sourceUrl, file.uri);
    failedAvatarUrls.delete(sourceUrl);
    return file.uri;
  } catch (error: unknown) {
    if (isPermanentAvatarFetchFailure(error)) {
      failedAvatarUrls.add(sourceUrl);
    }

    return undefined;
  }
}

function getAvatarFile(sourceUrl: string) {
  return new File(getAvatarCacheDirectory(), `${sha256(sourceUrl)}.avatar`);
}

function getAvatarCacheDirectory() {
  if (avatarCacheDirectory) {
    return avatarCacheDirectory;
  }

  avatarCacheDirectory = new Directory(Paths.cache, avatarCacheDirectoryName);
  avatarCacheDirectory.create({ idempotent: true, intermediates: true });

  return avatarCacheDirectory;
}

function getAvatarRequestHeaders(sourceUrl: string) {
  try {
    if (new URL(sourceUrl).hostname === fastmailAvatarCdnHost) {
      return { Origin: fastmailAvatarOrigin };
    }
  } catch {}

  return undefined;
}

function isPermanentAvatarFetchFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(403|404|410)\b/.test(message);
}
