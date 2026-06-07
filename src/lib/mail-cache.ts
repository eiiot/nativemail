import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { JmapMailbox, JmapMailboxSnapshot, JmapMessageBody, JmapThread } from '@/lib/jmap-client';
import type { Message, MessageAttachment } from '@/lib/mock-mail';

const DATABASE_NAME = 'nativemail-cache.db';
const CACHE_SCHEMA_VERSION = 4;
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
    avatar_url TEXT,
    avatar_color TEXT NOT NULL,
    from_email TEXT,
    to_addresses TEXT,
    to_addresses_json TEXT NOT NULL DEFAULT '[]',
    cc_addresses_json TEXT NOT NULL DEFAULT '[]',
    bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
    has_attachment INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    count INTEGER,
    thread_id TEXT,
    keywords_json TEXT NOT NULL DEFAULT '{}',
    mailbox_ids_json TEXT NOT NULL DEFAULT '{}',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    body TEXT,
    html_body TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE IF NOT EXISTS threads (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    email_ids_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );

  CREATE TABLE IF NOT EXISTS thread_emails (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, thread_id, email_id)
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
  CREATE INDEX IF NOT EXISTS thread_emails_order_idx
    ON thread_emails(account_id, thread_id, position);
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
  avatar_url: string | null;
  avatar_color: string;
  from_email: string | null;
  to_addresses: string | null;
  to_addresses_json: string | null;
  cc_addresses_json: string | null;
  bcc_addresses_json: string | null;
  has_attachment: number;
  pinned: number;
  unread: number;
  count: number | null;
  thread_id: string | null;
  keywords_json: string;
  mailbox_ids_json: string;
  attachments_json: string;
  body: string | null;
  html_body: string | null;
};

type ThreadRow = {
  account_id: string;
  id: string;
  email_ids_json: string;
};

export type CachedInboxNotificationMessageInput = {
  accountId: string;
  date?: string | null;
  fromEmail?: string | null;
  inboxUnreadEmails?: number | null;
  mailboxId: string;
  mailboxName?: string | null;
  messageId: string;
  preview?: string | null;
  sender?: string | null;
  subject?: string | null;
  threadId?: string | null;
};

export type CachedInboxStateMessageInput = CachedInboxNotificationMessageInput & {
  keywords?: Record<string, unknown> | null;
  mailboxIds?: Record<string, unknown> | null;
};

export type CachedInboxStateSnapshotInput = {
  accountId: string;
  inboxUnreadEmails?: number | null;
  mailboxId: string;
  mailboxName?: string | null;
  messages: CachedInboxStateMessageInput[];
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
  const threads = await getCachedThreads(db, mailbox.account_id);

  if (!mailboxes.length && !messages.length) {
    return null;
  }

  return {
    accountId: mailbox.account_id,
    mailbox: rowToMailbox(mailbox),
    mailboxes: mailboxes.map(rowToMailbox),
    messages,
    threads,
    username: '',
  };
}

export async function writeCachedMailboxSnapshot(snapshot: JmapMailboxSnapshot) {
  const db = await getMailCacheDatabase();
  const now = Date.now();
  const mailboxId = snapshot.mailbox?.id;

  await db.withExclusiveTransactionAsync(async (txn) => {
    await writeCachedMailboxes(txn, snapshot, now);

    if (mailboxId) {
      await txn.runAsync(
        'DELETE FROM mailbox_emails WHERE account_id = ? AND mailbox_id = ?',
        [snapshot.accountId, mailboxId],
      );
    }

    await writeCachedMailboxMessages(txn, snapshot, now, 0);
    await writeCachedThreads(txn, snapshot, now);
    await writeCachedSnapshotState(txn, snapshot, now, snapshot.messages.length);
  });
}

