import '@/lib/jmap-polyfills'

import {
    getFastmailDomainAvatarUrl,
    getFastmailProfilePhotoUrl,
} from '@/lib/avatar-photos'
import { getFastmailJmapToken } from '@/lib/fastmail-token'
import type { Message, MessageAttachment } from '@/lib/mock-mail'
import { observeDuration, observeError, observeEvent } from '@/lib/observability'
import {
    createStateTracker,
    type SyncStateSnapshot,
} from '@/lib/sync-engine'
import {
    EMAIL_CAPABILITY_URI,
    Email,
    EmailCapability,
    JMAPClient,
    Mailbox,
    Thread,
    isErrorInvocation,
    type EmailAddress,
    type EmailBodyPart,
    type EmailObject,
    type Id,
    type MailboxObject,
    type PatchObject,
    type ThreadObject,
    type Transport,
    type TransportRequestOptions,
} from 'jmap-kit'

const FASTMAIL_JMAP_HOSTNAME = 'api.fastmail.com'
const DEFAULT_MESSAGE_LIMIT = 50
const MAX_ATTACHMENT_PREVIEW_BYTES = 10 * 1024 * 1024
const EMAIL_SET_MAX_ATTEMPTS = 3
const EMAIL_SET_RETRY_DELAYS_MS = [160, 500]

const mailboxProperties = [
    'id',
    'name',
    'parentId',
    'role',
    'sortOrder',
    'totalEmails',
    'unreadEmails',
] satisfies (keyof MailboxObject)[]

const emailSummaryProperties = [
    'id',
    'threadId',
    'mailboxIds',
    'keywords',
    'receivedAt',
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'preview',
    'hasAttachment',
    'attachments',
    'header:BIMI-Location:asText',
    'header:BIMI-Location:asURLs',
    'header:BIMI-Indicator:asText',
    'header:BIMI-Indicator:asURLs',
] satisfies (keyof EmailObject)[]

const emailDetailProperties = [
    ...emailSummaryProperties,
    'bodyValues',
    'htmlBody',
    'textBody',
] satisfies (keyof EmailObject)[]

const emailBodyProperties = [
    'attachments',
    'bodyStructure',
    'bodyValues',
    'hasAttachment',
    'htmlBody',
    'textBody',
] satisfies (keyof EmailObject)[]

const emailBodyPartProperties = [
    'partId',
    'blobId',
    'size',
    'name',
    'type',
    'cid',
    'disposition',
    'location',
    'subParts',
] satisfies (keyof EmailBodyPart)[]

const emailMetadataProperties = [
    'id',
    'mailboxIds',
    'keywords',
] satisfies (keyof EmailObject)[]

const threadProperties = [
    'id',
    'emailIds',
] satisfies (keyof ThreadObject)[]

export type JmapMailbox = Pick<
    MailboxObject,
    | 'id'
    | 'name'
    | 'parentId'
    | 'role'
    | 'sortOrder'
    | 'totalEmails'
    | 'unreadEmails'
>

export type JmapMailboxSnapshot = {
    accountId: Id
    mailbox: JmapMailbox | null
    mailboxes: JmapMailbox[]
    messages: Message[]
    position?: number
    threads?: Record<string, JmapThread>
    total?: number | null
    username: string
}

export type JmapThread = {
    emailIds: Id[]
    id: Id
    messages: Message[]
}

export type JmapDiagnosticStep = {
    detail: string
    label: string
    status: 'error' | 'ok'
}

export type JmapDiagnosticReport = {
    steps: JmapDiagnosticStep[]
}

export type JmapMessageBody = {
    attachments: MessageAttachment[]
    debug?: JmapMessageBodyDebug
    html: string | null
    text: string | null
}

export type JmapMessageBodyDebug = {
    attachmentPartCount: number
    bodyStructurePartCount: number
    cidImageInlineMode?: 'inline' | 'skipped'
    cidImagePartCount: number
    cidImageParts: {
        blobIdPrefix?: string
        cid: string
        hasBlobId: boolean
        location?: string | null
        name?: string | null
        type?: string | null
    }[]
    cidReferenceCount: number
    cidReferences: string[]
    downloadUrlErrorCount: number
    generatedDownloadUrlCount: number
    generatedDownloadUrlHosts: string[]
    htmlBodyPartCount: number
    htmlContainsCidAfterRewrite: boolean
    inlineImageErrors: string[]
    replacedCidReferenceCount: number
    unresolvedCidReferences: string[]
}

export type JmapMessageActionResult = {
    keywords?: Record<string, true>
    mailboxIds?: Record<string, true>
    pinned?: boolean
    unread?: boolean
}

export type JmapEmailSetPatch = PatchObject

export type JmapEmailSetNotUpdated = {
    description?: string
    type?: string
}

export type JmapEmailSetBatchResult = {
    notUpdated: Record<string, JmapEmailSetNotUpdated>
    updatedIds: string[]
}

export type JmapMessageNotificationState = {
    exists: boolean
    id: string
    inInbox: boolean
    keywords: Record<string, true>
    mailboxIds: Record<string, true>
    unread: boolean
}

export type JmapKnownMailboxStateInput = {
    mailboxIds?: Record<string, true> | null
    mailboxes?: JmapMailbox[] | null
    messageId: string
    signal?: AbortSignal
}

let emailSetQueue: Promise<void> = Promise.resolve()

export class FastmailJmapTokenMissingError extends Error {
    constructor() {
        super('No Fastmail JMAP token is configured.')
        this.name = 'FastmailJmapTokenMissingError'
    }
}

type SharedFastmailJmapClient = {
    accountId: Id
    client: JMAPClient
    disconnect: () => Promise<void>
    token: string
}

let sharedFastmailJmapClient: SharedFastmailJmapClient | null = null
let sharedFastmailJmapClientPromise: Promise<SharedFastmailJmapClient> | null =
    null
let activeTransportRequestCount = 0
let transportRequestSequence = 0

const SLOW_TRANSPORT_REQUEST_MS = 1000
// Every request is a plain stock fetch with no scheduler and no retry, so this
// JS timer is the only thing that bounds a connection that hangs waiting for
// the first byte (the iOS-level timeouts don't reliably fire). Match the direct
// body fetch's budget so a legitimately slow-but-working request isn't killed;
// a genuinely hung request fails here and the caller refetches on next use.
const TRANSPORT_REQUEST_TIMEOUT_MS = 12000
const TRANSPORT_BLOB_TIMEOUT_MS = 30000

function createJmapTransportTimeoutError(timeoutMs: number) {
    const error = new Error(`JMAP request timed out after ${timeoutMs}ms`)
    error.name = 'JmapTransportTimeoutError'
    return error
}

// Server state strings recorded from snapshot fetches, used to skip a
// refresh when nothing changed server-side. A mailbox view only counts as
// fresh if its snapshot was fetched since the last recorded state change;
// state strings are account-global, so an older cached view of another
// mailbox must not be treated as current.
const mailStateTracker = createStateTracker()
let mailboxesFreshForCurrentState = new Set<string>()
let lastKnownInboxMailboxId: string | null = null

function recordMailboxViewStates(states: SyncStateSnapshot, mailboxKey: string) {
    if (!Object.keys(states).length) {
        return
    }

    if (!mailStateTracker.isCurrent(states)) {
        mailboxesFreshForCurrentState = new Set()
    }

    mailStateTracker.recordStates(states)
    mailboxesFreshForCurrentState.add(mailboxKey)
}

export async function createFastmailJmapClient(
    _signal?: AbortSignal,
    operation?: string
) {
    const operationPrefix = operation ? `jmap.${operation}` : null
    const tokenStartedAt = Date.now()
    const token = await getFastmailJmapToken()

    if (operationPrefix) {
        observeDuration(`${operationPrefix}.token`, tokenStartedAt, {
            hasToken: Boolean(token),
        })
    }

    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const connectStartedAt = Date.now()
    const sharedClient = await getSharedFastmailJmapClient(token)
    const { accountId, client } = sharedClient

    if (operationPrefix) {
        observeDuration(`${operationPrefix}.connect`, connectStartedAt, {
            accountCount: Object.keys(client.accounts ?? {}).length,
            shared: true,
            username: client.username ? 'present' : 'missing',
        })
    }

    return { accountId, client, token }
}

async function getSharedFastmailJmapClient(
    token: string
): Promise<SharedFastmailJmapClient> {
    if (
        sharedFastmailJmapClient?.token === token &&
        sharedFastmailJmapClient.client.connectionStatus === 'connected'
    ) {
        observeEvent('jmap.shared-client.reuse', {
            connectionStatus: sharedFastmailJmapClient.client.connectionStatus,
        })
        return sharedFastmailJmapClient
    }

    if (
        sharedFastmailJmapClient &&
        (sharedFastmailJmapClient.token !== token ||
            sharedFastmailJmapClient.client.connectionStatus !== 'connected')
    ) {
        await disconnectSharedFastmailJmapClient(
            sharedFastmailJmapClient.token !== token
                ? 'token-changed'
                : 'not-connected'
        )
    }

    if (sharedFastmailJmapClientPromise) {
        const pendingClient = await sharedFastmailJmapClientPromise

        if (pendingClient.token === token) {
            sharedFastmailJmapClient = pendingClient
            observeEvent('jmap.shared-client.reuse-pending', {
                connectionStatus: pendingClient.client.connectionStatus,
            })
            return pendingClient
        }

        observeEvent('jmap.shared-client.disconnect', {
            connectionStatus: pendingClient.client.connectionStatus,
            reason: 'pending-token-changed',
        })
        await pendingClient.disconnect()

        if (sharedFastmailJmapClient === pendingClient) {
            sharedFastmailJmapClient = null
        }
    }

    const promise = connectSharedFastmailJmapClient(token)

    sharedFastmailJmapClientPromise = promise

    try {
        const client = await promise

        sharedFastmailJmapClient = client

        return client
    } finally {
        if (sharedFastmailJmapClientPromise === promise) {
            sharedFastmailJmapClientPromise = null
        }
    }
}

async function connectSharedFastmailJmapClient(
    token: string
): Promise<SharedFastmailJmapClient> {
    const startedAt = Date.now()
    const client = new JMAPClient(createBearerTransport(token, 'shared'), {
        hostname: FASTMAIL_JMAP_HOSTNAME,
    })

    await client.registerCapabilities(EmailCapability)
    await client.connect()

    const accountId = client.primaryAccounts[EMAIL_CAPABILITY_URI]

    if (!accountId) {
        await client.disconnect()
        throw new Error(
            'Fastmail JMAP session did not include a primary mail account.'
        )
    }

    observeDuration('jmap.shared-client.connect.success', startedAt, {
        accountCount: Object.keys(client.accounts ?? {}).length,
        connectionStatus: client.connectionStatus,
        username: client.username ? 'present' : 'missing',
    })

    return {
        accountId,
        client,
        disconnect: client.disconnect.bind(client),
        token,
    }
}

/**
 * Sends one tiny request over the shared client so its pooled HTTP/2
 * connection to Fastmail stays alive. Idle connections get dropped (NAT
 * timeout / iOS pool staleness); reusing a dead one black-holes the next
 * real request for seconds. Pinging on an interval while foregrounded keeps
 * the connection warm so message opens hit a live connection (~150ms) instead
 * of a dead one. Cheap: Mailbox/get with ids:[] returns no records.
 */
export async function keepFastmailConnectionWarm(signal?: AbortSignal) {
    const startedAt = Date.now()

    try {
        const { accountId, client } = await createFastmailJmapClient(
            signal,
            'keepalive'
        )

        try {
            await client
                .createRequestBuilder()
                .add(Mailbox.request.get({ accountId, ids: [], properties: ['id'] }))
                .send(signal)

            observeDuration('jmap.keepalive.success', startedAt, {})
        } finally {
            await releaseFastmailJmapClient(client)
        }
    } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
            return
        }

        observeError('jmap.keepalive.failed', error, {})
    }
}

