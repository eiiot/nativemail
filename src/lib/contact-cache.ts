import { Directory, File, Paths } from 'expo-file-system';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { sha256 } from 'js-sha256';

import { getFastmailJmapToken } from '@/lib/fastmail-token';

const CONTACTS_CAPABILITY_URI = 'urn:ietf:params:jmap:contacts';
const CORE_CAPABILITY_URI = 'urn:ietf:params:jmap:core';
const FASTMAIL_SESSION_URL = 'https://api.fastmail.com/jmap/session';
const DATABASE_NAME = 'nativemail-contacts.db';
const CONTACT_CACHE_SCHEMA_VERSION = 1;
const CONTACT_LOOKUP_BATCH_SIZE = 20;
const CONTACT_LOOKUP_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_PHOTO_CACHE_DIR = 'nativemail-contact-photos';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contact_cards (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    uid TEXT,
    display_name TEXT,
    photo_blob_id TEXT,
    photo_media_type TEXT,
    photo_name TEXT,
    photo_uri TEXT,
    updated TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE IF NOT EXISTS contact_emails (
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    pref INTEGER,
    has_photo INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, email, contact_id)
  );

  CREATE TABLE IF NOT EXISTS contact_lookup_misses (
    account_id TEXT NOT NULL,
    email TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, email)
  );

  CREATE TABLE IF NOT EXISTS contact_photo_files (
    account_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    file_uri TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, blob_id)
  );

  CREATE INDEX IF NOT EXISTS contact_emails_lookup_idx
    ON contact_emails(account_id, email, has_photo, pref);

  PRAGMA user_version = ${CONTACT_CACHE_SCHEMA_VERSION};
