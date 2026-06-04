import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { JmapMailbox, JmapMailboxSnapshot, JmapMessageBody } from '@/lib/jmap-client';
import type { Message, MessageAttachment } from '@/lib/mock-mail';

const DATABASE_NAME = 'nativemail-cache.db';
const CACHE_SCHEMA_VERSION = 1;
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mailboxes (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    role TEXT,
    sort_order INTEGER,
    total_emails INTEGER,
    unread_emails INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE IF NOT EXISTS emails (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    preview TEXT NOT NULL,
    date TEXT NOT NULL,
    avatar TEXT,
    avatar_color TEXT NOT NULL,
    from_email TEXT,
    to_addresses TEXT,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    count INTEGER,
    keywords_json TEXT NOT NULL DEFAULT '{}',
    mailbox_ids_json TEXT NOT NULL DEFAULT '{}',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    body TEXT,
    html_body TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE IF NOT EXISTS mailbox_emails (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, mailbox_id, email_id)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    scope TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    state TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS mailbox_emails_order_idx
    ON mailbox_emails(account_id, mailbox_id, position);
  CREATE INDEX IF NOT EXISTS emails_updated_idx
    ON emails(updated_at);
  PRAGMA user_version = ${CACHE_SCHEMA_VERSION};
`;

let databasePromise: Promise<SQLiteDatabase> | null = null;

type MailboxRow = {
  account_id: string;
  id: string;
  name: string;
  parent_id: string | null;
  role: string | null;
  sort_order: number | null;
  total_emails: number | null;
  unread_emails: number | null;
};

type EmailRow = {
  account_id: string;
  id: string;
  sender: string;
  subject: string;
  preview: string;
  date: string;
  avatar: string | null;
  avatar_color: string;
  from_email: string | null;
  to_addresses: string | null;
  has_attachment: number;
  pinned: number;
  unread: number;
  count: number | null;
  keywords_json: string;
  mailbox_ids_json: string;
  attachments_json: string;
  body: string | null;
  html_body: string | null;
};

export async function readCachedMailboxSnapshot({
  mailboxId,
}: {
  mailboxId?: string | null;
} = {}): Promise<JmapMailboxSnapshot | null> {
  const db = await getMailCacheDatabase();
  const mailbox = await getCachedMailbox(db, mailboxId);

  if (!mailbox) {
    return null;
  }

  const [mailboxes, messages] = await Promise.all([
    getCachedMailboxes(db, mailbox.account_id),
    getCachedMailboxMessages(db, mailbox.account_id, mailbox.id),
  ]);

  if (!mailboxes.length && !messages.length) {
    return null;
  }

  return {
    accountId: mailbox.account_id,
    mailbox: rowToMailbox(mailbox),
    mailboxes: mailboxes.map(rowToMailbox),
    messages,
    username: '',
  };
}

export async function writeCachedMailboxSnapshot(snapshot: JmapMailboxSnapshot) {
  const db = await getMailCacheDatabase();
  const now = Date.now();
  const mailboxId = snapshot.mailbox?.id;

  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const mailbox of snapshot.mailboxes) {
      await txn.runAsync(
        `INSERT INTO mailboxes (
          account_id, id, name, parent_id, role, sort_order, total_emails, unread_emails, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, id) DO UPDATE SET
          name = excluded.name,
          parent_id = excluded.parent_id,
          role = excluded.role,
          sort_order = excluded.sort_order,
          total_emails = excluded.total_emails,
          unread_emails = excluded.unread_emails,
          updated_at = excluded.updated_at`,
        [
          snapshot.accountId,
          mailbox.id,
          mailbox.name,
          mailbox.parentId ?? null,
          mailbox.role ?? null,
          mailbox.sortOrder ?? null,
          mailbox.totalEmails ?? null,
          mailbox.unreadEmails ?? null,
          now,
        ],
      );
    }

    if (mailboxId) {
      await txn.runAsync(
        'DELETE FROM mailbox_emails WHERE account_id = ? AND mailbox_id = ?',
        [snapshot.accountId, mailboxId],
      );
    }

    for (const [position, message] of snapshot.messages.entries()) {
      await writeCachedMessage(txn, snapshot.accountId, message, now);

      if (mailboxId) {
        await txn.runAsync(
          `INSERT OR REPLACE INTO mailbox_emails (
            account_id, mailbox_id, email_id, position, updated_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [snapshot.accountId, mailboxId, message.id, position, now],
        );
      }
    }

    await txn.runAsync(
      `INSERT OR REPLACE INTO sync_state (scope, account_id, state, updated_at)
       VALUES (?, ?, ?, ?)`,
      [
        mailboxId ? `mailbox:${mailboxId}:snapshot` : 'mailbox:unknown:snapshot',
        snapshot.accountId,
        JSON.stringify({
          messageCount: snapshot.messages.length,
          username: snapshot.username,
        }),
        now,
      ],
    );
  });
}