async function disconnectSharedFastmailJmapClient(reason: string) {
    const sharedClient = sharedFastmailJmapClient

    sharedFastmailJmapClient = null
    sharedFastmailJmapClientPromise = null

    if (!sharedClient) {
        return
    }

    observeEvent('jmap.shared-client.disconnect', {
        connectionStatus: sharedClient.client.connectionStatus,
        reason,
    })
    await sharedClient.disconnect()
}

async function releaseFastmailJmapClient(client: JMAPClient) {
    if (sharedFastmailJmapClient?.client === client) {
        observeEvent('jmap.shared-client.release', {
            connectionStatus: client.connectionStatus,
        })
        return
    }

    await client.disconnect()
}

export async function fetchJmapMailboxes(signal?: AbortSignal) {
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        return await getMailboxes(client, accountId, signal)
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

export async function fetchJmapMessageNotificationStates(
    messageIds: string[],
    signal?: AbortSignal
): Promise<Record<string, JmapMessageNotificationState>> {
    const ids = Array.from(new Set(messageIds.filter(Boolean)))

    if (!ids.length) {
        return {}
    }

    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const mailboxes = await getMailboxes(client, accountId, signal)
        const inbox = findMailboxByRole(mailboxes, 'inbox')
        const emails = await getEmails(
            client,
            accountId,
            ids,
            emailMetadataProperties,
            signal
        )
        const emailById = new Map(emails.map((email) => [email.id, email]))
        const states: Record<string, JmapMessageNotificationState> = {}

        for (const id of ids) {
            const email = emailById.get(id)
            const keywords = normalizeTrueRecord(email?.keywords)
            const mailboxIds = normalizeTrueRecord(email?.mailboxIds)
            const exists = Boolean(email)

            states[id] = {
                exists,
                id,
                inInbox: exists && Boolean(inbox && mailboxIds[inbox.id]),
                keywords,
                mailboxIds,
                unread: exists && keywords.$seen !== true,
            }
        }

        return states
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

export async function fetchJmapMailboxSnapshot({
    mailboxId,
    limit = DEFAULT_MESSAGE_LIMIT,
    position = 0,
    signal,
}: {
    mailboxId?: string | null
    limit?: number
    position?: number
    signal?: AbortSignal
} = {}): Promise<JmapMailboxSnapshot> {
    const startedAt = Date.now()
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        let mailboxes: JmapMailbox[] | null = null
        let targetMailboxId = mailboxId ?? lastKnownInboxMailboxId

        if (!targetMailboxId) {
            mailboxes = await getMailboxes(client, accountId, signal)
            targetMailboxId = findMailbox(mailboxes, null)?.id ?? null
        }

        let mailbox: JmapMailbox | null = null
        let page: { messages: Message[]; position: number; total: number | null } | null =
            null
        let threads: Record<string, JmapThread> = {}

        if (targetMailboxId) {
            let batch: Awaited<ReturnType<typeof getMailboxSnapshotBatch>> | null = null

            try {
                batch = await getMailboxSnapshotBatch(
                    client,
                    accountId,
                    targetMailboxId,
                    position,
                    limit,
                    signal
                )
            } catch (error: unknown) {
                // The target mailbox may have been deleted since we learned
                // its id. Refetch the list; if it is gone, fall through to an
                // empty snapshot like the pre-batch behavior, otherwise rethrow.
                mailboxes = await getMailboxes(client, accountId, signal)

                if (findMailbox(mailboxes, targetMailboxId)) {
                    throw error
                }
            }

            if (batch) {
                mailboxes = batch.mailboxes
                mailbox = findMailbox(batch.mailboxes, targetMailboxId)
                page = {
                    messages: batch.messages,
                    position: batch.position,
                    total: batch.total,
                }
                threads = await buildThreadMap(
                    client,
                    accountId,
                    batch.threads,
                    batch.messages,
                    batch.mailboxes,
                    signal
                )
                recordMailboxViewStates(batch.states, mailbox?.id ?? targetMailboxId)
            }
        }

        if (!mailboxes) {
            mailboxes = []
        }

        lastKnownInboxMailboxId =
            findMailbox(mailboxes, null)?.id ?? lastKnownInboxMailboxId

        const messages = page?.messages
            ? applyThreadCountsToMessages(page.messages, threads)
            : []
        const snapshot = {
            accountId,
            mailbox,
            mailboxes,
            messages,
            position: page?.position ?? position,
            threads,
            total: page?.total ?? null,
            username: client.username,
        }

        observeDuration('jmap.mailbox-snapshot.success', startedAt, {
            limit,
            mailboxId: mailbox?.id ?? mailboxId ?? 'inbox',
            mailboxRole: mailbox?.role ?? 'none',
            messages: snapshot.messages.length,
            position: snapshot.position,
            total: snapshot.total ?? -1,
        })

        return snapshot
    } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
            observeEvent('jmap.mailbox-snapshot.canceled', {
                limit,
                mailboxId: mailboxId ?? 'inbox',
                position,
            })
        } else {
            observeError('jmap.mailbox-snapshot.failed', error, {
                limit,
                mailboxId: mailboxId ?? 'inbox',
                position,
            })
        }
        throw error
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

export async function fetchJmapMessage(
    messageId: string,
    signal?: AbortSignal
) {
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const messages = await getEmails(
            client,
            accountId,
            [messageId],
            emailDetailProperties,
            signal
        )
        const message = messages[0]

        return message ? mapEmailToMessage(message) : null
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

// Simplest possible body fetch: tap email -> one direct request for its body
// -> parse -> show. No shared client, scheduler, dedup, pacing, retries, or
// keepalive — none of the machinery that was burying (and likely causing) the
// slowness. The JMAP session (apiUrl + accountId) is fetched once and cached.
const DIRECT_SESSION_URL = 'https://api.fastmail.com/jmap/session'
const DIRECT_BODY_TIMEOUT_MS = 12000
let cachedDirectSession: { accountId: Id; apiUrl: string; token: string } | null = null

async function getDirectJmapSession(token: string, signal?: AbortSignal) {
    if (cachedDirectSession && cachedDirectSession.token === token) {
        return cachedDirectSession
    }
    const response = await fetch(DIRECT_SESSION_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
    })
    if (!response.ok) {
        throw new Error(await getErrorMessage(response, 'GET'))
    }
    const session = (await response.json()) as {
        apiUrl?: string
        primaryAccounts?: Record<string, string>
    }
    const accountId = session.primaryAccounts?.[EMAIL_CAPABILITY_URI]
    const apiUrl = session.apiUrl
    if (!accountId || !apiUrl) {
        throw new Error('Fastmail JMAP session is missing the mail account.')
    }
    cachedDirectSession = { accountId, apiUrl, token }
    return cachedDirectSession
}

function buildMessageBodyFromEmail(email: EmailObject): JmapMessageBody {
    const html = getHtmlBody(email)
    return {
        attachments: getDownloadableAttachments(email, html),
        html: html ?? null,
        text: getPlainTextBody(email, { allowPreviewFallback: true }),
    }
}

export async function fetchJmapMessageBody({
    messageId,
    signal,
}: {
    inlineCidImageData?: boolean
    messageId: string
    signal?: AbortSignal
}): Promise<JmapMessageBody | null> {
    const startedAt = Date.now()
    const token = await getFastmailJmapToken()
    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const { accountId, apiUrl } = await getDirectJmapSession(token, signal)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DIRECT_BODY_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                using: ['urn:ietf:params:jmap:core', EMAIL_CAPABILITY_URI],
                methodCalls: [
                    [
                        'Email/get',
                        {
                            accountId,
                            ids: [messageId],
                            properties: emailBodyProperties,
                            bodyProperties: emailBodyPartProperties,
                            fetchHTMLBodyValues: true,
                            fetchTextBodyValues: true,
                        },
                        '0',
                    ],
                ],
            }),
            signal: controller.signal,
        })

        if (!response.ok) {
            throw new Error(await getErrorMessage(response, 'POST'))
        }

        const json = (await response.json()) as {
            methodResponses?: [
                string,
                { list?: EmailObject[]; type?: string },
                string,
            ][]
        }
        const invocation = json.methodResponses?.[0]
        if (invocation?.[0] === 'error') {
            throw new Error(`JMAP Email/get: ${invocation[1]?.type ?? 'unknown'}`)
        }
        const email = invocation?.[1]?.list?.[0]
        const body = email ? buildMessageBodyFromEmail(email) : null

        observeDuration('jmap.message-body.success', startedAt, {
            hasBody: Boolean(body),
            html: body?.html?.trim() ? body.html.length : 0,
            messageId,
            text: body?.text?.trim() ? body.text.length : 0,
        })

        return body
    } catch (error: unknown) {
        observeError('jmap.message-body.failed', error, { messageId })
        throw error
    } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
    }
}

export async function fetchJmapThreadMessages({
    messageId,
    signal,
    threadId,
}: {
    messageId: string
    signal?: AbortSignal
    threadId?: string | null
}): Promise<Message[]> {
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        let resolvedThreadId = threadId ?? null

        if (!resolvedThreadId) {
            const messages = await getEmails(
                client,
                accountId,
                [messageId],
                emailSummaryProperties,
                signal
            )

            resolvedThreadId = messages[0]?.threadId ?? null

            if (!resolvedThreadId) {
                return messages.map((email) => mapEmailToMessage(email))
            }
        }

        const thread = await getThread(client, accountId, resolvedThreadId, signal)
        const emailIds = thread?.emailIds?.length ? thread.emailIds : [messageId]
        const mailboxes = await getMailboxes(client, accountId, signal)
        const emails = await getEmails(
            client,
            accountId,
            emailIds,
            emailSummaryProperties,
            signal
        )

        return emails.map((email) => mapEmailToMessage(email, mailboxes))
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

export async function archiveJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'archive', signal)
}

export async function archiveJmapEmailWithMailboxState({
    mailboxIds,
    mailboxes,
    messageId,
    signal,
}: JmapKnownMailboxStateInput): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRoleWithMailboxState({
        mailboxIds,
        mailboxes,
        messageId,
        role: 'archive',
        signal,
    })
}

export async function unarchiveJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'inbox', signal)
}

export async function unarchiveJmapEmailWithMailboxState({
    mailboxIds,
    mailboxes,
    messageId,
    signal,
}: JmapKnownMailboxStateInput): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRoleWithMailboxState({
        mailboxIds,
        mailboxes,
        messageId,
        role: 'inbox',
        signal,
    })
}

export async function trashJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'trash', signal)
}

export async function trashJmapEmailWithMailboxState({
    mailboxIds,
    mailboxes,
    messageId,
    signal,
}: JmapKnownMailboxStateInput): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRoleWithMailboxState({
        mailboxIds,
        mailboxes,
        messageId,
        role: 'trash',
        signal,
    })
}

export async function setJmapEmailPinned(
    messageId: string,
    pinned: boolean,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return updateJmapEmailKeywords(messageId, '$flagged', pinned, signal)
}

export async function setJmapEmailUnread(
    messageId: string,
    unread: boolean,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return updateJmapEmailKeywords(messageId, '$seen', !unread, signal)
}