`;

let databasePromise: Promise<SQLiteDatabase> | null = null;
let contactPhotoDirectory: Directory | null = null;

type ContactEmailRow = {
  account_id: string;
  blob_file_uri: string | null;
  contact_id: string;
  display_name: string | null;
  email: string;
  photo_blob_id: string | null;
  photo_media_type: string | null;
  photo_name: string | null;
  photo_uri: string | null;
};

type ContactLookup = {
  accountId: string;
  displayName?: string;
  email: string;
  photoBlobId?: string;
  photoFileUri?: string;
  photoMediaType?: string;
  photoName?: string;
  photoUri?: string;
};

type ContactLookupResult = {
  avatarUriByEmail: Record<string, string>;
  fetched: number;
  fromCache: number;
  missed: number;
};

type FastmailContactSession = {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  token: string;
};

type ContactCard = {
  emails?: Record<string, ContactCardEmail>;
  id: string;
  media?: Record<string, ContactCardMedia>;
  name?: {
    components?: { kind?: string; value?: string }[];
    full?: string;
  };
  uid?: string;
  updated?: string;
};

type ContactCardEmail = {
  address?: string;
  label?: string;
  pref?: number;
};

type ContactCardMedia = {
  blobId?: string;
  kind?: string;
  mediaType?: string;
  pref?: number;
  uri?: string;
};

type JmapMethodResponse = [string, Record<string, unknown>, string];

export async function getContactAvatarUrisForEmails(
  emails: (string | null | undefined)[],
  signal?: AbortSignal,
): Promise<ContactLookupResult> {
  const normalizedEmails = normalizeEmailList(emails);

  if (!normalizedEmails.length) {
    return {
      avatarUriByEmail: {},
      fetched: 0,
      fromCache: 0,
      missed: 0,
    };
  }

  const cached = await readCachedContactLookups(normalizedEmails);
  const cachedAvatarUris = getAvatarUriMap(cached);
  const missingEmails = normalizedEmails.filter((email) => !cached[email]);

  if (missingEmails.length) {
    await fetchAndCacheContactsForEmails(missingEmails, signal).catch(() => {});
  }

  const refreshed = missingEmails.length
    ? await readCachedContactLookups(normalizedEmails)
    : cached;
  const avatarUriByEmail = getAvatarUriMap(refreshed);

  return {
    avatarUriByEmail,
    fetched: Object.keys(refreshed).filter((email) => !cached[email] && refreshed[email]).length,
    fromCache: Object.keys(cachedAvatarUris).length,
    missed: normalizedEmails.length - Object.keys(refreshed).length,
  };
}

async function fetchAndCacheContactsForEmails(emails: string[], signal?: AbortSignal) {
  const session = await getFastmailContactSession(signal);
  const eligibleEmails = await filterRecentlyMissedEmails(session.accountId, emails);

  if (!eligibleEmails.length) {
    return;
  }

  for (let index = 0; index < eligibleEmails.length; index += CONTACT_LOOKUP_BATCH_SIZE) {
    if (signal?.aborted) {
      return;
    }

    const batch = eligibleEmails.slice(index, index + CONTACT_LOOKUP_BATCH_SIZE);
    const cards = await fetchContactCardsForEmailBatch(session, batch, signal);
    await writeContactCards(session.accountId, cards);
    await writeContactLookupMisses(
      session.accountId,
      getUnmatchedEmails(batch, cards),
    );
    await cacheContactPhotos(session, cards, signal);
  }
}

async function fetchContactCardsForEmailBatch(
  session: FastmailContactSession,
  emails: string[],
  signal?: AbortSignal,
) {
  const filter = emails.length === 1
    ? { email: emails[0] }
    : {
        conditions: emails.map((email) => ({ email })),
        operator: 'OR',
      };
  const payload = await jmapRequest(
    session,
    [
      [
        'ContactCard/query',
        {
          accountId: session.accountId,
          filter,
          limit: Math.max(emails.length * 2, 10),
          position: 0,
        },
        'query',
      ],
      [
        'ContactCard/get',
        {
          '#ids': {
            name: 'ContactCard/query',
            path: '/ids',
            resultOf: 'query',
          },
          accountId: session.accountId,
          properties: ['id', 'uid', 'name', 'emails', 'media', 'updated'],
        },
        'get',
      ],
    ],
    signal,
  );
  const response = findMethodResponse(payload.methodResponses, 'ContactCard/get', 'get');
  const list = response?.[1]?.list;

  return Array.isArray(list) ? list.filter(isContactCard) : [];
}

async function readCachedContactLookups(emails: string[]) {
  const db = await getContactCacheDatabase();
  const lookups: Record<string, ContactLookup> = {};

  for (const batch of chunk(emails, 500)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.getAllAsync<ContactEmailRow>(
      `SELECT
        contact_emails.account_id,
        contact_emails.email,
        contact_emails.contact_id,
        contact_cards.display_name,
        contact_cards.photo_blob_id,
        contact_cards.photo_media_type,
        contact_cards.photo_name,
        contact_cards.photo_uri,
        contact_photo_files.file_uri AS blob_file_uri
       FROM contact_emails
       JOIN contact_cards
         ON contact_cards.account_id = contact_emails.account_id
        AND contact_cards.id = contact_emails.contact_id
       LEFT JOIN contact_photo_files
         ON contact_photo_files.account_id = contact_cards.account_id
        AND contact_photo_files.blob_id = contact_cards.photo_blob_id
       WHERE contact_emails.email IN (${placeholders})
       ORDER BY
         contact_emails.email ASC,
         contact_emails.has_photo DESC,
         contact_emails.pref IS NULL ASC,
         contact_emails.pref ASC,
         contact_emails.updated_at DESC`,
      batch,
    );

    for (const row of rows) {
      if (lookups[row.email]) {
        continue;
      }

      lookups[row.email] = {
        accountId: row.account_id,
        displayName: row.display_name ?? undefined,
        email: row.email,
        photoBlobId: row.photo_blob_id ?? undefined,
        photoFileUri: row.blob_file_uri ?? undefined,
        photoMediaType: row.photo_media_type ?? undefined,
        photoName: row.photo_name ?? undefined,
        photoUri: row.photo_uri ?? undefined,
      };
    }
  }

  return lookups;
}

async function writeContactCards(accountId: string, cards: ContactCard[]) {
  if (!cards.length) {
    return;
  }

  const db = await getContactCacheDatabase();
  const now = Date.now();

  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const card of cards) {
      const photo = getPreferredContactPhoto(card);
      const displayName = getContactDisplayName(card);

      await txn.runAsync(
        `INSERT INTO contact_cards (
          account_id, id, uid, display_name, photo_blob_id, photo_media_type,
          photo_name, photo_uri, updated, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, id) DO UPDATE SET
          uid = excluded.uid,
          display_name = excluded.display_name,
          photo_blob_id = excluded.photo_blob_id,
          photo_media_type = excluded.photo_media_type,
          photo_name = excluded.photo_name,
          photo_uri = excluded.photo_uri,
          updated = excluded.updated,
          updated_at = excluded.updated_at`,
        [
          accountId,
          card.id,
          card.uid ?? null,
          displayName ?? null,
          photo?.blobId ?? null,
          photo?.mediaType ?? null,
          getContactPhotoName(card, photo) ?? null,
          photo?.uri ?? null,
          card.updated ?? null,
          now,
        ],
      );

      await txn.runAsync(
        'DELETE FROM contact_emails WHERE account_id = ? AND contact_id = ?',
        [accountId, card.id],
      );

      for (const email of getCardEmails(card)) {
        await txn.runAsync(
          `INSERT OR REPLACE INTO contact_emails (
            account_id, email, contact_id, pref, has_photo, display_name, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            accountId,
            email.address,
            card.id,
            email.pref ?? null,
            photo ? 1 : 0,
            displayName ?? null,
            now,
          ],
        );
      }
    }
  });
}