export async function writeCachedMailboxPage(snapshot: JmapMailboxSnapshot) {
  const db = await getMailCacheDatabase();
  const now = Date.now();
  const startPosition = snapshot.position ?? 0;

  await db.withExclusiveTransactionAsync(async (txn) => {
    await writeCachedMailboxes(txn, snapshot, now);
    await writeCachedMailboxMessages(txn, snapshot, now, startPosition);
    await writeCachedThreads(txn, snapshot, now);
    await writeCachedSnapshotState(txn, snapshot, now, startPosition + snapshot.messages.length);
  });
}

export async function writeCachedInboxNotificationMessage(
  input: CachedInboxNotificationMessageInput,
) {
  const db = await getMailCacheDatabase();
  const now = Date.now();
  const mailboxName = input.mailboxName?.trim() || 'Inbox';
  const message = cachedInboxInputToMessage(input, mailboxName);

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO mailboxes (
        account_id, id, name, parent_id, role, sort_order, total_emails, unread_emails, updated_at
      ) VALUES (?, ?, ?, NULL, 'inbox', 0, NULL, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET
        name = excluded.name,
        role = COALESCE(mailboxes.role, excluded.role),
        sort_order = COALESCE(mailboxes.sort_order, excluded.sort_order),
        unread_emails = COALESCE(excluded.unread_emails, mailboxes.unread_emails),
        updated_at = excluded.updated_at`,
      [
        input.accountId,
        input.mailboxId,
        mailboxName,
        normalizeCount(input.inboxUnreadEmails),
        now,
      ],
    );
    await writeCachedMessage(txn, input.accountId, message, now);
    const existingPosition = await txn.getFirstAsync<{ position: number }>(
      `SELECT position FROM mailbox_emails
       WHERE account_id = ?
         AND mailbox_id = ?
         AND email_id = ?
       LIMIT 1`,
      [input.accountId, input.mailboxId, input.messageId],
    );

    if (existingPosition?.position === undefined) {
      await txn.runAsync(
        `UPDATE mailbox_emails SET
          position = position + 1,
          updated_at = ?
         WHERE account_id = ?
           AND mailbox_id = ?`,
        [now, input.accountId, input.mailboxId],
      );
    } else if (existingPosition.position > 0) {
      await txn.runAsync(
        `UPDATE mailbox_emails SET
          position = position + 1,
          updated_at = ?
         WHERE account_id = ?
           AND mailbox_id = ?
           AND position < ?`,
        [now, input.accountId, input.mailboxId, existingPosition.position],
      );
    }

    await txn.runAsync(
      `INSERT OR REPLACE INTO mailbox_emails (
        account_id, mailbox_id, email_id, position, updated_at
      ) VALUES (?, ?, ?, 0, ?)`,
      [input.accountId, input.mailboxId, input.messageId, now],
    );
  });
}

export async function writeCachedInboxStateSnapshot(input: CachedInboxStateSnapshotInput) {
  const db = await getMailCacheDatabase();
  const now = Date.now();
  const mailboxName = input.mailboxName?.trim() || 'Inbox';

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO mailboxes (
        account_id, id, name, parent_id, role, sort_order, total_emails, unread_emails, updated_at
      ) VALUES (?, ?, ?, NULL, 'inbox', 0, NULL, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET
        name = excluded.name,
        role = COALESCE(mailboxes.role, excluded.role),
        sort_order = COALESCE(mailboxes.sort_order, excluded.sort_order),
        unread_emails = COALESCE(excluded.unread_emails, mailboxes.unread_emails),
        updated_at = excluded.updated_at`,
      [
        input.accountId,
        input.mailboxId,
        mailboxName,
        normalizeCount(input.inboxUnreadEmails),
        now,
      ],
    );

    if (!input.messages.length) {
      await txn.runAsync(
        `DELETE FROM mailbox_emails
         WHERE account_id = ?
           AND mailbox_id = ?`,
        [input.accountId, input.mailboxId],
      );
      return;
    }

    await txn.runAsync(
      `DELETE FROM mailbox_emails
       WHERE account_id = ?
         AND mailbox_id = ?
         AND position < ?`,
      [input.accountId, input.mailboxId, input.messages.length],
    );

    for (const [index, inputMessage] of input.messages.entries()) {
      const message = cachedInboxInputToMessage(
        {
          ...inputMessage,
          accountId: input.accountId,
          mailboxId: input.mailboxId,
          mailboxName,
        },
        mailboxName,
      );

      await writeCachedMessage(txn, input.accountId, message, now);
      await txn.runAsync(
        `INSERT OR REPLACE INTO mailbox_emails (
          account_id, mailbox_id, email_id, position, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [input.accountId, input.mailboxId, inputMessage.messageId, index, now],
      );
    }
  });
}

async function writeCachedMailboxes(
  db: SQLiteDatabase,
  snapshot: JmapMailboxSnapshot,
  updatedAt: number,
) {
  for (const mailbox of snapshot.mailboxes) {
    await db.runAsync(
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
        updatedAt,
      ],
    );
  }
}

async function writeCachedMailboxMessages(
  db: SQLiteDatabase,
  snapshot: JmapMailboxSnapshot,
  updatedAt: number,
  startPosition: number,
) {
  const mailboxId = snapshot.mailbox?.id;

  for (const [index, message] of snapshot.messages.entries()) {
    await writeCachedMessage(db, snapshot.accountId, message, updatedAt);

    if (mailboxId) {
      await db.runAsync(
        `INSERT OR REPLACE INTO mailbox_emails (
          account_id, mailbox_id, email_id, position, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [snapshot.accountId, mailboxId, message.id, startPosition + index, updatedAt],
      );
    }
  }
}