export async function updateCachedEmail(
  messageId: string,
  patch: Pick<Partial<Message>, 'keywords' | 'pinned' | 'unread'>,
) {
  const db = await getMailCacheDatabase();
  const row = await db.getFirstAsync<Pick<EmailRow, 'account_id' | 'keywords_json'>>(
    'SELECT account_id, keywords_json FROM emails WHERE id = ? ORDER BY updated_at DESC LIMIT 1',
    messageId,
  );

  if (!row) {
    return;
  }

  const currentKeywords = parseJsonRecord(row.keywords_json);
  const nextKeywords = patch.keywords ?? currentKeywords;

  await db.runAsync(
    `UPDATE emails SET
      keywords_json = ?,
      pinned = COALESCE(?, pinned),
      unread = COALESCE(?, unread),
      updated_at = ?
    WHERE account_id = ? AND id = ?`,
    [
      JSON.stringify(nextKeywords),
      patch.pinned === undefined ? null : boolToInt(patch.pinned),
      patch.unread === undefined ? null : boolToInt(patch.unread),
      Date.now(),
      row.account_id,
      messageId,
    ],
  );
}

export async function removeCachedEmailFromMailbox(messageId: string, mailboxId?: string | null) {
  const db = await getMailCacheDatabase();

  if (mailboxId) {
    await db.runAsync(
      'DELETE FROM mailbox_emails WHERE mailbox_id = ? AND email_id = ?',
      [mailboxId, messageId],
    );
    return;
  }

  await db.runAsync('DELETE FROM mailbox_emails WHERE email_id = ?', messageId);
}

export async function readCachedEmailBody(messageId: string): Promise<JmapMessageBody | null> {
  const db = await getMailCacheDatabase();
  const row = await db.getFirstAsync<Pick<EmailRow, 'attachments_json' | 'body' | 'html_body'>>(
    'SELECT attachments_json, body, html_body FROM emails WHERE id = ? ORDER BY updated_at DESC LIMIT 1',
    messageId,
  );

  if (!row) {
    return null;
  }

  const attachments = parseJsonArray<MessageAttachment>(row.attachments_json);

  if (!attachments.length && !row.body && !row.html_body) {
    return null;
  }

  return {
    attachments,
    html: row.html_body,
    text: row.body,
  };
}

export async function hasCachedEmailBody(messageId: string) {
  const db = await getMailCacheDatabase();
  const row = await db.getFirstAsync<{ has_body: number }>(
    `SELECT
      CASE
        WHEN body IS NOT NULL OR html_body IS NOT NULL THEN 1
        ELSE 0
      END AS has_body
    FROM emails
    WHERE id = ?
    ORDER BY updated_at DESC
    LIMIT 1`,
    messageId,
  );

  return row?.has_body === 1;
}

export async function writeCachedEmailBody(messageId: string, body: JmapMessageBody) {
  const db = await getMailCacheDatabase();
  const row = await db.getFirstAsync<Pick<EmailRow, 'account_id'>>(
    'SELECT account_id FROM emails WHERE id = ? ORDER BY updated_at DESC LIMIT 1',
    messageId,
  );

  if (!row) {
    return;
  }

  const attachments = body.attachments ?? [];

  await db.runAsync(
    `UPDATE emails SET
      body = COALESCE(?, body),
      html_body = COALESCE(?, html_body),
      attachments_json = ?,
      has_attachment = ?,
      updated_at = ?
    WHERE account_id = ? AND id = ?`,
    [
      body.text,
      body.html,
      JSON.stringify(attachments),
      boolToInt(attachments.length > 0),
      Date.now(),
      row.account_id,
      messageId,
    ],
  );
}

async function getMailCacheDatabase() {
  databasePromise ??= openDatabaseAsync(DATABASE_NAME).then(async (db) => {
    await migrate(db);
    return db;
  });

  return databasePromise;
}

async function migrate(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion >= CACHE_SCHEMA_VERSION) {
    return;
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(SCHEMA_SQL);
  });
}

async function getCachedMailbox(db: SQLiteDatabase, mailboxId?: string | null) {
  if (mailboxId) {
    return await db.getFirstAsync<MailboxRow>(
      'SELECT * FROM mailboxes WHERE id = ? ORDER BY updated_at DESC LIMIT 1',
      mailboxId,
    );
  }

  return await db.getFirstAsync<MailboxRow>(
    `SELECT * FROM mailboxes
     WHERE role = 'inbox'
     ORDER BY updated_at DESC, sort_order ASC
     LIMIT 1`,
  );
}

