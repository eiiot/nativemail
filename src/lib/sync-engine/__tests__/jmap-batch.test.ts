import { describe, expect, it } from 'vitest'

import {
    buildMailboxPageRequest,
    buildStateProbeRequest,
    extractStates,
    getMethodResult,
    JmapMethodError,
    mailboxPageCallIds,
    type JmapMethodResponse,
} from '../jmap-batch'

describe('buildStateProbeRequest', () => {
    it('requests only state strings, no records', () => {
        const request = buildStateProbeRequest('account-1')

        expect(request.using).toContain('urn:ietf:params:jmap:mail')
        expect(request.methodCalls).toHaveLength(2)

        for (const [, args] of request.methodCalls) {
            expect(args.ids).toEqual([])
        }
    })
})

describe('buildMailboxPageRequest', () => {
    const request = buildMailboxPageRequest({
        accountId: 'account-1',
        emailProperties: ['id', 'threadId'],
        limit: 25,
        mailboxId: 'mailbox-1',
        position: 50,
    })

    it('contains the four page calls in one request', () => {
        expect(request.methodCalls.map(([method]) => method)).toEqual([
            'Mailbox/get',
            'Email/query',
            'Email/get',
            'Thread/get',
        ])
    })

    it('passes the paging arguments to Email/query', () => {
        const [, args] = request.methodCalls[1]
        expect(args).toMatchObject({
            accountId: 'account-1',
            calculateTotal: true,
            filter: { inMailbox: 'mailbox-1' },
            limit: 25,
            position: 50,
        })
    })

    it('feeds Email/get from the query result via a back-reference', () => {
        const [, args] = request.methodCalls[2]
        expect(args['#ids']).toEqual({
            name: 'Email/query',
            path: '/ids',
            resultOf: mailboxPageCallIds.query,
        })
        expect(args.properties).toEqual(['id', 'threadId'])
    })

    it('feeds Thread/get from the fetched emails via a back-reference', () => {
        const [, args] = request.methodCalls[3]
        expect(args['#ids']).toEqual({
            name: 'Email/get',
            path: '/list/*/threadId',
            resultOf: mailboxPageCallIds.emails,
        })
    })
})

describe('getMethodResult', () => {
    const responses: JmapMethodResponse[] = [
        ['Mailbox/get', { list: [], state: 'm1' }, 'a'],
        ['error', { description: 'too much', type: 'requestTooLarge' }, 'b'],
    ]

    it('returns the arguments for a matching call id', () => {
        expect(getMethodResult(responses, 'a')).toEqual({ list: [], state: 'm1' })
    })

    it('returns null when the call id is missing', () => {
        expect(getMethodResult(responses, 'missing')).toBeNull()
    })

    it('throws a JmapMethodError for an error response', () => {
        expect(() => getMethodResult(responses, 'b')).toThrow(JmapMethodError)
        expect(() => getMethodResult(responses, 'b')).toThrow('requestTooLarge')
    })
})

describe('extractStates', () => {
    it('collects states by data type and ignores query state', () => {
        const responses: JmapMethodResponse[] = [
            ['Mailbox/get', { state: 'm1' }, 'a'],
            ['Email/get', { state: 'e1' }, 'b'],
            ['Email/query', { queryState: 'q1' }, 'c'],
            ['Thread/get', { state: 't1' }, 'd'],
        ]

        expect(extractStates(responses)).toEqual({ Email: 'e1', Mailbox: 'm1', Thread: 't1' })
    })

    it('ignores responses without a state string', () => {
        const responses: JmapMethodResponse[] = [['Email/get', { list: [] }, 'a']]
        expect(extractStates(responses)).toEqual({})
    })
})
