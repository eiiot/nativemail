import type { EmailFilterCondition } from 'jmap-kit'

export function parseJmapSearchQuery(value: string): EmailFilterCondition {
  const filter: EmailFilterCondition = {}
  const freeText: string[] = []
  const tokenPattern = /([a-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi

  for (const match of value.matchAll(tokenPattern)) {
    const key = (match[1] ?? '').toLowerCase()
    const operand = match[2] ?? match[3] ?? ''
    const token = match[4] ?? match[5] ?? ''

    if (operand && ['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) {
      ;(filter as Record<string, unknown>)[key] = operand
    } else if (operand && key === 'before') {
      const date = parseSearchDate(operand, false)
      if (date) filter.before = date
    } else if (operand && key === 'after') {
      const date = parseSearchDate(operand, true)
      if (date) filter.after = date
    } else if (key === 'has' && operand.toLowerCase() === 'attachment') {
      filter.hasAttachment = true
    } else if (key === 'is' && operand.toLowerCase() === 'unread') {
      filter.notKeyword = '$seen'
    } else if (key === 'is' && operand.toLowerCase() === 'read') {
      filter.hasKeyword = '$seen'
    } else if (key === 'is' && ['starred', 'flagged'].includes(operand.toLowerCase())) {
      filter.hasKeyword = '$flagged'
    } else {
      freeText.push(key ? `${key}:${operand}` : token)
    }
  }

  if (freeText.length) filter.text = freeText.join(' ')
  return filter
}

function parseSearchDate(value: string, startOfDay: boolean) {
  const date = new Date(`${value}T${startOfDay ? '00:00:00.000' : '23:59:59.999'}Z`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
