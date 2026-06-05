import '@/lib/jmap-polyfills'

import { getFastmailJmapToken } from '@/lib/fastmail-token'
import type { Message, MessageAttachment } from '@/lib/mock-mail'
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
    'subject',
    'preview',
    'hasAttachment',
    'attachments',
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

export class FastmailJmapTokenMissingError extends Error {
    constructor() {
        super('No Fastmail JMAP token is configured.')
        this.name = 'FastmailJmapTokenMissingError'
    }
}

export async function createFastmailJmapClient(signal?: AbortSignal) {
    const token = await getFastmailJmapToken()

    if (!token) {
        throw new FastmailJmapTokenMissingError()
    }

    const client = new JMAPClient(createBearerTransport(token), {
        hostname: FASTMAIL_JMAP_HOSTNAME,
    })

    await client.registerCapabilities(EmailCapability)
    await client.connect(signal)

    const accountId = client.primaryAccounts[EMAIL_CAPABILITY_URI]

    if (!accountId) {
        await client.disconnect()
        throw new Error(
            'Fastmail JMAP session did not include a primary mail account.'
        )
    }

    return { accountId, client, token }
}

export async function fetchJmapMailboxes(signal?: AbortSignal) {
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        return await getMailboxes(client, accountId, signal)
    } finally {
        await client.disconnect()
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
    const { accountId, client } = await createFastmailJmapClient(signal)

    try {
        const mailboxes = await getMailboxes(client, accountId, signal)
        const mailbox = findMailbox(mailboxes, mailboxId)
        const page = mailbox
            ? await getMailboxMessagesPage(
                  client,
                  accountId,
                  mailbox.id,
                  position,
                  limit,
                  signal
              )
            : null
        const threads = page
            ? await getThreadsForMessages(
                  client,
                  accountId,
                  page.messages,
                  mailboxes,
                  signal
              )
            : {}
        const messages = page?.messages
            ? applyThreadCountsToMessages(page.messages, threads)
            : []

        return {
            accountId,
            mailbox,
            mailboxes,
            messages,
            position: page?.position ?? position,
            threads,
            total: page?.total ?? null,
            username: client.username,
        }
    } finally {
        await client.disconnect()
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
        await client.disconnect()
    }
}

export async function fetchJmapMessageBody(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageBody | null> {
    const { accountId, client, token } = await createFastmailJmapClient(signal)

    try {
        const messages = await getEmails(
            client,
            accountId,
            [messageId],
            emailBodyProperties,
            signal
        )
        const message = messages[0]

        return message
            ? await getEmailBody(client, accountId, token, message, signal)
            : null
    } finally {
        await client.disconnect()
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
        await client.disconnect()
    }
}

export async function archiveJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'archive', signal)
}

export async function unarchiveJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'inbox', signal)
}

export async function trashJmapEmail(
    messageId: string,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
    return moveJmapEmailToRole(messageId, 'trash', signal)
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

function createBearerTransport(token: string): Transport {
    async function request<T>(
        method: 'GET' | 'POST',
        url: string | URL,
        options: TransportRequestOptions = {}
    ): Promise<T> {
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
        const response = await fetch(requestUrl, {
            body: method === 'POST' ? options.body : undefined,
            headers,
            method,
            signal: options.signal,
        })

        if (!response.ok) {
            throw new Error(await getErrorMessage(response, method))
        }

        if (options.responseType === 'blob') {
            return (await response.blob()) as T
        }

        return (await response.json()) as T
    }

    return {
        get: (url, options) => request('GET', url, options),
        post: (url, options) => request('POST', url, options),
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

async function getThreadsForMessages(
    client: JMAPClient,
    accountId: Id,
    messages: Message[],
    mailboxes: JmapMailbox[],
    signal?: AbortSignal
): Promise<Record<string, JmapThread>> {
    const threadIds = Array.from(
        new Set(messages.map((message) => message.threadId).filter(Boolean))
    ) as Id[]

    if (!threadIds.length) {
        return {}
    }

    const threads = await getThreads(client, accountId, threadIds, signal)
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

        return { mailboxIds }
    } finally {
        await client.disconnect()
    }
}

async function updateJmapEmailKeywords(
    messageId: string,
    keyword: '$flagged' | '$seen',
    enabled: boolean,
    signal?: AbortSignal
): Promise<JmapMessageActionResult> {
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

        await updateEmail(client, accountId, messageId, { keywords }, signal)

        return {
            keywords,
            pinned: keywords.$flagged === true,
            unread: keywords.$seen !== true,
        }
    } finally {
        await client.disconnect()
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
    const response = await client
        .createRequestBuilder()
        .add(
            Email.request.set({
                accountId,
                update: {
                    [messageId]: patch,
                },
            })
        )
        .send(signal)
    let didReceiveSetResponse = false

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
        const error = notUpdated?.[messageId]

        if (error) {
            const detail = error.description ? `: ${error.description}` : ''

            throw new Error(
                `JMAP Email/set ${error.type ?? 'notUpdated'}${detail}`
            )
        }
    }

    if (!didReceiveSetResponse) {
        throw new Error('JMAP Email/set did not return a response.')
    }
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

    return {
        attachments,
        avatar: getInitials(sender),
        avatarColor: colorForString(from?.email ?? sender),
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
        to: email.to?.map(formatAddress).join(', '),
        unread: email.keywords?.['$seen'] !== true,
    }
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

function getPlainTextBody(email: EmailObject) {
    const chunks = email.textBody
        ?.map((part) =>
            part.partId ? email.bodyValues?.[part.partId]?.value : null
        )
        .filter((value): value is string => Boolean(value?.trim()))

    if (chunks?.length) {
        return chunks.join('\n\n')
    }

    return email.preview?.trim() || null
}

async function getEmailBody(
    client: JMAPClient,
    accountId: Id,
    token: string,
    email: EmailObject,
    signal?: AbortSignal
): Promise<JmapMessageBody> {
    const html = getHtmlBody(email)
    const inlinedHtml = html
        ? await inlineCidImages(client, accountId, token, html, email, signal)
        : null

    return {
        attachments: await getDownloadableAttachmentsWithPreviews(
            client,
            accountId,
            token,
            email,
            html,
            signal
        ),
        debug: inlinedHtml?.debug,
        html: inlinedHtml?.html ?? null,
        text: getPlainTextBody(email),
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
    html: string
): JmapMessageBodyDebug {
    return {
        attachmentPartCount: email.attachments?.length ?? 0,
        bodyStructurePartCount: flattenBodyParts(email.bodyStructure).length,
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