async function writeContactLookupMisses(accountId: string, emails: string[]) {
  if (!emails.length) {
    return;
  }

  const db = await getContactCacheDatabase();
  const now = Date.now();

  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const email of emails) {
      await txn.runAsync(
        `INSERT OR REPLACE INTO contact_lookup_misses (
          account_id, email, updated_at
        ) VALUES (?, ?, ?)`,
        [accountId, email, now],
      );
    }
  });
}

async function filterRecentlyMissedEmails(accountId: string, emails: string[]) {
  const db = await getContactCacheDatabase();
  const cutoff = Date.now() - CONTACT_LOOKUP_MISS_TTL_MS;
  const eligible: string[] = [];

  for (const batch of chunk(emails, 500)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.getAllAsync<{ email: string }>(
      `SELECT email FROM contact_lookup_misses
       WHERE account_id = ?
         AND updated_at >= ?
         AND email IN (${placeholders})`,
      [accountId, cutoff, ...batch],
    );
    const missed = new Set(rows.map((row) => row.email));

    eligible.push(...batch.filter((email) => !missed.has(email)));
  }

  return eligible;
}

async function cacheContactPhotos(
  session: FastmailContactSession,
  cards: ContactCard[],
  signal?: AbortSignal,
) {
  const photos = cards
    .map((card) => getPreferredContactPhoto(card))
    .filter((photo): photo is ContactCardMedia & { blobId: string; mediaType: string } =>
      Boolean(photo?.blobId && photo.mediaType && isRenderablePhotoMediaType(photo.mediaType))
    );

  for (const photo of photos) {
    if (signal?.aborted) {
      return;
    }

    await cacheContactPhoto(session, photo, signal).catch(() => {});
  }
}

async function cacheContactPhoto(
  session: FastmailContactSession,
  photo: ContactCardMedia & { blobId: string; mediaType: string },
  signal?: AbortSignal,
) {
  const db = await getContactCacheDatabase();
  const existing = await db.getFirstAsync<{ file_uri: string }>(
    'SELECT file_uri FROM contact_photo_files WHERE account_id = ? AND blob_id = ? LIMIT 1',
    [session.accountId, photo.blobId],
  );

  if (existing?.file_uri) {
    return existing.file_uri;
  }

  const file = getContactPhotoFile(session.accountId, photo.blobId, photo.mediaType);
  await File.downloadFileAsync(
    getDownloadUrl(session, photo.blobId, getContactPhotoName(null, photo) ?? 'avatar', photo.mediaType),
    file,
    {
      headers: {
        Accept: photo.mediaType,
        Authorization: `Bearer ${session.token}`,
      },
      idempotent: true,
    },
  );

  await db.runAsync(
    `INSERT OR REPLACE INTO contact_photo_files (
      account_id, blob_id, media_type, file_uri, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [session.accountId, photo.blobId, photo.mediaType, file.uri, Date.now()],
  );

  return file.uri;
}

function getAvatarUriMap(lookups: Record<string, ContactLookup>) {
  const map: Record<string, string> = {};

  for (const [email, lookup] of Object.entries(lookups)) {
    const avatarUri = lookup.photoFileUri ?? lookup.photoUri;

    if (avatarUri && isRenderableAvatarUri(avatarUri)) {
      map[email] = avatarUri;
    }
  }

  return map;
}

async function getFastmailContactSession(signal?: AbortSignal): Promise<FastmailContactSession> {
  const token = await getFastmailJmapToken();

  if (!token) {
    throw new Error('No Fastmail JMAP token is configured.');
  }

  const response = await fetch(FASTMAIL_SESSION_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Fastmail JMAP session failed with HTTP ${response.status}.`);
  }

  const session = await response.json();
  const accountId = session?.primaryAccounts?.[CONTACTS_CAPABILITY_URI];

  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Fastmail JMAP session did not include a primary contacts account.');
  }

  if (typeof session.apiUrl !== 'string' || typeof session.downloadUrl !== 'string') {
    throw new Error('Fastmail JMAP session is missing contact request URLs.');
  }

  return {
    accountId,
    apiUrl: session.apiUrl,
    downloadUrl: session.downloadUrl,
    token,
  };
}