async function writeCachedThreads(
  db: SQLiteDatabase,
  snapshot: JmapMailboxSnapshot,
  updatedAt: number,
) {
  for (const thread of Object.values(snapshot.threads ?? {})) {
    await writeCachedThread(db, snapshot.accountId, thread, updatedAt);
  }
}

async function writeCachedSnapshotState(
  db: SQLiteDatabase,
  snapshot: JmapMailboxSnapshot,
  updatedAt: number,
  messageCount: number,
) {
  const mailboxId = snapshot.mailbox?.id;

  await db.runAsync(
    `INSERT OR REPLACE INTO sync_state (scope, account_id, state, updated_at)
     VALUES (?, ?, ?, ?)`,
    [
      mailboxId ? `mailbox:${mailboxId}:snapshot` : 'mailbox:unknown:snapshot',
      snapshot.accountId,
      JSON.stringify({
        messageCount,
        total: snapshot.total,
        username: snapshot.username,
      }),
      updatedAt,
    ],
  );
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
    await configureDatabase(db);
    await migrate(db);
    return db;
  });

  return databasePromise;
}

async function configureDatabase(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 1000;
  `);
}

async function migrate(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion >= CACHE_SCHEMA_VERSION) {
    return;
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    if (currentVersion < 1) {
      await txn.execAsync(SCHEMA_SQL);
      return;
    }

    if (currentVersion < 2) {
      await ensureEmailThreadIdColumn(txn);
      await txn.execAsync(`
        CREATE TABLE IF NOT EXISTS threads (
          account_id TEXT NOT NULL,
          id TEXT NOT NULL,
          email_ids_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, id)
        );

        CREATE TABLE IF NOT EXISTS thread_emails (
          account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          email_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, thread_id, email_id)
        );

        CREATE INDEX IF NOT EXISTS thread_emails_order_idx
          ON thread_emails(account_id, thread_id, position);
      `);
    }

    if (currentVersion < 3) {
      await ensureEmailAvatarUrlColumn(txn);
      await txn.execAsync(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION};`);
    }

    if (currentVersion < 4) {
      await ensureEmailRecipientColumns(txn);
      await txn.execAsync(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION};`);
    }
  });
}

async function ensureEmailThreadIdColumn(db: SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(emails)');
  const hasThreadIdColumn = columns.some((column) => column.name === 'thread_id');

  if (!hasThreadIdColumn) {
    await db.execAsync('ALTER TABLE emails ADD COLUMN thread_id TEXT');
  }
}

async function ensureEmailAvatarUrlColumn(db: SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(emails)');
  const hasAvatarUrlColumn = columns.some((column) => column.name === 'avatar_url');

  if (!hasAvatarUrlColumn) {
    await db.execAsync('ALTER TABLE emails ADD COLUMN avatar_url TEXT');
  }
}

async function ensureEmailRecipientColumns(db: SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(emails)');
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('to_addresses_json')) {
    await db.execAsync("ALTER TABLE emails ADD COLUMN to_addresses_json TEXT NOT NULL DEFAULT '[]'");
  }

  if (!columnNames.has('cc_addresses_json')) {
    await db.execAsync("ALTER TABLE emails ADD COLUMN cc_addresses_json TEXT NOT NULL DEFAULT '[]'");
  }

  if (!columnNames.has('bcc_addresses_json')) {
    await db.execAsync("ALTER TABLE emails ADD COLUMN bcc_addresses_json TEXT NOT NULL DEFAULT '[]'");
  }
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

async function getCachedThreads(db: SQLiteDatabase, accountId: string) {
  const rows = await db.getAllAsync<ThreadRow>(
    'SELECT * FROM threads WHERE account_id = ?',
    accountId,
  );
  const threads: Record<string, JmapThread> = {};

  for (const row of rows) {
    const emailIds = parseJsonArray<string>(row.email_ids_json);
    const messages = await getCachedThreadMessages(db, accountId, row.id);

    threads[row.id] = {
      emailIds,
      id: row.id,
      messages,
    };
  }

  return threads;
}

async function getCachedThreadMessages(db: SQLiteDatabase, accountId: string, threadId: string) {
  const rows = await db.getAllAsync<EmailRow>(
    `SELECT emails.*
     FROM thread_emails
     JOIN emails
       ON emails.account_id = thread_emails.account_id
      AND emails.id = thread_emails.email_id
     WHERE thread_emails.account_id = ?
       AND thread_emails.thread_id = ?
     ORDER BY thread_emails.position ASC`,
    [accountId, threadId],
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
      account_id, id, sender, subject, preview, date, avatar, avatar_url, avatar_color,
      from_email, to_addresses, to_addresses_json, cc_addresses_json, bcc_addresses_json,
      has_attachment, pinned, unread, count,
      thread_id, keywords_json, mailbox_ids_json, attachments_json, body, html_body, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, id) DO UPDATE SET
      sender = excluded.sender,
      subject = excluded.subject,
      preview = excluded.preview,
      date = excluded.date,
      avatar = excluded.avatar,
      avatar_url = COALESCE(excluded.avatar_url, emails.avatar_url),
      avatar_color = excluded.avatar_color,
      from_email = excluded.from_email,
      to_addresses = excluded.to_addresses,
      to_addresses_json = excluded.to_addresses_json,
      cc_addresses_json = excluded.cc_addresses_json,
      bcc_addresses_json = excluded.bcc_addresses_json,
      has_attachment = excluded.has_attachment,
      pinned = excluded.pinned,
      unread = excluded.unread,
      count = excluded.count,
      thread_id = excluded.thread_id,
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
      message.avatarUrl ?? null,
      message.avatarColor,
      message.fromEmail ?? null,
      message.to ?? null,
      JSON.stringify(message.toAddresses ?? parseAddressList(message.to)),
      JSON.stringify(message.ccAddresses ?? []),
      JSON.stringify(message.bccAddresses ?? []),
      boolToInt(Boolean(message.hasAttachment)),
      boolToInt(Boolean(message.pinned)),
      boolToInt(Boolean(message.unread)),
      message.count ?? null,
      message.threadId ?? null,
      JSON.stringify(message.keywords ?? {}),
      JSON.stringify(message.mailboxIds ?? {}),
      JSON.stringify(message.attachments ?? []),
      message.body ?? null,
      message.htmlBody ?? null,
      updatedAt,
    ],
  );
}

async function writeCachedThread(
  db: SQLiteDatabase,
  accountId: string,
  thread: JmapThread,
  updatedAt: number,
) {
  await db.runAsync(
    `INSERT INTO threads (
      account_id, id, email_ids_json, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, id) DO UPDATE SET
      email_ids_json = excluded.email_ids_json,
      updated_at = excluded.updated_at`,
    [accountId, thread.id, JSON.stringify(thread.emailIds), updatedAt],
  );

  await db.runAsync(
    'DELETE FROM thread_emails WHERE account_id = ? AND thread_id = ?',
    [accountId, thread.id],
  );

  for (const [position, message] of thread.messages.entries()) {
    await writeCachedMessage(db, accountId, message, updatedAt);
    await db.runAsync(
      `INSERT OR REPLACE INTO thread_emails (
        account_id, thread_id, email_id, position, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [accountId, thread.id, message.id, position, updatedAt],
    );
  }
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
  const toAddresses = parseJsonArray<string>(row.to_addresses_json ?? '');

  return {
    attachments,
    avatar: row.avatar ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
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
    threadId: row.thread_id ?? undefined,
    to: row.to_addresses ?? undefined,
    toAddresses: toAddresses.length ? toAddresses : parseAddressList(row.to_addresses),
    ccAddresses: parseJsonArray<string>(row.cc_addresses_json ?? ''),
    bccAddresses: parseJsonArray<string>(row.bcc_addresses_json ?? ''),
    unread: row.unread === 1,
  };
}