export async function applyJmapEmailSetBatch(
    updates: Record<string, JmapEmailSetPatch>,
    signal?: AbortSignal
): Promise<JmapEmailSetBatchResult> {
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        return updateEmails(client, accountId, updates, signal)
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

export function getJmapMailboxIdsForRole({
    currentMailboxIds,
    mailboxes,
    role,
}: {
    currentMailboxIds?: Record<string, true> | null
    mailboxes?: JmapMailbox[] | null
    role: 'archive' | 'inbox' | 'trash'
}): Record<string, true> | null {
    const targetMailbox = mailboxes?.length ? findMailboxByRole(mailboxes, role) : null

    if (!targetMailbox || (!currentMailboxIds && role !== 'trash')) {
        return null
    }

    if (role === 'trash') {
        return { [targetMailbox.id]: true as true }
    }

    if (role === 'inbox') {
        return getUnarchivedMailboxIds(
            currentMailboxIds ?? {},
            mailboxes ?? [],
            targetMailbox.id
        )
    }

    return getArchivedMailboxIds(
        currentMailboxIds ?? {},
        mailboxes ?? [],
        targetMailbox.id
    )
}

export async function diagnoseFastmailJmap(
    signal?: AbortSignal
): Promise<JmapDiagnosticReport> {
    const steps: JmapDiagnosticStep[] = []
    const token = await getFastmailJmapToken()

    if (!token) {
        return {
            steps: [
                {
                    detail: 'Save a Fastmail JMAP API token before testing.',
                    label: 'Stored token',
                    status: 'error',
                },
            ],
        }
    }

    steps.push({
        detail: `Found a stored token (${token.length} characters).`,
        label: 'Stored token',
        status: 'ok',
    })

    const client = new JMAPClient(createBearerTransport(token), {
        hostname: FASTMAIL_JMAP_HOSTNAME,
    })

    try {
        await client.registerCapabilities(EmailCapability)
        await client.connect(signal)

        const accountId = client.primaryAccounts[EMAIL_CAPABILITY_URI]

        steps.push({
            detail: `Connected as ${client.username || 'unknown user'} with ${Object.keys(client.accounts ?? {}).length} account(s).`,
            label: 'Session discovery',
            status: 'ok',
        })

        if (!client.isSupported(EMAIL_CAPABILITY_URI) || !accountId) {
            steps.push({
                detail: 'The session did not advertise a primary mail account.',
                label: 'Mail capability',
                status: 'error',
            })

            return { steps }
        }

        steps.push({
            detail: `Mail account ${accountId} is available.`,
            label: 'Mail capability',
            status: 'ok',
        })

        const mailboxes = await getMailboxes(client, accountId, signal)
        const inbox = findMailbox(mailboxes, null)

        steps.push({
            detail: `Fetched ${mailboxes.length} mailbox(es).`,
            label: 'Mailbox/get',
            status: 'ok',
        })

        if (!inbox) {
            steps.push({
                detail: 'No inbox mailbox was returned.',
                label: 'Inbox mailbox',
                status: 'error',
            })

            return { steps }
        }

        steps.push({
            detail: `${inbox.name} has ${inbox.totalEmails} email(s), ${inbox.unreadEmails} unread.`,
            label: 'Inbox mailbox',
            status: 'ok',
        })

        const messages = await getMailboxMessages(
            client,
            accountId,
            inbox.id,
            5,
            signal
        )

        steps.push({
            detail: `Fetched ${messages.length} recent message(s).`,
            label: 'Email/query',
            status: 'ok',
        })

        return { steps }
    } catch (error) {
        steps.push({
            detail: describeJmapError(error, { includeStack: true }),
            label: 'JMAP request',
            status: 'error',
        })

        return { steps }
    } finally {
        await client.disconnect()
    }
}

export function describeJmapError(
    error: unknown,
    options: { includeStack?: boolean } = {}
) {
    if (error instanceof Error) {
        if (options.includeStack && error.stack) {
            return error.stack
        }

        return error.message
    }

    return String(error)
}

export async function probeFastmailJmapSession({
    messageId,
    reason,
}: {
    messageId?: string
    reason: string
}) {
    const startedAt = Date.now()
    const tokenStartedAt = Date.now()
    const token = await getFastmailJmapToken()

    observeDuration('jmap.session-probe.token', tokenStartedAt, {
        hasToken: Boolean(token),
        messageId: messageId ?? 'none',
        reason,
    })

    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const requestId = `probe-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const requestUrl = getFastmailRequestUrl(
        `https://${FASTMAIL_JMAP_HOSTNAME}/.well-known/jmap`
    )
    const path = getObservabilityPath(requestUrl)
    const fetchStartedAt = Date.now()

    observeEvent('jmap.session-probe.fetch.call', {
        activeTransportRequestCount,
        messageId: messageId ?? 'none',
        path,
        reason,
        requestId,
    })

    let response: Response

    try {
        response = await fetch(requestUrl, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
            method: 'GET',
        })
    } catch (error: unknown) {
        observeError('jmap.session-probe.fetch.failed', error, {
            activeTransportRequestCount,
            messageId: messageId ?? 'none',
            path,
            reason,
            requestId,
        })
        throw error
    }

    observeDuration('jmap.session-probe.fetch.response', fetchStartedAt, {
        activeTransportRequestCount,
        ...getResponseHeaderObservability(response),
        messageId: messageId ?? 'none',
        path,
        reason,
        requestId,
        status: response.status,
    })

    const textStartedAt = Date.now()
    let text = ''

    try {
        text = await response.text()
    } catch (error: unknown) {
        observeError('jmap.session-probe.text.failed', error, {
            activeTransportRequestCount,
            messageId: messageId ?? 'none',
            path,
            reason,
            requestId,
            status: response.status,
        })
        throw error
    }

    observeDuration('jmap.session-probe.text.success', textStartedAt, {
        activeTransportRequestCount,
        length: text.length,
        messageId: messageId ?? 'none',
        path,
        reason,
        requestId,
        status: response.status,
    })

    if (!response.ok) {
        throw new Error(`Fastmail session probe failed with HTTP ${response.status}`)
    }

    observeDuration('jmap.session-probe.success', startedAt, {
        activeTransportRequestCount,
        length: text.length,
        messageId: messageId ?? 'none',
        path,
        reason,
        requestId,
        status: response.status,
    })
}