async function jmapRequest(
  session: FastmailContactSession,
  methodCalls: unknown[][],
  signal?: AbortSignal,
): Promise<{ methodResponses: JmapMethodResponse[] }> {
  const response = await fetch(session.apiUrl, {
    body: JSON.stringify({
      methodCalls,
      using: [CORE_CAPABILITY_URI, CONTACTS_CAPABILITY_URI],
    }),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
    signal,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Fastmail contacts request failed with HTTP ${response.status}.`);
  }

  if (!payload || !Array.isArray(payload.methodResponses)) {
    throw new Error('Fastmail contacts request returned an invalid response.');
  }

  return payload;
}

function findMethodResponse(
  responses: JmapMethodResponse[],
  name: string,
  callId: string,
) {
  return responses.find((response) => response[0] === name && response[2] === callId) ?? null;
}

async function getContactCacheDatabase() {
  databasePromise ??= openDatabaseAsync(DATABASE_NAME).then(async (db) => {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 1000;
    `);
    await migrate(db);
    return db;
  });

  return databasePromise;
}

async function migrate(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');

  if ((row?.user_version ?? 0) >= CONTACT_CACHE_SCHEMA_VERSION) {
    return;
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(SCHEMA_SQL);
  });
}

function getContactPhotoFile(accountId: string, blobId: string, mediaType: string) {
  return new File(
    getContactPhotoDirectory(),
    `${sha256(`${accountId}:${blobId}`)}.${getPhotoExtension(mediaType)}`,
  );
}

function getContactPhotoDirectory() {
  if (contactPhotoDirectory) {
    return contactPhotoDirectory;
  }

  contactPhotoDirectory = new Directory(Paths.cache, CONTACT_PHOTO_CACHE_DIR);
  contactPhotoDirectory.create({ idempotent: true, intermediates: true });

  return contactPhotoDirectory;
}

function getDownloadUrl(
  session: FastmailContactSession,
  blobId: string,
  name: string,
  type: string,
) {
  return session.downloadUrl
    .replaceAll('{accountId}', encodeURIComponent(session.accountId))
    .replaceAll('{blobId}', encodeURIComponent(blobId))
    .replaceAll('{name}', encodeURIComponent(name))
    .replaceAll('{type}', encodeURIComponent(type));
}

function getPreferredContactPhoto(card: ContactCard | null) {
  const media = Object.values(card?.media ?? {}).filter((item) => item.kind === 'photo');

  if (!media.length) {
    return null;
  }

  return [...media].sort((a, b) => getPrefSortValue(a.pref) - getPrefSortValue(b.pref))[0] ?? null;
}

function getCardEmails(card: ContactCard): Array<{ address: string; pref: number | null }> {
  return Object.values(card.emails ?? {})
    .map((email) => ({
      address: normalizeEmail(email.address),
      pref: email.pref ?? null,
    }))
    .filter((email): email is { address: string; pref: number | null } => Boolean(email.address));
}

function getUnmatchedEmails(emails: string[], cards: ContactCard[]) {
  const matched = new Set(cards.flatMap((card) => getCardEmails(card).map((email) => email.address)));

  return emails.filter((email) => !matched.has(email));
}

function getContactDisplayName(card: ContactCard) {
  const fullName = card.name?.full?.trim();

  if (fullName) {
    return fullName;
  }

  const componentName = card.name?.components
    ?.map((component) => component.value?.trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  if (componentName) {
    return componentName;
  }

  return getCardEmails(card)[0]?.address;
}

function getContactPhotoName(card: ContactCard | null, photo?: ContactCardMedia | null) {
  const displayName = card ? getContactDisplayName(card) : null;
  const extension = getPhotoExtension(photo?.mediaType);

  return `${displayName || 'avatar'}.${extension}`;
}

function getPhotoExtension(mediaType?: string | null) {
  switch (mediaType?.toLowerCase()) {
    case 'image/gif':
      return 'gif';
    case 'image/png':
      return 'png';
    case 'image/svg+xml':
      return 'svg';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
    default:
      return 'jpg';
  }
}

function getPrefSortValue(pref?: number) {
  return typeof pref === 'number' ? pref : Number.MAX_SAFE_INTEGER;
}

function normalizeEmailList(emails: (string | null | undefined)[]) {
  return Array.from(
    new Set(
      emails
        .map(normalizeEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  );
}

export function normalizeContactEmail(email?: string | null) {
  return normalizeEmail(email);
}

function normalizeEmail(email?: string | null) {
  const normalizedEmail = email?.trim().toLowerCase();

  return normalizedEmail && normalizedEmail.includes('@') ? normalizedEmail : undefined;
}

function isContactCard(value: unknown): value is ContactCard {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as ContactCard).id === 'string',
  );
}

function isRenderablePhotoMediaType(mediaType: string) {
  return mediaType.startsWith('image/');
}

function isRenderableAvatarUri(uri: string) {
  return /^(file:|https?:|data:image\/)/i.test(uri);
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