async function getCachedMailboxes(db: SQLiteDatabase, accountId: string) {
  return await db.getAllAsync<MailboxRow>(
    `SELECT * FROM mailboxes
     WHERE account_id = ?
     ORDER BY
       CASE role
         WHEN 'inbox' THEN 0
         WHEN 'drafts' THEN 1
         WHEN 'sent' THEN 2
         WHEN 'archive' THEN 3
         WHEN 'junk' THEN 4
         WHEN 'trash' THEN 5
         ELSE 10
       END,
       sort_order ASC,
       name COLLATE NOCASE ASC`,
    accountId,
  );
}

async function getCachedMailboxMessages(db: SQLiteDatabase, accountId: string, mailboxId: string) {
  const rows = await db.getAllAsync<EmailRow>(
    `SELECT emails.*
     FROM mailbox_emails
     JOIN emails
       ON emails.account_id = mailbox_emails.account_id
      AND emails.id = mailbox_emails.email_id
     WHERE mailbox_emails.account_id = ?
       AND mailbox_emails.mailbox_id = ?
     ORDER BY mailbox_emails.position ASC`,
    [accountId, mailboxId],
  );

  return rows.map(rowToMessage);
}

async function writeCachedMessage(
  db: SQLiteDatabase,
  accountId: string,
  message: Message,
  updatedAt: number,
) {
  await db.runAsync(
    `INSERT INTO emails (
      account_id, id, sender, subject, preview, date, avatar, avatar_color,
      from_email, to_addresses, has_attachment, pinned, unread, count,
      keywords_json, mailbox_ids_json, attachments_json, body, html_body, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, id) DO UPDATE SET
      sender = excluded.sender,
      subject = excluded.subject,
      preview = excluded.preview,
      date = excluded.date,
      avatar = excluded.avatar,
      avatar_color = excluded.avatar_color,
      from_email = excluded.from_email,
      to_addresses = excluded.to_addresses,
      has_attachment = excluded.has_attachment,
      pinned = excluded.pinned,
      unread = excluded.unread,
      count = excluded.count,
      keywords_json = excluded.keywords_json,
      mailbox_ids_json = excluded.mailbox_ids_json,
      attachments_json = excluded.attachments_json,
      body = COALESCE(excluded.body, emails.body),
      html_body = COALESCE(excluded.html_body, emails.html_body),
      updated_at = excluded.updated_at`,
    [
      accountId,
      message.id,
      message.sender,
      message.subject,
      message.preview,
      message.date,
      message.avatar ?? null,
      message.avatarColor,
      message.fromEmail ?? null,
      message.to ?? null,
      boolToInt(Boolean(message.hasAttachment)),
      boolToInt(Boolean(message.pinned)),
      boolToInt(Boolean(message.unread)),
      message.count ?? null,
      JSON.stringify(message.keywords ?? {}),
      JSON.stringify(message.mailboxIds ?? {}),
      JSON.stringify(message.attachments ?? []),
      message.body ?? null,
      message.htmlBody ?? null,
      updatedAt,
    ],
  );
}

function rowToMailbox(row: MailboxRow): JmapMailbox {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    role: row.role,
    sortOrder: row.sort_order ?? 0,
    totalEmails: row.total_emails ?? 0,
    unreadEmails: row.unread_emails ?? 0,
  };
}

function rowToMessage(row: EmailRow): Message {
  const attachments = parseJsonArray<MessageAttachment>(row.attachments_json);

  return {
    attachments,
    avatar: row.avatar ?? undefined,
    avatarColor: row.avatar_color,
    body: row.body ?? undefined,
    count: row.count ?? undefined,
    date: row.date,
    fromEmail: row.from_email ?? undefined,
    hasAttachment: row.has_attachment === 1 || attachments.length > 0,
    htmlBody: row.html_body ?? undefined,
    id: row.id,
    keywords: parseJsonRecord(row.keywords_json),
    mailboxIds: parseJsonRecord(row.mailbox_ids_json),
    pinned: row.pinned === 1,
    preview: row.preview,
    sender: row.sender,
    subject: row.subject,
    to: row.to_addresses ?? undefined,
    unread: row.unread === 1,
  };
}

function parseJsonArray<T>(value: string) {
  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, true>)
      : {};
  } catch {
    return {};
  }
}

function boolToInt(value: boolean) {
  return value ? 1 : 0;
}
