import type { SyncStateSnapshot } from './state-tracker'

export type JmapMethodCall = [string, Record<string, unknown>, string]
export type JmapMethodResponse = [string, Record<string, unknown>, string]

export type JmapRequestBody = {
    methodCalls: JmapMethodCall[]
    using: string[]
}

export class JmapMethodError extends Error {
    readonly callId: string
    readonly type: string

    constructor(callId: string, type: string, description?: string) {
        super(`JMAP method call ${callId} failed: ${type}${description ? ` (${description})` : ''}`)
        this.name = 'JmapMethodError'
        this.callId = callId
        this.type = type
    }
}

const jmapMailUsing = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']

const stateTypeByMethod: Record<string, string> = {
    'Email/get': 'Email',
    'Mailbox/get': 'Mailbox',
    'Thread/get': 'Thread',
}

export const stateProbeCallIds = {
    email: 'states/email',
    mailbox: 'states/mailbox',
} as const

/**
 * A minimal request whose responses carry the current server state strings
 * for Mailbox and Email without returning any records.
 */
export function buildStateProbeRequest(accountId: string): JmapRequestBody {
    return {
        methodCalls: [
            ['Mailbox/get', { accountId, ids: [], properties: ['id'] }, stateProbeCallIds.mailbox],
            ['Email/get', { accountId, ids: [], properties: ['id'] }, stateProbeCallIds.email],
        ],
        using: jmapMailUsing,
    }
}

export const mailboxPageCallIds = {
    emails: 'page/emails',
    mailboxes: 'page/mailboxes',
    query: 'page/query',
    threads: 'page/threads',
} as const

/**
 * One round trip for a full mailbox page: mailbox list, message ids for the
 * page, message metadata, and the threads those messages belong to. The
 * Email/get and Thread/get calls consume the prior results through JMAP
 * back-references instead of separate requests.
 */
export function buildMailboxPageRequest({
    accountId,
    emailProperties,
    limit,
    mailboxId,
    position = 0,
}: {
    accountId: string
    emailProperties: string[]
    limit: number
    mailboxId: string
    position?: number
}): JmapRequestBody {
    return {
        methodCalls: [
            ['Mailbox/get', { accountId, ids: null }, mailboxPageCallIds.mailboxes],
            [
                'Email/query',
                {
                    accountId,
                    calculateTotal: true,
                    filter: { inMailbox: mailboxId },
                    limit,
                    position,
                    sort: [{ isAscending: false, property: 'receivedAt' }],
                },
                mailboxPageCallIds.query,
            ],
            [
                'Email/get',
                {
                    '#ids': {
                        name: 'Email/query',
                        path: '/ids',
                        resultOf: mailboxPageCallIds.query,
                    },
                    accountId,
                    properties: emailProperties,
                },
                mailboxPageCallIds.emails,
            ],
            [
                'Thread/get',
                {
                    '#ids': {
                        name: 'Email/get',
                        path: '/list/*/threadId',
                        resultOf: mailboxPageCallIds.emails,
                    },
                    accountId,
                },
                mailboxPageCallIds.threads,
            ],
        ],
        using: jmapMailUsing,
    }
}

/**
 * Returns the arguments of the method response with the given call id,
 * throwing if the server answered that call with a method-level error.
 * Returns null when the call id is absent from the response list.
 */
export function getMethodResult(
    responses: JmapMethodResponse[],
    callId: string
): Record<string, unknown> | null {
    for (const [method, args, responseCallId] of responses) {
        if (responseCallId !== callId) {
            continue
        }

        if (method === 'error') {
            const type = typeof args.type === 'string' ? args.type : 'unknownError'
            const description = typeof args.description === 'string' ? args.description : undefined
            throw new JmapMethodError(callId, type, description)
        }

        return args
    }

    return null
}

/**
 * Collects the server state strings present in a response list, keyed by
 * data type (Mailbox, Email, Thread). Email/query state is intentionally
 * excluded: query state changes on reordering even when no record changed.
 */
export function extractStates(responses: JmapMethodResponse[]): SyncStateSnapshot {
    const states: SyncStateSnapshot = {}

    for (const [method, args] of responses) {
        const type = stateTypeByMethod[method]

        if (type && typeof args.state === 'string') {
            states[type] = args.state
        }
    }

    return states
}
