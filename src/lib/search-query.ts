import type { EmailFilterCondition, FilterOperator } from 'jmap-kit'

export type JmapSearchFilter = EmailFilterCondition | FilterOperator<EmailFilterCondition>

export function parseJmapSearchQuery(value: string): JmapSearchFilter {
  const conditions: EmailFilterCondition[] = []
  const tokenPattern = /([a-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi

  for (const match of value.matchAll(tokenPattern)) {
    const key = (match[1] ?? '').toLowerCase()
    const operand = match[2] ?? match[3] ?? ''
    const token = match[4] ?? match[5] ?? ''

    if (operand && ['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) {
      conditions.push({ [key]: operand })
    } else if (operand && key === 'before') {
      const date = parseSearchDate(operand, false)
      if (date) conditions.push({ before: date })
    } else if (operand && key === 'after') {
      const date = parseSearchDate(operand, true)
      if (date) conditions.push({ after: date })
    } else if (key === 'has' && operand.toLowerCase() === 'attachment') {
      conditions.push({ hasAttachment: true })
    } else if (key === 'is' && operand.toLowerCase() === 'unread') {
      conditions.push({ notKeyword: '$seen' })
    } else if (key === 'is' && operand.toLowerCase() === 'read') {
      conditions.push({ hasKeyword: '$seen' })
    } else if (key === 'is' && ['starred', 'flagged'].includes(operand.toLowerCase())) {
      conditions.push({ hasKeyword: '$flagged' })
    } else {
      conditions.push({ text: key ? `${key}:${operand}` : token })
    }
  }

  if (conditions.length <= 1) return conditions[0] ?? {}
  return { conditions, operator: 'AND' }
}

function parseSearchDate(value: string, startOfDay: boolean) {
  const date = new Date(`${value}T${startOfDay ? '00:00:00.000' : '23:59:59.999'}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