function parseAddressList(value?: string | null) {
  return value
    ? value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
    : [];
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

function cachedInboxInputToMessage(
  input: CachedInboxNotificationMessageInput | CachedInboxStateMessageInput,
  mailboxName: string,
): Message {
  const sender = input.sender?.trim() || input.fromEmail?.trim() || 'New mail';
  const fallbackMailboxIds: Record<string, true> = { [input.mailboxId]: true };
  const keywords = isStateMessageInput(input) ? normalizeTrueRecord(input.keywords) : {};
  const mailboxIds = isStateMessageInput(input)
    ? normalizeTrueRecord(input.mailboxIds, fallbackMailboxIds)
    : fallbackMailboxIds;
  const unread = isStateMessageInput(input) ? keywords.$seen !== true : true;

  return {
    avatar: getInitials(sender),
    avatarColor: colorForString(input.fromEmail ?? sender),
    date: formatMessageDate(input.date ?? null),
    fromEmail: input.fromEmail ?? undefined,
    id: input.messageId,
    keywords,
    mailboxIds,
    mailboxName,
    pinned: keywords.$flagged === true,
    preview: input.preview ?? '',
    sender,
    subject: input.subject?.trim() || '(No subject)',
    threadId: input.threadId?.trim() || input.messageId,
    unread,
  };
}

function isStateMessageInput(
  input: CachedInboxNotificationMessageInput | CachedInboxStateMessageInput,
): input is CachedInboxStateMessageInput {
  return 'keywords' in input || 'mailboxIds' in input;
}

function normalizeTrueRecord(
  value: Record<string, unknown> | null | undefined,
  fallback: Record<string, true> = {},
) {
  if (!value) {
    return fallback;
  }

  const record: Record<string, true> = {};

  for (const [key, enabled] of Object.entries(value)) {
    if (enabled === true) {
      record[key] = true;
    }
  }

  return record;
}

function normalizeCount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function formatMessageDate(value: string | null) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const today = new Date();

  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : '2-digit',
  });
}

function getInitials(value: string) {
  const parts = value
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return '?';
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function colorForString(value: string) {
  const palette = [
    '#2E7BEF',
    '#0F6B59',
    '#8D54E8',
    '#D16B24',
    '#C3437A',
    '#287C89',
  ];
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }

  return palette[Math.abs(hash) % palette.length] ?? palette[0];
}