export async function probeFastmailMessageMetadata({
    messageId,
    reason,
}: {
    messageId: string
    reason: string
}) {
    const startedAt = Date.now()
    const tokenStartedAt = Date.now()
    const token = await getFastmailJmapToken()

    observeDuration('jmap.metadata-probe.token', tokenStartedAt, {
        hasToken: Boolean(token),
        messageId,
        reason,
    })

    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const sessionRequestId = `metadata-session-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const sessionUrl = getFastmailRequestUrl(
        `https://${FASTMAIL_JMAP_HOSTNAME}/.well-known/jmap`
    )
    const sessionPath = getObservabilityPath(sessionUrl)
    const sessionFetchStartedAt = Date.now()

    observeEvent('jmap.metadata-probe.session.fetch.call', {
        activeTransportRequestCount,
        messageId,
        path: sessionPath,
        reason,
        requestId: sessionRequestId,
    })

    let sessionResponse: Response

    try {
        sessionResponse = await fetch(sessionUrl, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
            method: 'GET',
        })
    } catch (error: unknown) {
        observeError('jmap.metadata-probe.session.fetch.failed', error, {
            activeTransportRequestCount,
            messageId,
            path: sessionPath,
            reason,
            requestId: sessionRequestId,
        })
        throw error
    }

    observeDuration(
        'jmap.metadata-probe.session.fetch.response',
        sessionFetchStartedAt,
        {
            activeTransportRequestCount,
            ...getResponseHeaderObservability(sessionResponse),
            messageId,
            path: sessionPath,
            reason,
            requestId: sessionRequestId,
            status: sessionResponse.status,
        }
    )

    const sessionTextStartedAt = Date.now()
    const sessionText = await sessionResponse.text()

    observeDuration('jmap.metadata-probe.session.text.success', sessionTextStartedAt, {
        activeTransportRequestCount,
        length: sessionText.length,
        messageId,
        path: sessionPath,
        reason,
        requestId: sessionRequestId,
        status: sessionResponse.status,
    })

    if (!sessionResponse.ok) {
        throw new Error(
            `Fastmail metadata probe session failed with HTTP ${sessionResponse.status}`
        )
    }

    const sessionParseStartedAt = Date.now()
    const session = JSON.parse(sessionText) as {
        apiUrl?: unknown
        primaryAccounts?: unknown
    }
    const primaryAccounts =
        session.primaryAccounts &&
        typeof session.primaryAccounts === 'object' &&
        !Array.isArray(session.primaryAccounts)
            ? (session.primaryAccounts as Record<string, unknown>)
            : {}
    const accountId =
        typeof primaryAccounts[EMAIL_CAPABILITY_URI] === 'string'
            ? primaryAccounts[EMAIL_CAPABILITY_URI]
            : null
    const apiUrl = typeof session.apiUrl === 'string' ? session.apiUrl : null

    observeDuration('jmap.metadata-probe.session.parse.success', sessionParseStartedAt, {
        accountId: accountId ? 'present' : 'missing',
        apiUrl: apiUrl ? 'present' : 'missing',
        messageId,
        reason,
    })

    if (!accountId || !apiUrl) {
        throw new Error('Fastmail metadata probe session missing apiUrl or accountId')
    }

    const apiRequestId = `metadata-api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const apiRequestUrl = getFastmailRequestUrl(apiUrl)
    const apiPath = getObservabilityPath(apiRequestUrl)
    const body = JSON.stringify({
        using: [EMAIL_CAPABILITY_URI],
        methodCalls: [
            [
                'Email/get',
                {
                    accountId,
                    ids: [messageId],
                    properties: emailMetadataProperties,
                },
                'metadata',
            ],
        ],
    })
    const apiFetchStartedAt = Date.now()

    observeEvent('jmap.metadata-probe.api.fetch.call', {
        activeTransportRequestCount,
        bodyLength: body.length,
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
    })

    let apiResponse: Response

    try {
        apiResponse = await fetch(apiRequestUrl, {
            body,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            method: 'POST',
        })
    } catch (error: unknown) {
        observeError('jmap.metadata-probe.api.fetch.failed', error, {
            activeTransportRequestCount,
            bodyLength: body.length,
            messageId,
            path: apiPath,
            reason,
            requestId: apiRequestId,
        })
        throw error
    }

    observeDuration('jmap.metadata-probe.api.fetch.response', apiFetchStartedAt, {
        activeTransportRequestCount,
        bodyLength: body.length,
        ...getResponseHeaderObservability(apiResponse),
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
        status: apiResponse.status,
    })

    const apiTextStartedAt = Date.now()
    const apiText = await apiResponse.text()

    observeDuration('jmap.metadata-probe.api.text.success', apiTextStartedAt, {
        activeTransportRequestCount,
        length: apiText.length,
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
        status: apiResponse.status,
    })

    if (!apiResponse.ok) {
        throw new Error(`Fastmail metadata probe API failed with HTTP ${apiResponse.status}`)
    }

    const apiParseStartedAt = Date.now()
    const apiJson = JSON.parse(apiText) as { methodResponses?: unknown }
    const methodResponses = Array.isArray(apiJson.methodResponses)
        ? apiJson.methodResponses
        : []
    const firstResponse = methodResponses[0]
    const firstArgs =
        Array.isArray(firstResponse) &&
        firstResponse[1] &&
        typeof firstResponse[1] === 'object' &&
        !Array.isArray(firstResponse[1])
            ? (firstResponse[1] as { list?: unknown })
            : null
    const found =
        firstArgs && Array.isArray(firstArgs.list) ? firstArgs.list.length > 0 : null

    observeDuration('jmap.metadata-probe.api.parse.success', apiParseStartedAt, {
        found,
        length: apiText.length,
        messageId,
        methodResponses: methodResponses.length,
        reason,
    })

    observeDuration('jmap.metadata-probe.success', startedAt, {
        found,
        length: apiText.length,
        messageId,
        methodResponses: methodResponses.length,
        reason,
    })
}

export async function probeFastmailMessageBodyRaw({
    messageId,
    reason,
}: {
    messageId: string
    reason: string
}) {
    const startedAt = Date.now()
    const tokenStartedAt = Date.now()
    const token = await getFastmailJmapToken()

    observeDuration('jmap.raw-body-probe.token', tokenStartedAt, {
        hasToken: Boolean(token),
        messageId,
        reason,
    })

    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const sessionRequestId = `raw-body-session-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const sessionUrl = getFastmailRequestUrl(
        `https://${FASTMAIL_JMAP_HOSTNAME}/.well-known/jmap`
    )
    const sessionPath = getObservabilityPath(sessionUrl)
    const sessionFetchStartedAt = Date.now()

    observeEvent('jmap.raw-body-probe.session.fetch.call', {
        activeTransportRequestCount,
        messageId,
        path: sessionPath,
        reason,
        requestId: sessionRequestId,
    })

    let sessionResponse: Response

    try {
        sessionResponse = await fetch(sessionUrl, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
            method: 'GET',
        })
    } catch (error: unknown) {
        observeError('jmap.raw-body-probe.session.fetch.failed', error, {
            activeTransportRequestCount,
            messageId,
            path: sessionPath,
            reason,
            requestId: sessionRequestId,
        })
        throw error
    }

    observeDuration(
        'jmap.raw-body-probe.session.fetch.response',
        sessionFetchStartedAt,
        {
            activeTransportRequestCount,
            ...getResponseHeaderObservability(sessionResponse),
            messageId,
            path: sessionPath,
            reason,
            requestId: sessionRequestId,
            status: sessionResponse.status,
        }
    )

    const sessionTextStartedAt = Date.now()
    const sessionText = await sessionResponse.text()

    observeDuration('jmap.raw-body-probe.session.text.success', sessionTextStartedAt, {
        activeTransportRequestCount,
        length: sessionText.length,
        messageId,
        path: sessionPath,
        reason,
        requestId: sessionRequestId,
        status: sessionResponse.status,
    })

    if (!sessionResponse.ok) {
        throw new Error(
            `Fastmail raw body probe session failed with HTTP ${sessionResponse.status}`
        )
    }

    const sessionParseStartedAt = Date.now()
    const session = JSON.parse(sessionText) as {
        apiUrl?: unknown
        primaryAccounts?: unknown
    }
    const primaryAccounts =
        session.primaryAccounts &&
        typeof session.primaryAccounts === 'object' &&
        !Array.isArray(session.primaryAccounts)
            ? (session.primaryAccounts as Record<string, unknown>)
            : {}
    const accountId =
        typeof primaryAccounts[EMAIL_CAPABILITY_URI] === 'string'
            ? primaryAccounts[EMAIL_CAPABILITY_URI]
            : null
    const apiUrl = typeof session.apiUrl === 'string' ? session.apiUrl : null

    observeDuration('jmap.raw-body-probe.session.parse.success', sessionParseStartedAt, {
        accountId: accountId ? 'present' : 'missing',
        apiUrl: apiUrl ? 'present' : 'missing',
        messageId,
        reason,
    })

    if (!accountId || !apiUrl) {
        throw new Error('Fastmail raw body probe session missing apiUrl or accountId')
    }

    const apiRequestId = `raw-body-api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const apiRequestUrl = getFastmailRequestUrl(apiUrl)
    const apiPath = getObservabilityPath(apiRequestUrl)
    const body = JSON.stringify({
        using: [EMAIL_CAPABILITY_URI],
        methodCalls: [
            [
                'Email/get',
                {
                    accountId,
                    ids: [messageId],
                    properties: emailBodyProperties,
                    bodyProperties: emailBodyPartProperties,
                    fetchHTMLBodyValues: true,
                    fetchTextBodyValues: true,
                },
                'rawBody',
            ],
        ],
    })
    const apiFetchStartedAt = Date.now()

    observeEvent('jmap.raw-body-probe.api.fetch.call', {
        activeTransportRequestCount,
        bodyLength: body.length,
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
    })

    let apiResponse: Response

    try {
        apiResponse = await fetch(apiRequestUrl, {
            body,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            method: 'POST',
        })
    } catch (error: unknown) {
        observeError('jmap.raw-body-probe.api.fetch.failed', error, {
            activeTransportRequestCount,
            bodyLength: body.length,
            messageId,
            path: apiPath,
            reason,
            requestId: apiRequestId,
        })
        throw error
    }

    observeDuration('jmap.raw-body-probe.api.fetch.response', apiFetchStartedAt, {
        activeTransportRequestCount,
        bodyLength: body.length,
        ...getResponseHeaderObservability(apiResponse),
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
        status: apiResponse.status,
    })

    const apiTextStartedAt = Date.now()
    const apiText = await apiResponse.text()

    observeDuration('jmap.raw-body-probe.api.text.success', apiTextStartedAt, {
        activeTransportRequestCount,
        length: apiText.length,
        messageId,
        path: apiPath,
        reason,
        requestId: apiRequestId,
        status: apiResponse.status,
    })

    if (!apiResponse.ok) {
        throw new Error(`Fastmail raw body probe API failed with HTTP ${apiResponse.status}`)
    }

    const apiParseStartedAt = Date.now()
    const apiJson = JSON.parse(apiText) as { methodResponses?: unknown }
    const methodResponses = Array.isArray(apiJson.methodResponses)
        ? apiJson.methodResponses
        : []
    const firstResponse = methodResponses[0]
    const firstArgs =
        Array.isArray(firstResponse) &&
        firstResponse[1] &&
        typeof firstResponse[1] === 'object' &&
        !Array.isArray(firstResponse[1])
            ? (firstResponse[1] as { list?: unknown })
            : null
    const list = firstArgs && Array.isArray(firstArgs.list) ? firstArgs.list : []
    const email =
        list[0] && typeof list[0] === 'object' && !Array.isArray(list[0])
            ? (list[0] as EmailObject)
            : null
    const bodyValues =
        email?.bodyValues &&
        typeof email.bodyValues === 'object' &&
        !Array.isArray(email.bodyValues)
            ? email.bodyValues
            : {}
    let htmlValueLength = 0
    let textValueLength = 0

    for (const part of email?.htmlBody ?? []) {
        const value =
            part.partId && bodyValues[part.partId]?.value
                ? bodyValues[part.partId].value
                : ''

        htmlValueLength += value.length
    }

    for (const part of email?.textBody ?? []) {
        const value =
            part.partId && bodyValues[part.partId]?.value
                ? bodyValues[part.partId].value
                : ''

        textValueLength += value.length
    }

    observeDuration('jmap.raw-body-probe.api.parse.success', apiParseStartedAt, {
        attachments: Array.isArray(email?.attachments)
            ? email.attachments.length
            : 0,
        bodyValues: Object.keys(bodyValues).length,
        found: Boolean(email),
        html: htmlValueLength,
        length: apiText.length,
        messageId,
        methodResponses: methodResponses.length,
        reason,
        text: textValueLength,
    })

    observeDuration('jmap.raw-body-probe.success', startedAt, {
        attachments: Array.isArray(email?.attachments)
            ? email.attachments.length
            : 0,
        bodyValues: Object.keys(bodyValues).length,
        found: Boolean(email),
        html: htmlValueLength,
        length: apiText.length,
        messageId,
        methodResponses: methodResponses.length,
        reason,
        text: textValueLength,
    })
}

function createBearerTransport(token: string, operation?: string): Transport {
    // Every JMAP request is a plain stock fetch, the same as the direct message
    // body fetch: no scheduler, no pacing, no dedup, no retry. The old shared
    // scheduler serialized and paced all traffic (and flushed connections on
    // failure runs), which is what made mark-as-read and mailbox refresh stall
    // for seconds behind each other. performRequest bounds each fetch with its
    // own timeout; a failure surfaces to the caller, which refetches on next use.
    async function request<T>(
        method: 'GET' | 'POST',
        url: string | URL,
        options: TransportRequestOptions = {}
    ): Promise<T> {
        return performRequest<T>(method, url, options)
    }

    async function performRequest<T>(
        method: 'GET' | 'POST',
        url: string | URL,
        options: TransportRequestOptions = {}
    ): Promise<T> {
        const startedAt = Date.now()
        const requestId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const sequence = ++transportRequestSequence
        const headers = new Headers(options.headers)

        headers.set('Authorization', `Bearer ${token}`)

        if (!headers.has('Accept')) {
            headers.set(
                'Accept',
                options.responseType === 'blob' ? '*/*' : 'application/json'
            )
        }

        if (
            method === 'POST' &&
            typeof options.body === 'string' &&
            !headers.has('Content-Type')
        ) {
            headers.set('Content-Type', 'application/json')
        }

        const requestUrl = getFastmailRequestUrl(url)
        const path = getObservabilityPath(requestUrl)
        const bodyLength =
            method === 'POST' && typeof options.body === 'string'
                ? options.body.length
                : 0
        const responseType = options.responseType === 'blob' ? 'blob' : 'json'
        const requestDetails = getJmapRequestObservabilityDetails(options.body)

        observeEvent('jmap.transport.request.start', {
            activeTransportRequestCount,
            bodyLength,
            ...requestDetails,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
            responseType,
            sequence,
            signalAborted: options.signal?.aborted === true,
        })

        let response: Response
        const fetchStartedAt = Date.now()
        const activeAtFetchStart = ++activeTransportRequestCount
        let fetchSlowTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            observeEvent(
                'jmap.transport.fetch.slow',
                {
                    activeAtFetchStart,
                    activeTransportRequestCount,
                    bodyLength,
                    ...requestDetails,
                    durationMs: Math.max(0, Date.now() - fetchStartedAt),
                    method,
                    operation: operation ?? 'unknown',
                    path,
                    requestId,
                    responseType,
                    sequence,
                    signalAborted: options.signal?.aborted === true,
                },
                'warn'
            )
        }, SLOW_TRANSPORT_REQUEST_MS)
        const abortListener = () => {
            observeEvent(
                'jmap.transport.signal.abort',
                {
                    activeAtFetchStart,
                    activeTransportRequestCount,
                    bodyLength,
                    ...requestDetails,
                    durationMs: Math.max(0, Date.now() - fetchStartedAt),
                    method,
                    operation: operation ?? 'unknown',
                    path,
                    requestId,
                    responseType,
                    sequence,
                },
                'warn'
            )
        }

        if (options.signal) {
            options.signal.addEventListener('abort', abortListener, { once: true })
        }

        observeEvent('jmap.transport.fetch.call', {
            activeAtFetchStart,
            activeTransportRequestCount,
            bodyLength,
            ...requestDetails,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
            responseType,
            sequence,
            signalAborted: options.signal?.aborted === true,
        })

        // A request that reuses a dead pooled HTTP/2 connection black-holes
        // for seconds-to-minutes before iOS reports "network connection was
        // lost". React Native ignores AbortController mid-flight, so aborting
        // does not settle the fetch promise. Instead we race the fetch against
        // a real timer that rejects on its own: the retry layer then opens a
        // fresh connection (~240ms) rather than waiting out the dead one. We
        // still call abort() best-effort to release the stuck request.
        const timeoutMs =
            options.responseType === 'blob'
                ? TRANSPORT_BLOB_TIMEOUT_MS
                : TRANSPORT_REQUEST_TIMEOUT_MS
        const fetchController = new AbortController()
        const forwardAbort = () => fetchController.abort()
        options.signal?.addEventListener('abort', forwardAbort, { once: true })
        let didTimeOut = false
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutTimer = setTimeout(() => {
                didTimeOut = true
                fetchController.abort()
                reject(createJmapTransportTimeoutError(timeoutMs))
            }, timeoutMs)
        })

        try {
            response = await Promise.race([
                fetch(requestUrl, {
                    body: method === 'POST' ? options.body : undefined,
                    headers,
                    method,
                    signal: fetchController.signal,
                }),
                timeoutPromise,
            ])
        } catch (error: unknown) {
            const timeoutError =
                didTimeOut && options.signal?.aborted !== true
                    ? createJmapTransportTimeoutError(timeoutMs)
                    : null

            observeError('jmap.transport.fetch.failed', timeoutError ?? error, {
                activeAtFetchStart,
                activeTransportRequestCount,
                ...requestDetails,
                didTimeOut,
                durationMs: Math.max(0, Date.now() - fetchStartedAt),
                method,
                operation: operation ?? 'unknown',
                path,
                requestId,
                sequence,
            })
            throw timeoutError ?? error
        } finally {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer)
                timeoutTimer = null
            }
            options.signal?.removeEventListener('abort', forwardAbort)

            if (fetchSlowTimer) {
                clearTimeout(fetchSlowTimer)
                fetchSlowTimer = null
            }

            if (options.signal) {
                options.signal.removeEventListener('abort', abortListener)
            }

            activeTransportRequestCount = Math.max(
                0,
                activeTransportRequestCount - 1
            )
        }

        observeDuration('jmap.transport.fetch.response', fetchStartedAt, {
            activeAtFetchStart,
            activeTransportRequestCount,
            ...getResponseHeaderObservability(response),
            ...requestDetails,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
            sequence,
            status: response.status,
        })

        if (!response.ok) {
            throw new Error(await getErrorMessage(response, method))
        }

        if (options.responseType === 'blob') {
            const blobStartedAt = Date.now()
            let blob: Blob

            try {
                blob = await response.blob()
            } catch (error: unknown) {
                observeError('jmap.transport.blob-read.failed', error, {
                    ...requestDetails,
                    method,
                    operation: operation ?? 'unknown',
                    path,
                    requestId,
                })
                throw error
            }

            observeDuration('jmap.transport.blob-read.success', blobStartedAt, {
                ...requestDetails,
                method,
                operation: operation ?? 'unknown',
                path,
                requestId,
                size: blob.size,
            })
            observeDuration('jmap.transport.request.success', startedAt, {
                ...requestDetails,
                method,
                operation: operation ?? 'unknown',
                path,
                requestId,
                responseType,
                status: response.status,
            })

            return blob as T
        }

        const textStartedAt = Date.now()
        let text: string

        try {
            text = await response.text()
        } catch (error: unknown) {
            observeError('jmap.transport.text-read.failed', error, {
                ...requestDetails,
                method,
                operation: operation ?? 'unknown',
                path,
                requestId,
            })
            throw error
        }

        observeDuration('jmap.transport.text-read.success', textStartedAt, {
            ...requestDetails,
            length: text.length,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
        })

        const parseStartedAt = Date.now()
        let json: T

        try {
            json = JSON.parse(text) as T
        } catch (error: unknown) {
            observeError('jmap.transport.json-parse.failed', error, {
                ...requestDetails,
                length: text.length,
                method,
                operation: operation ?? 'unknown',
                path,
                requestId,
            })
            throw error
        }

        observeDuration('jmap.transport.json-parse.success', parseStartedAt, {
            ...requestDetails,
            length: text.length,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
        })
        observeDuration('jmap.transport.request.success', startedAt, {
            ...requestDetails,
            length: text.length,
            method,
            operation: operation ?? 'unknown',
            path,
            requestId,
            responseType,
            status: response.status,
        })

        return json
    }

    return {
        get: (url, options) => request('GET', url, options),
        post: (url, options) => request('POST', url, options),
    }
}

function getObservabilityPath(url: string) {
    try {
        const parsed = new URL(url)

        return parsed.pathname
    } catch {
        return 'unknown'
    }
}

function getResponseHeaderObservability(response: Response) {
    return {
        contentLengthHeader: response.headers.get('content-length'),
        contentTypeHeader: response.headers.get('content-type'),
        dateHeader: response.headers.get('date'),
        serverHeader: response.headers.get('server'),
    }
}

function getJmapRequestObservabilityDetails(body: unknown) {
    if (typeof body !== 'string' || !body.trim().startsWith('{')) {
        return {}
    }

    try {
        const parsed = JSON.parse(body) as {
            methodCalls?: unknown
        }
        const methodCalls = Array.isArray(parsed.methodCalls)
            ? parsed.methodCalls
            : []
        const methodNames: string[] = []
        let primaryEmailId: string | null = null
        let emailGetIds = 0
        let fetchHTMLBodyValues: boolean | null = null
        let fetchTextBodyValues: boolean | null = null
        let bodyPropertiesCount: number | null = null
        let propertiesCount: number | null = null

        for (const methodCall of methodCalls) {
            if (!Array.isArray(methodCall)) {
                continue
            }

            const [name, args] = methodCall

            if (typeof name === 'string') {
                methodNames.push(name)
            }

            if (
                name === 'Email/get' &&
                args &&
                typeof args === 'object' &&
                !Array.isArray(args)
            ) {
                const emailArgs = args as {
                    bodyProperties?: unknown
                    fetchHTMLBodyValues?: unknown
                    fetchTextBodyValues?: unknown
                    ids?: unknown
                    properties?: unknown
                }
                const ids = Array.isArray(emailArgs.ids)
                    ? emailArgs.ids.filter((id): id is string => typeof id === 'string')
                    : []

                emailGetIds += ids.length
                primaryEmailId ??= ids[0] ?? null
                fetchHTMLBodyValues =
                    typeof emailArgs.fetchHTMLBodyValues === 'boolean'
                        ? emailArgs.fetchHTMLBodyValues
                        : fetchHTMLBodyValues
                fetchTextBodyValues =
                    typeof emailArgs.fetchTextBodyValues === 'boolean'
                        ? emailArgs.fetchTextBodyValues
                        : fetchTextBodyValues
                bodyPropertiesCount = Array.isArray(emailArgs.bodyProperties)
                    ? emailArgs.bodyProperties.length
                    : bodyPropertiesCount
                propertiesCount = Array.isArray(emailArgs.properties)
                    ? emailArgs.properties.length
                    : propertiesCount
            }
        }

        return {
            bodyPropertiesCount,
            emailGetIds,
            fetchHTMLBodyValues,
            fetchTextBodyValues,
            jmapMethods: methodNames.join(',').slice(0, 120),
            methodCalls: methodCalls.length,
            primaryEmailId,
            propertiesCount,
        }
    } catch {
        return {
            jmapBodyParsed: false,
        }
    }
}

function getFastmailRequestUrl(url: string | URL) {
    const requestUrl = new URL(url.toString())

    if (
        requestUrl.hostname === FASTMAIL_JMAP_HOSTNAME &&
        requestUrl.pathname === '/.well-known/jmap'
    ) {
        requestUrl.pathname = '/jmap/session'
    }

    return requestUrl.toString()
}

async function getErrorMessage(response: Response, method: string) {
    const body = await response.text()
    const suffix = body ? `: ${body}` : ''

    return `Fastmail JMAP ${method} failed with HTTP ${response.status}${suffix}`
}

function getInvocationStates(invocations: Iterable<unknown>): SyncStateSnapshot {
    const states: SyncStateSnapshot = {}

    for (const invocation of invocations) {
        const candidate = invocation as {
            getArgument?: (name: string) => unknown
            name?: string
        }

        if (typeof candidate.getArgument !== 'function') {
            continue
        }

        const type =
            candidate.name === 'Mailbox/get'
                ? 'Mailbox'
                : candidate.name === 'Email/get'
                  ? 'Email'
                  : null

        if (!type) {
            continue
        }

        const state = candidate.getArgument('state')

        if (typeof state === 'string') {
            states[type] = state
        }
    }

    return states
}

/**
 * Probes the server's Mailbox and Email state strings with one cheap
 * request and reports whether the given mailbox view could be stale.
 * Returns true (changed) whenever it cannot prove the view is current.
 */
export async function hasJmapMailboxViewChanged({
    mailboxId,
    signal,
}: {
    mailboxId?: string | null
    signal?: AbortSignal
} = {}): Promise<boolean> {
    const mailboxKey = mailboxId ?? lastKnownInboxMailboxId

    if (!mailboxKey || !mailboxesFreshForCurrentState.has(mailboxKey)) {
        return true
    }

    const startedAt = Date.now()
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const response = await client
            .createRequestBuilder()
            .add(Mailbox.request.get({ accountId, ids: [], properties: ['id'] }))
            .add(Email.request.get({ accountId, ids: [], properties: ['id'] }))
            .send(signal)
        const states = getInvocationStates(response.methodResponses)
        const changed = !mailStateTracker.isCurrent(states)

        observeDuration('jmap.state-probe.success', startedAt, {
            changed,
            mailboxId: mailboxKey,
        })

        return changed
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message.toLowerCase() : ''

        if ((error instanceof Error && error.name === 'AbortError') || message.includes('cancel')) {
            observeEvent('jmap.state-probe.canceled', { mailboxId: mailboxKey })
        } else {
            observeError('jmap.state-probe.failed', error, { mailboxId: mailboxKey })
        }

        return true
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

// One round trip for a full mailbox page: mailbox list, page message ids,
// message metadata, and the threads they belong to, chained server-side
// through JMAP back-references.
async function getMailboxSnapshotBatch(
    client: JMAPClient,
    accountId: Id,
    mailboxId: Id,
    position: number,
    limit: number,
    signal?: AbortSignal
) {
    const query = Email.request.query({
        accountId,
        calculateTotal: true,
        collapseThreads: true,
        filter: { inMailbox: mailboxId },
        limit,
        position,
        sort: [{ property: 'receivedAt', isAscending: false }],
    })
    const emailGet = Email.request.get({
        accountId,
        bodyProperties: emailBodyPartProperties,
        ids: query.createReference('/ids'),
        properties: emailSummaryProperties,
    })
    const response = await client
        .createRequestBuilder()
        .add(
            Mailbox.request.get({
                accountId,
                ids: null,
                properties: mailboxProperties,
            })
        )
        .add(query)
        .add(emailGet)
        .add(
            Thread.request.get({
                accountId,
                ids: emailGet.createReference('/list/*/threadId'),
                properties: threadProperties,
            })
        )
        .send(signal)

    let mailboxObjects: MailboxObject[] = []
    let emailIds: Id[] = []
    let emails: EmailObject[] = []
    let threadObjects: ThreadObject[] = []
    let responsePosition = position
    let total: number | null = null

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name === 'Mailbox/get') {
            mailboxObjects = invocation.getArgument('list') as MailboxObject[]
        }

        if (invocation.name === 'Email/query') {
            emailIds = invocation.getArgument('ids') as Id[]
            responsePosition =
                (invocation.getArgument('position') as number | undefined) ??
                position
            total = (invocation.getArgument('total') as number | undefined) ?? null
        }

        if (invocation.name === 'Email/get') {
            emails = invocation.getArgument('list') as EmailObject[]
        }

        if (invocation.name === 'Thread/get') {
            threadObjects = invocation.getArgument('list') as ThreadObject[]
        }
    }

    return {
        mailboxes: mailboxObjects.sort(sortMailboxes).map(toJmapMailbox),
        messages: sortEmailsByQuery(emails, emailIds).map((email) =>
            mapEmailToMessage(email)
        ),
        position: responsePosition,
        states: getInvocationStates(response.methodResponses),
        threads: threadObjects,
        total,
    }
}

async function getMailboxes(
    client: JMAPClient,
    accountId: Id,
    signal?: AbortSignal
) {
    const request = client.createRequestBuilder().add(
        Mailbox.request.get({
            accountId,
            ids: null,
            properties: mailboxProperties,
        })
    )
    const response = await request.send(signal)
    let mailboxes: MailboxObject[] = []

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name === 'Mailbox/get') {
            mailboxes = invocation.getArgument('list') as MailboxObject[]
        }
    }

    return mailboxes.sort(sortMailboxes).map(toJmapMailbox)
}

async function getMailboxMessages(
    client: JMAPClient,
    accountId: Id,
    mailboxId: Id,
    limit: number,
    signal?: AbortSignal
) {
    const page = await getMailboxMessagesPage(
        client,
        accountId,
        mailboxId,
        0,
        limit,
        signal
    )

    return page.messages
}

async function getMailboxMessagesPage(
    client: JMAPClient,
    accountId: Id,
    mailboxId: Id,
    position: number,
    limit: number,
    signal?: AbortSignal
) {
    const query = Email.request.query({
        accountId,
        calculateTotal: true,
        collapseThreads: true,
        filter: { inMailbox: mailboxId },
        limit,
        position,
        sort: [{ property: 'receivedAt', isAscending: false }],
    })
    const get = Email.request.get({
        accountId,
        bodyProperties: emailBodyPartProperties,
        ids: query.createReference('/ids'),
        properties: emailSummaryProperties,
    })
    const response = await client
        .createRequestBuilder()
        .add(query)
        .add(get)
        .send(signal)
    let emailIds: Id[] = []
    let emails: EmailObject[] = []
    let responsePosition = position
    let total: number | null = null

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name === 'Email/query') {
            emailIds = invocation.getArgument('ids') as Id[]
            responsePosition =
                (invocation.getArgument('position') as number | undefined) ??
                position
            total = (invocation.getArgument('total') as number | undefined) ?? null
        }

        if (invocation.name === 'Email/get') {
            emails = invocation.getArgument('list') as EmailObject[]
        }
    }

    return {
        messages: sortEmailsByQuery(emails, emailIds).map((email) =>
            mapEmailToMessage(email)
        ),
        position: responsePosition,
        total,
    }
}

async function buildThreadMap(
    client: JMAPClient,
    accountId: Id,
    threads: ThreadObject[],
    messages: Message[],
    mailboxes: JmapMailbox[],
    signal?: AbortSignal
): Promise<Record<string, JmapThread>> {
    const knownMessagesById = new Map(
        messages.map((message) => [message.id, message])
    )
    const missingEmailIds = Array.from(
        new Set(
            threads.flatMap((thread) =>
                (thread.emailIds ?? []).filter(
                    (emailId) => !knownMessagesById.has(emailId)
                )
            )
        )
    )
    const missingEmails = missingEmailIds.length
        ? await getEmails(
              client,
              accountId,
              missingEmailIds,
              emailSummaryProperties,
              signal
          )
        : []

    for (const email of missingEmails) {
        knownMessagesById.set(email.id, mapEmailToMessage(email, mailboxes))
    }

    const threadMap: Record<string, JmapThread> = {}

    for (const thread of threads) {
        const emailIds = thread.emailIds ?? []

        threadMap[thread.id] = {
            emailIds,
            id: thread.id,
            messages: emailIds
                .map((emailId) => knownMessagesById.get(emailId))
                .filter((message): message is Message => Boolean(message)),
        }
    }

    return threadMap
}

function applyThreadCountsToMessages(
    messages: Message[],
    threads: Record<string, JmapThread>
) {
    return messages.map((message) => {
        const threadId = message.threadId
        const thread = threadId ? threads[threadId] : null

        if (!thread || thread.emailIds.length <= 1) {
            return message
        }

        return {
            ...message,
            count: thread.emailIds.length,
        }
    })
}

async function getEmails(
    client: JMAPClient,
    accountId: Id,
    ids: Id[],
    properties: (keyof EmailObject)[],
    signal?: AbortSignal
) {
    const shouldFetchBodyValues =
        properties.includes('bodyValues') ||
        properties.includes('htmlBody') ||
        properties.includes('textBody')
    const shouldFetchBodyProperties =
        shouldFetchBodyValues ||
        properties.includes('attachments') ||
        properties.includes('bodyStructure')
    const response = await client
        .createRequestBuilder()
        .add(
            Email.request.get({
                accountId,
                ids,
                properties,
                ...(shouldFetchBodyProperties
                    ? {
                          bodyProperties: emailBodyPartProperties,
                      }
                    : {}),
                ...(shouldFetchBodyValues
                    ? {
                          fetchHTMLBodyValues: true,
                          fetchTextBodyValues: true,
                      }
                    : {}),
            })
        )
        .send(signal)
    let emails: EmailObject[] = []

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name === 'Email/get') {
            emails = invocation.getArgument('list') as EmailObject[]
        }
    }

    return sortEmailsByQuery(emails, ids)
}

async function getThread(
    client: JMAPClient,
    accountId: Id,
    threadId: Id,
    signal?: AbortSignal
) {
    const threads = await getThreads(client, accountId, [threadId], signal)

    return threads[0] ?? null
}

async function getThreads(
    client: JMAPClient,
    accountId: Id,
    threadIds: Id[],
    signal?: AbortSignal
) {
    const response = await client
        .createRequestBuilder()
        .add(
            Thread.request.get({
                accountId,
                ids: threadIds,
                properties: threadProperties,
            })
        )
        .send(signal)
    let threads: ThreadObject[] = []

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name === 'Thread/get') {
            threads = invocation.getArgument('list') as ThreadObject[]
        }
    }

    return sortThreadsByQuery(threads, threadIds)
}

async function moveJmapEmailToRole(
    messageId: string,
    role: 'archive' | 'inbox' | 'trash',
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    const startedAt = Date.now()
    observeEvent('jmap.message.move.start', {
        messageId,
        role,
    })
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const mailboxes = await getMailboxes(client, accountId, signal)
        const metadata = await getEmailMetadata(
            client,
            accountId,
            messageId,
            signal
        )
        const targetMailbox = findMailboxByRole(mailboxes, role)

        if (!targetMailbox) {
            throw new Error(`Fastmail did not return a ${role} mailbox.`)
        }

        let mailboxIds: Record<string, true>

        if (role === 'trash') {
            mailboxIds = { [targetMailbox.id]: true }
        } else if (role === 'inbox') {
            mailboxIds = getUnarchivedMailboxIds(
                metadata.mailboxIds,
                mailboxes,
                targetMailbox.id
            )
        } else {
            mailboxIds = getArchivedMailboxIds(
                metadata.mailboxIds,
                mailboxes,
                targetMailbox.id
            )
        }

        await updateEmail(client, accountId, messageId, { mailboxIds }, signal)

        observeDuration('jmap.message.move.success', startedAt, {
            mailboxCount: Object.keys(mailboxIds).length,
            messageId,
            role,
        })

        return { mailboxIds }
    } catch (error: unknown) {
        observeError('jmap.message.move.failed', error, {
            messageId,
            role,
        })
        throw error
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

async function moveJmapEmailToRoleWithMailboxState({
    mailboxIds: currentMailboxIds,
    mailboxes,
    messageId,
    role,
    signal,
}: JmapKnownMailboxStateInput & {
    role: 'archive' | 'inbox' | 'trash'
}): Promise<JmapMessageActionResult> {
    const startedAt = Date.now()
    const nextMailboxIds = getJmapMailboxIdsForRole({
        currentMailboxIds,
        mailboxes,
        role,
    })

    if (!nextMailboxIds) {
        observeEvent('jmap.message.move-known-state.fallback', {
            hasCurrentMailboxIds: Boolean(currentMailboxIds),
            mailboxCount: mailboxes?.length ?? 0,
            messageId,
            role,
        })
        return moveJmapEmailToRole(messageId, role, signal)
    }

    observeEvent('jmap.message.move-known-state.start', {
        mailboxCount: Object.keys(nextMailboxIds).length,
        messageId,
        role,
    })

    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        await updateEmail(client, accountId, messageId, { mailboxIds: nextMailboxIds }, signal)

        observeDuration('jmap.message.move-known-state.success', startedAt, {
            mailboxCount: Object.keys(nextMailboxIds).length,
            messageId,
            role,
        })

        return { mailboxIds: nextMailboxIds }
    } catch (error: unknown) {
        observeError('jmap.message.move-known-state.failed', error, {
            messageId,
            role,
        })
        throw error
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

async function updateJmapEmailKeywords(
    messageId: string,
    keyword: '$flagged' | '$seen',
    enabled: boolean,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    const startedAt = Date.now()
    observeEvent('jmap.message.keyword.start', {
        enabled,
        keyword,
        messageId,
    })
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const metadata = await getEmailMetadata(
            client,
            accountId,
            messageId,
            signal
        )
        const keywords = { ...metadata.keywords }

        if (enabled) {
            keywords[keyword] = true
        } else {
            delete keywords[keyword]
        }

        await updateEmail(
            client,
            accountId,
            messageId,
            { [`keywords/${keyword}`]: enabled ? true : null },
            signal
        )

        const result = {
            keywords,
            pinned: keywords.$flagged === true,
            unread: keywords.$seen !== true,
        }

        observeDuration('jmap.message.keyword.success', startedAt, {
            enabled,
            keyword,
            messageId,
            unread: keywords.$seen !== true,
        })

        return result
    } catch (error: unknown) {
        observeError('jmap.message.keyword.failed', error, {
            enabled,
            keyword,
            messageId,
        })
        throw error
    } finally {
        await releaseFastmailJmapClient(client)
    }
}

async function getEmailMetadata(
    client: JMAPClient,
    accountId: Id,
    messageId: Id,
    signal?: AbortSignal
) {
    const emails = await getEmails(
        client,
        accountId,
        [messageId],
        emailMetadataProperties,
        signal
    )
    const email = emails[0]

    if (!email) {
        throw new Error('Email not found.')
    }

    return {
        keywords: normalizeTrueRecord(email.keywords),
        mailboxIds: normalizeTrueRecord(email.mailboxIds),
    }
}

async function updateEmail(
    client: JMAPClient,
    accountId: Id,
    messageId: Id,
    patch: PatchObject,
    signal?: AbortSignal
) {
    const result = await updateEmails(
        client,
        accountId,
        { [messageId]: patch },
        signal
    )
    const error = result.notUpdated[messageId]

    if (error) {
        throw createEmailSetNotUpdatedError(error)
    }
}

async function updateEmails(
    client: JMAPClient,
    accountId: Id,
    updates: Record<string, PatchObject>,
    signal?: AbortSignal
): Promise<JmapEmailSetBatchResult> {
    const queuedAt = Date.now()
    const messageIds = Object.keys(updates)
    const queued = emailSetQueue.catch(() => undefined).then(async () => {
        observeDuration('jmap.email-set.queue.wait', queuedAt, {
            messageCount: messageIds.length,
            messageIds: formatDebugIdList(messageIds),
        })

        return updateEmailsWithRetry(client, accountId, updates, signal)
    })

    emailSetQueue = queued.then(() => undefined, () => undefined)

    return queued
}

async function updateEmailsWithRetry(
    client: JMAPClient,
    accountId: Id,
    updates: Record<string, PatchObject>,
    signal?: AbortSignal
): Promise<JmapEmailSetBatchResult> {
    const messageIds = Object.keys(updates)

    for (let attempt = 1; attempt <= EMAIL_SET_MAX_ATTEMPTS; attempt += 1) {
        try {
            if (attempt > 1) {
                observeEvent('jmap.email-set.retry.start', {
                    attempt,
                    maxAttempts: EMAIL_SET_MAX_ATTEMPTS,
                    messageCount: messageIds.length,
                    messageIds: formatDebugIdList(messageIds),
                })
            }

            const result = await updateEmailsOnce(client, accountId, updates, signal)

            if (attempt > 1) {
                observeEvent('jmap.email-set.retry.success', {
                    attempt,
                    maxAttempts: EMAIL_SET_MAX_ATTEMPTS,
                    messageCount: messageIds.length,
                    messageIds: formatDebugIdList(messageIds),
                })
            }

            return result
        } catch (error: unknown) {
            const canRetry =
                attempt < EMAIL_SET_MAX_ATTEMPTS &&
                !signal?.aborted &&
                !isAbortError(error) &&
                isRetriableJmapNetworkError(error)

            observeError('jmap.email-set.attempt.failed', error, {
                attempt,
                canRetry,
                messageCount: messageIds.length,
                messageIds: formatDebugIdList(messageIds),
            })

            if (!canRetry) {
                throw error
            }

            const delayMs =
                EMAIL_SET_RETRY_DELAYS_MS[
                    Math.min(attempt - 1, EMAIL_SET_RETRY_DELAYS_MS.length - 1)
                ] ?? 0

            observeEvent('jmap.email-set.retry.scheduled', {
                attempt: attempt + 1,
                delayMs,
                messageCount: messageIds.length,
                messageIds: formatDebugIdList(messageIds),
            })

            await delay(delayMs, signal)
        }
    }

    return { notUpdated: {}, updatedIds: [] }
}

async function updateEmailsOnce(
    client: JMAPClient,
    accountId: Id,
    updates: Record<string, PatchObject>,
    signal?: AbortSignal
): Promise<JmapEmailSetBatchResult> {
    const response = await client
        .createRequestBuilder()
        .add(
            Email.request.set({
                accountId,
                update: updates,
            })
        )
        .send(signal)
    let didReceiveSetResponse = false
    let result: JmapEmailSetBatchResult = {
        notUpdated: {},
        updatedIds: [],
    }

    for (const invocation of response.methodResponses) {
        if (isErrorInvocation(invocation)) {
            throw new Error(
                `JMAP ${invocation.type}: ${JSON.stringify(invocation.arguments)}`
            )
        }

        if (invocation.name !== 'Email/set') {
            continue
        }

        didReceiveSetResponse = true

        const notUpdated = invocation.getArgument('notUpdated') as
            | Record<string, { description?: string; type?: string }>
            | null
            | undefined
        const updated = invocation.getArgument('updated') as
            | Record<string, unknown>
            | null
            | undefined

        result = {
            notUpdated: notUpdated ?? {},
            updatedIds: Object.keys(updated ?? {}),
        }
    }

    if (!didReceiveSetResponse) {
        throw new Error('JMAP Email/set did not return a response.')
    }

    return result
}

function createEmailSetNotUpdatedError(error: JmapEmailSetNotUpdated) {
    const detail = error.description ? `: ${error.description}` : ''

    return new Error(`JMAP Email/set ${error.type ?? 'notUpdated'}${detail}`)
}

function formatDebugIdList(ids: string[]) {
    return ids.slice(0, 10).join(',')
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError'
}

function isRetriableJmapNetworkError(error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

    return (
        message.includes('network connection was lost') ||
        message.includes('network request failed') ||
        message.includes('fetch failed') ||
        message.includes('timed out') ||
        message.includes('the request timed out') ||
        message.includes('connection reset') ||
        message.includes('connection closed') ||
        message.includes('too many requests') ||
        message.includes('http 429')
    )
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError())
            return
        }

        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timeout)
            reject(createAbortError())
        }

        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function createAbortError() {
    const error = new Error('JMAP retry aborted')
    error.name = 'AbortError'
    return error
}

function findMailbox(mailboxes: JmapMailbox[], mailboxId?: string | null) {
    if (mailboxId) {
        return mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null
    }

    return (
        mailboxes.find((mailbox) => mailbox.role === 'inbox') ??
        mailboxes.find((mailbox) => mailbox.name.toLowerCase() === 'inbox') ??
        mailboxes[0] ??
        null
    )
}

function findMailboxByRole(
    mailboxes: JmapMailbox[],
    role: 'archive' | 'inbox' | 'trash'
) {
    const roleMailbox = mailboxes.find((mailbox) => mailbox.role === role)

    if (roleMailbox) {
        return roleMailbox
    }

    const fallbackNames =
        role === 'archive'
            ? ['archive']
            : role === 'inbox'
              ? ['inbox']
              : ['trash', 'deleted items']

    return (
        mailboxes.find((mailbox) =>
            fallbackNames.includes(normalizeMailboxName(mailbox.name))
        ) ?? null
    )
}

function getUnarchivedMailboxIds(
    currentMailboxIds: Record<string, true>,
    mailboxes: JmapMailbox[],
    inboxMailboxId: Id
): Record<string, true> {
    const mailboxIds: Record<string, true> = {
        ...currentMailboxIds,
        [inboxMailboxId]: true as true,
    }

    for (const mailbox of mailboxes) {
        if (mailbox.id === inboxMailboxId) {
            continue
        }

        if (shouldRemoveFromMailboxOnUnarchive(mailbox)) {
            delete mailboxIds[mailbox.id]
        }
    }

    return mailboxIds
}

function getArchivedMailboxIds(
    currentMailboxIds: Record<string, true>,
    mailboxes: JmapMailbox[],
    archiveMailboxId: Id
): Record<string, true> {
    const mailboxIds: Record<string, true> = {
        ...currentMailboxIds,
        [archiveMailboxId]: true as true,
    }

    for (const mailbox of mailboxes) {
        if (mailbox.id === archiveMailboxId) {
            continue
        }

        if (shouldRemoveFromMailboxOnArchive(mailbox)) {
            delete mailboxIds[mailbox.id]
        }
    }

    return mailboxIds
}

function shouldRemoveFromMailboxOnArchive(mailbox: JmapMailbox) {
    const name = normalizeMailboxName(mailbox.name)

    return (
        mailbox.role === 'inbox' ||
        mailbox.role === 'junk' ||
        mailbox.role === 'trash' ||
        ['inbox', 'junk', 'spam', 'trash', 'deleted items'].includes(name)
    )
}

function shouldRemoveFromMailboxOnUnarchive(mailbox: JmapMailbox) {
    return mailbox.role === 'archive' || normalizeMailboxName(mailbox.name) === 'archive'
}

function normalizeMailboxName(name: string) {
    return name.trim().toLowerCase()
}

function toJmapMailbox(mailbox: MailboxObject): JmapMailbox {
    return {
        id: mailbox.id,
        name: mailbox.name,
        parentId: mailbox.parentId ?? null,
        role: mailbox.role ?? null,
        sortOrder: mailbox.sortOrder ?? 0,
        totalEmails: mailbox.totalEmails ?? 0,
        unreadEmails: mailbox.unreadEmails ?? 0,
    }
}

function sortMailboxes(a: MailboxObject, b: MailboxObject) {
    const roleDelta = roleSortValue(a.role) - roleSortValue(b.role)

    if (roleDelta !== 0) {
        return roleDelta
    }

    const orderDelta = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)

    if (orderDelta !== 0) {
        return orderDelta
    }

    return a.name.localeCompare(b.name)
}

function roleSortValue(role?: string | null) {
    switch (role) {
        case 'inbox':
            return 0
        case 'drafts':
            return 1
        case 'sent':
            return 2
        case 'archive':
            return 3
        case 'junk':
            return 4
        case 'trash':
            return 5
        default:
            return 10
    }
}

function sortEmailsByQuery(emails: EmailObject[], ids: Id[]) {
    const order = new Map(ids.map((id, index) => [id, index]))

    return [...emails].sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    )
}

function sortThreadsByQuery(threads: ThreadObject[], ids: Id[]) {
    const order = new Map(ids.map((id, index) => [id, index]))

    return [...threads].sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    )
}

function mapEmailToMessage(email: EmailObject, mailboxes?: JmapMailbox[]): Message {
    const from = email.from?.[0] ?? email.sender?.[0] ?? null
    const sender = formatAddress(from)
    const attachments = getDownloadableAttachments(email)
    const toAddresses = email.to?.map(formatAddress).filter(Boolean) ?? []
    const ccAddresses = email.cc?.map(formatAddress).filter(Boolean) ?? []
    const bccAddresses = email.bcc?.map(formatAddress).filter(Boolean) ?? []
    const avatarUrl =
        getBimiAvatarUrl(email) ??
        getFastmailDomainAvatarUrl(from?.email) ??
        getFastmailProfilePhotoUrl(from?.email)

    return {
        attachments,
        avatar: getInitials(sender),
        avatarColor: colorForString(from?.email ?? sender),
        avatarUrl,
        body: getPlainTextBody(email) ?? undefined,
        hasAttachment: email.hasAttachment === true || attachments.length > 0,
        htmlBody: getHtmlBody(email) ?? undefined,
        date: formatMessageDate(email.receivedAt ?? email.sentAt ?? null),
        fromEmail: from?.email,
        id: email.id,
        keywords: normalizeTrueRecord(email.keywords),
        mailboxIds: normalizeTrueRecord(email.mailboxIds),
        mailboxName: getMessageMailboxName(email, mailboxes) ?? 'Inbox',
        pinned: email.keywords?.$flagged === true,
        preview: email.preview ?? '',
        sender,
        subject: email.subject?.trim() || '(No subject)',
        threadId: email.threadId,
        to: toAddresses.join(', '),
        toAddresses,
        ccAddresses,
        bccAddresses,
        unread: email.keywords?.['$seen'] !== true,
    }
}

function getBimiAvatarUrl(email: EmailObject) {
    const headerValues = [
        getHeaderString(email, 'header:BIMI-Location:asText'),
        getHeaderUrl(email, 'header:BIMI-Location:asURLs'),
        getHeaderString(email, 'header:BIMI-Indicator:asText'),
        getHeaderUrl(email, 'header:BIMI-Indicator:asURLs'),
    ].filter((value): value is string => Boolean(value))

    for (const value of headerValues) {
        const url = getBimiLocationUrl(value)

        if (url) {
            return url
        }
    }

    return undefined
}

function getHeaderString(email: EmailObject, key: keyof EmailObject) {
    const value = email[key]

    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value)) {
        return value.find((item): item is string => typeof item === 'string')
    }

    return undefined
}

function getHeaderUrl(email: EmailObject, key: keyof EmailObject) {
    const value = email[key]

    if (typeof value === 'string') {
        return value
    }

    if (Array.isArray(value)) {
        return value.find(
            (item): item is string =>
                typeof item === 'string' && isAvatarImageUrl(item)
        )
    }

    return undefined
}

function getBimiLocationUrl(value: string) {
    const locationTag = value.match(/(?:^|;)\s*l\s*=\s*"?([^";\s]+)"?/i)
    const url = locationTag?.[1] ?? value.match(/https?:\/\/[^\s"';<>]+/i)?.[0]

    if (!url || !isAvatarImageUrl(url)) {
        return undefined
    }

    return url.replace(/&amp;/g, '&')
}

function isAvatarImageUrl(value: string) {
    if (!/^https?:\/\//i.test(value)) {
        return false
    }

    return /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(value)
}

function getMessageMailboxName(email: EmailObject, mailboxes?: JmapMailbox[]) {
    if (!mailboxes?.length) {
        return null
    }

    const mailboxIds = normalizeTrueRecord(email.mailboxIds)
    const messageMailboxes = mailboxes.filter((mailbox) => mailboxIds[mailbox.id])
    const priorityRoles = [
        'inbox',
        'sent',
        'archive',
        'drafts',
        'scheduled',
        'junk',
        'trash',
    ]

    for (const role of priorityRoles) {
        const mailbox = messageMailboxes.find((candidate) => candidate.role === role)

        if (mailbox) {
            return getSystemMailboxLabel(mailbox)
        }
    }

    return messageMailboxes[0]?.name ?? null
}

function getSystemMailboxLabel(mailbox: JmapMailbox) {
    switch (mailbox.role) {
        case 'inbox':
            return 'Inbox'
        case 'sent':
            return 'Sent'
        case 'archive':
            return 'Archive'
        case 'drafts':
            return 'Drafts'
        case 'junk':
            return 'Spam'
        case 'trash':
            return 'Trash'
        default:
            return mailbox.name
    }
}

function formatAddress(address: EmailAddress | null) {
    if (!address) {
        return 'Unknown Sender'
    }

    return address.name?.trim() || address.email
}

function normalizeTrueRecord(
    record: Record<string, unknown> | null | undefined
) {
    const normalized: Record<string, true> = {}

    for (const [key, value] of Object.entries(record ?? {})) {
        if (value === true) {
            normalized[key] = true
        }
    }

    return normalized
}

function getPlainTextBody(
    email: EmailObject,
    { allowPreviewFallback = false }: { allowPreviewFallback?: boolean } = {}
) {
    const chunks = email.textBody
        ?.map((part) =>
            part.partId ? email.bodyValues?.[part.partId]?.value : null
        )
        .filter((value): value is string => Boolean(value?.trim()))

    if (chunks?.length) {
        return chunks.join('\n\n')
    }

    return allowPreviewFallback ? email.preview?.trim() || null : null
}

async function getEmailBody(
    client: JMAPClient,
    accountId: Id,
    token: string,
    email: EmailObject,
    {
        inlineCidImageData = false,
        signal,
    }: {
        inlineCidImageData?: boolean
        signal?: AbortSignal
    } = {}
): Promise<JmapMessageBody> {
    const html = getHtmlBody(email)
    const inlinedHtml = html && inlineCidImageData
        ? await inlineCidImages(client, accountId, token, html, email, signal)
        : html
          ? {
                debug: getCidImageDebug(
                    email,
                    getCidReferences(html),
                    getCidImageParts(email),
                    html,
                    'skipped'
                ),
                html,
            }
        : null

    return {
        attachments: getDownloadableAttachments(email, html),
        debug: inlinedHtml?.debug,
        html: inlinedHtml?.html ?? null,
        text: getPlainTextBody(email, { allowPreviewFallback: true }),
    }
}

function getHtmlBody(email: EmailObject) {
    const chunks = email.htmlBody
        ?.map((part) =>
            part.partId ? email.bodyValues?.[part.partId]?.value : null
        )
        .filter((value): value is string => Boolean(value?.trim()))

    if (chunks?.length) {
        return chunks.join('\n')
    }

    return null
}

function getDownloadableAttachments(
    email: EmailObject,
    html: string | null = getHtmlBody(email)
): MessageAttachment[] {
    return getDownloadableAttachmentParts(email, html).map(mapAttachmentPart)
}

async function getDownloadableAttachmentsWithPreviews(
    client: JMAPClient,
    accountId: Id,
    token: string,
    email: EmailObject,
    html: string | null,
    signal?: AbortSignal
): Promise<MessageAttachment[]> {
    return await Promise.all(
        getDownloadableAttachmentParts(email, html).map(async (part, index) => {
            const attachment = mapAttachmentPart(part, index)
            const blobId = part.blobId

            if (!blobId || !shouldGenerateAttachmentPreview(part)) {
                return attachment
            }

            try {
                return {
                    ...attachment,
                    previewDataUrl: await downloadBlobDataUrl({
                        accountId,
                        blobId,
                        client,
                        name: attachment.name,
                        signal,
                        token,
                        type: attachment.type,
                    }),
                }
            } catch {
                return attachment
            }
        })
    )
}

function getDownloadableAttachmentParts(
    email: EmailObject,
    html: string | null = getHtmlBody(email)
) {
    if (email.hasAttachment === false) {
        return []
    }

    const cidReferences = new Set(
        (html ? getCidReferences(html) : []).flatMap(getContentIdKeys)
    )

    return (email.attachments ?? [])
        .filter((part) => isDownloadableAttachment(part, cidReferences))
}

function mapAttachmentPart(
    part: Omit<EmailBodyPart, 'subParts'>,
    index = 0
): MessageAttachment {
    return {
        blobId: part.blobId ?? undefined,
        id:
            part.blobId ??
            part.partId ??
            `${part.name || part.type || 'attachment'}-${index}`,
        name: getAttachmentName(part),
        size: part.size ?? 0,
        type: part.type || 'application/octet-stream',
    }
}

function shouldGenerateAttachmentPreview(part: Omit<EmailBodyPart, 'subParts'>) {
    return Boolean(part.blobId) && (part.size ?? 0) <= MAX_ATTACHMENT_PREVIEW_BYTES
}

function isDownloadableAttachment(
    part: Omit<EmailBodyPart, 'subParts'>,
    cidReferences: Set<string>
) {
    if (!part.blobId) {
        return false
    }

    const cid = normalizeContentId(part.cid)

    if (cid && getContentIdKeys(cid).some((key) => cidReferences.has(key))) {
        return false
    }

    if (
        part.disposition?.toLowerCase() === 'inline' &&
        part.type?.toLowerCase().startsWith('image/')
    ) {
        return false
    }

    return true
}

function getAttachmentName(part: Omit<EmailBodyPart, 'subParts'>) {
    const name = part.name?.trim()

    if (name) {
        return name
    }

    if (part.type?.toLowerCase() === 'application/pdf') {
        return 'Document.pdf'
    }

    if (part.type?.toLowerCase().startsWith('image/')) {
        const extension = part.type.split('/')[1]?.replace(/[^a-z0-9]+/gi, '')

        return extension ? `Image.${extension}` : 'Image'
    }

    return 'Attachment'
}

async function inlineCidImages(
    client: JMAPClient,
    accountId: Id,
    token: string,
    html: string,
    email: EmailObject,
    signal?: AbortSignal
) {
    const cidReferences = getCidReferences(html)
    const cidImages = getCidImageParts(email)
    const debug = getCidImageDebug(email, cidReferences, cidImages, html)

    if (!cidImages.length || !cidReferences.length) {
        return { debug, html }
    }

    const cidDataUrls = new Map<string, string>()
    const inlineImageErrors: string[] = []
    let inlineImageErrorCount = 0

    await Promise.all(
        cidImages.map(async (part) => {
            const blobId = part.blobId
            const type = part.type || 'application/octet-stream'

            if (!blobId) {
                return
            }

            try {
                const dataUrl = await downloadBlobDataUrl({
                    accountId,
                    blobId,
                    client,
                    name: getInlineImageName(part),
                    signal,
                    token,
                    type,
                })

                for (const key of getContentIdKeys(part.cid)) {
                    cidDataUrls.set(key, dataUrl)
                }
            } catch (error) {
                inlineImageErrorCount += 1
                inlineImageErrors.push(describeJmapError(error))
                // Leave the cid reference untouched if an embedded image cannot be loaded.
            }
        })
    )

    debug.downloadUrlErrorCount = inlineImageErrorCount
    debug.generatedDownloadUrlCount = new Set(cidDataUrls.values()).size
    debug.generatedDownloadUrlHosts = cidDataUrls.size ? ['data-url'] : []
    debug.inlineImageErrors = inlineImageErrors

    if (!cidDataUrls.size) {
        return { debug, html }
    }

    const unresolvedCidReferences = new Set<string>()
    let replacedCidReferenceCount = 0
    const rewrittenHtml = html.replace(
        /\bcid:([^"')\s>]+)/gi,
        (match, cid: string) => {
            const dataUrl = getContentIdValue(cidDataUrls, cid)

            if (dataUrl) {
                replacedCidReferenceCount += 1
                return dataUrl
            }

            unresolvedCidReferences.add(normalizeContentId(cid))
            return match
        }
    )

    debug.htmlContainsCidAfterRewrite = /\bcid:/i.test(rewrittenHtml)
    debug.replacedCidReferenceCount = replacedCidReferenceCount
    debug.unresolvedCidReferences = [...unresolvedCidReferences]

    return { debug, html: rewrittenHtml }
}

function getCidImageParts(email: EmailObject) {
    const parts = [
        ...flattenBodyParts(email.bodyStructure),
        ...(email.htmlBody ?? []),
        ...(email.attachments ?? []),
    ]
    const imageParts = new Map<string, Omit<EmailBodyPart, 'subParts'>>()

    for (const part of parts) {
        const cid = normalizeContentId(part.cid)

        if (
            !part.blobId ||
            !cid ||
            !part.type?.toLowerCase().startsWith('image/')
        ) {
            continue
        }

        for (const key of getContentIdKeys(cid)) {
            imageParts.set(key, part)
        }
    }

    return [...new Set(imageParts.values())]
}

function getCidReferences(html: string) {
    const references = new Set<string>()

    html.replace(/\bcid:([^"')\s>]+)/gi, (_match, cid: string) => {
        references.add(normalizeContentId(cid))
        return _match
    })

    return [...references]
}

function getCidImageDebug(
    email: EmailObject,
    cidReferences: string[],
    cidImages: Omit<EmailBodyPart, 'subParts'>[],
    html: string,
    cidImageInlineMode: 'inline' | 'skipped' = 'inline'
): JmapMessageBodyDebug {
    return {
        attachmentPartCount: email.attachments?.length ?? 0,
        bodyStructurePartCount: flattenBodyParts(email.bodyStructure).length,
        cidImageInlineMode,
        cidImagePartCount: cidImages.length,
        cidImageParts: cidImages.map((part) => ({
            blobIdPrefix: part.blobId
                ? `${part.blobId.slice(0, 12)}...`
                : undefined,
            cid: normalizeContentId(part.cid),
            hasBlobId: Boolean(part.blobId),
            location: part.location,
            name: part.name,
            type: part.type,
        })),
        cidReferenceCount: cidReferences.length,
        cidReferences,
        downloadUrlErrorCount: 0,
        generatedDownloadUrlCount: 0,
        generatedDownloadUrlHosts: [],
        htmlBodyPartCount: email.htmlBody?.length ?? 0,
        htmlContainsCidAfterRewrite: /\bcid:/i.test(html),
        inlineImageErrors: [],
        replacedCidReferenceCount: 0,
        unresolvedCidReferences: cidReferences,
    }
}

function flattenBodyParts(part?: EmailBodyPart | null): EmailBodyPart[] {
    if (!part) {
        return []
    }

    return [part, ...(part.subParts ?? []).flatMap(flattenBodyParts)]
}

function getInlineImageName(part: Omit<EmailBodyPart, 'subParts'>) {
    if (part.name) {
        return part.name
    }

    if (part.location) {
        const locationSegments = part.location.split('/').filter(Boolean)
        const locationName = locationSegments[locationSegments.length - 1]

        if (locationName) {
            return locationName
        }
    }

    const extension = part.type?.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '')

    return extension ? `inline-image.${extension}` : 'inline-image'
}

function normalizeContentId(cid?: string | null) {
    return safeDecodeURIComponent(cid ?? '')
        .trim()
        .replace(/^cid:/i, '')
        .replace(/^<|>$/g, '')
        .toLowerCase()
}

function getContentIdKeys(cid?: string | null) {
    const normalized = normalizeContentId(cid)
    const withoutPadding = normalized.replace(/=+$/g, '')

    return normalized === withoutPadding
        ? [normalized]
        : [normalized, withoutPadding]
}

function getContentIdValue(values: Map<string, string>, cid: string) {
    for (const key of getContentIdKeys(cid)) {
        const value = values.get(key)

        if (value) {
            return value
        }
    }

    return undefined
}

function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

async function downloadBlobDataUrl({
    accountId,
    blobId,
    client,
    name,
    signal,
    token,
    type,
}: {
    accountId: Id
    blobId: Id
    client: JMAPClient
    name: string
    signal?: AbortSignal
    token: string
    type: string
}) {
    const url = client.getDownloadUrl(accountId, blobId, name, type)
    const response = await fetch(getFastmailRequestUrl(url), {
        headers: {
            Accept: type,
            Authorization: `Bearer ${token}`,
        },
        signal,
    })

    if (!response.ok) {
        throw new Error(await getErrorMessage(response, 'GET'))
    }

    const contentType =
        response.headers.get('content-type')?.split(';')[0] || type
    const bytes = new Uint8Array(await response.arrayBuffer())

    return `data:${contentType};base64,${encodeBase64(bytes)}`
}

// TODO: Remove this function
function encodeBase64(bytes: Uint8Array) {
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let output = ''
    let index = 0

    for (; index + 2 < bytes.length; index += 3) {
        output += alphabet[bytes[index] >> 2]
        output += alphabet[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)]
        output +=
            alphabet[((bytes[index + 1] & 15) << 2) | (bytes[index + 2] >> 6)]
        output += alphabet[bytes[index + 2] & 63]
    }

    if (index < bytes.length) {
        output += alphabet[bytes[index] >> 2]

        if (index + 1 < bytes.length) {
            output +=
                alphabet[((bytes[index] & 3) << 4) | (bytes[index + 1] >> 4)]
            output += alphabet[(bytes[index + 1] & 15) << 2]
            output += '='
        } else {
            output += alphabet[(bytes[index] & 3) << 4]
            output += '=='
        }
    }

    return output
}

function getInitials(value: string) {
    const parts = value
        .replace(/@.*$/, '')
        .split(/[\s._-]+/)
        .filter(Boolean)

    if (parts.length === 0) {
        return '?'
    }

    return parts
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('')
}

function colorForString(value: string) {
    const palette = [
        '#2E7BEF',
        '#0F6B59',
        '#8D54E8',
        '#D16B24',
        '#C3437A',
        '#287C89',
    ]
    let hash = 0

    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0
    }

    return palette[Math.abs(hash) % palette.length]
}

function formatMessageDate(value: string | null) {
    if (!value) {
        return ''
    }

    const date = new Date(value)

    if (Number.isNaN(date.getTime())) {
        return ''
    }

    const today = new Date()
    const isToday = date.toDateString() === today.toDateString()

    if (isToday) {
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        })
    }

    return date.toLocaleDateString([], {
        day: 'numeric',
        month: 'numeric',
        year:
            date.getFullYear() === today.getFullYear() ? undefined : '2-digit',
    })
}
