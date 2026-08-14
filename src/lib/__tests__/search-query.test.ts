import { describe, expect, it } from 'vitest'

import { parseJmapSearchQuery } from '../search-query'

describe('parseJmapSearchQuery', () => {
  it('keeps ordinary terms as full-text search', () => {
    expect(parseJmapSearchQuery('quarterly payroll')).toEqual({
      conditions: [{ text: 'quarterly' }, { text: 'payroll' }],
      operator: 'AND',
    })
  })

  it('parses Fastmail-style advanced fields and quoted values', () => {
    expect(parseJmapSearchQuery('from:rippling subject:"you got paid" has:attachment is:unread')).toEqual({
      conditions: [
        { from: 'rippling' },
        { subject: 'you got paid' },
        { hasAttachment: true },
        { notKeyword: '$seen' },
      ],
      operator: 'AND',
    })
  })

  it('parses date bounds and preserves unknown operators as text', () => {
    expect(parseJmapSearchQuery('after:2026-07-01 before:2026-08-01 label:finance')).toEqual({
      conditions: [
        { after: '2026-07-01T00:00:00.000Z' },
        { before: '2026-08-01T23:59:59.999Z' },
        { text: 'label:finance' },
      ],
      operator: 'AND',
    })
  })
})
