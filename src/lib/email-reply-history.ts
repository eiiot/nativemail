export type EmailReplyHtmlSplit = {
  bodyHtml: string;
  quoteHtml: string | null;
};

export type EmailReplyTextSplit = {
  bodyText: string;
  quoteText: string | null;
};

type HtmlDocumentParts = {
  body: string;
  bodyAttributes: string;
  head: string;
  hasDocumentShell: boolean;
};

const knownHtmlQuoteBoundaryPatterns = [
  /<blockquote\b(?=[^>]*(?:type\s*=\s*["']cite["']|class\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix)[^"']*["']))[^>]*>/i,
  /<div\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix|divRplyFwdMsg|OLK_SRC_BODY_SECTION)[^"']*["'])[^>]*>/i,
  /<section\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix|OLK_SRC_BODY_SECTION)[^"']*["'])[^>]*>/i,
  /<table\b(?=[^>]*(?:class|id)\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted|protonmail_quote)[^"']*["'])[^>]*>/i,
];

const replyIntroPatterns = [
  /\bOn[\s\S]{0,420}\bwrote\s*:/gi,
  /\bFrom\s*:[\s\S]{0,900}\bSent\s*:[\s\S]{0,900}\bTo\s*:/gi,
  /-{2,}\s*Original Message\s*-{2,}/gi,
];

const textReplyBoundaryPatterns = [
  /^On .{0,420}\bwrote\s*:$/gim,
  /^From\s*:.{0,900}\nSent\s*:.{0,900}\nTo\s*:/gim,
  /^-{2,}\s*Original Message\s*-{2,}$/gim,
];

export function splitEmailReplyHtml(html: string): EmailReplyHtmlSplit {
  const parts = getHtmlDocumentParts(html);
  const quoteBoundary = findHtmlQuoteBoundary(parts.body);

  if (quoteBoundary === null) {
    return { bodyHtml: html, quoteHtml: null };
  }

  const body = parts.body.slice(0, quoteBoundary).trim();
  const quote = parts.body.slice(quoteBoundary).trim();

  if (!hasMeaningfulHtmlContent(body) || !hasMeaningfulHtmlContent(quote)) {
    return { bodyHtml: html, quoteHtml: null };
  }

  return {
    bodyHtml: wrapHtmlDocumentPart(parts, body),
    quoteHtml: wrapHtmlDocumentPart(parts, quote),
  };
}

export function splitEmailReplyText(text: string): EmailReplyTextSplit {
  const quoteBoundary = findTextQuoteBoundary(text);

  if (quoteBoundary === null) {
    return { bodyText: text, quoteText: null };
  }

  const bodyText = text.slice(0, quoteBoundary).trim();
  const quoteText = text.slice(quoteBoundary).trim();

  if (!bodyText || !quoteText) {
    return { bodyText: text, quoteText: null };
  }

  return { bodyText, quoteText };
}

function findHtmlQuoteBoundary(html: string) {
  const boundary = getFirstKnownHtmlBoundary(html) ?? getOutlookHeaderBoundary(html);

  if (boundary === null) {
    return null;
  }

  return getQuoteBoundaryWithIntro(html, boundary);
}

function getFirstKnownHtmlBoundary(html: string) {
  let boundary: number | null = null;

  for (const pattern of knownHtmlQuoteBoundaryPatterns) {
    const match = pattern.exec(html);

    if (!match) {
      continue;
    }

    boundary = boundary === null ? match.index : Math.min(boundary, match.index);
  }

  return boundary;
}

function getOutlookHeaderBoundary(html: string) {
  const separatorMatch = /<hr\b[^>]*>[\s\S]{0,1800}\bFrom\s*:[\s\S]{0,1200}\bSent\s*:[\s\S]{0,1200}\bTo\s*:/i.exec(html);

  if (separatorMatch) {
    return separatorMatch.index;
  }

  const headerMatch = /\bFrom\s*:[\s\S]{0,900}\bSent\s*:[\s\S]{0,900}\bTo\s*:/i.exec(html);

  return headerMatch?.index ?? null;
}

function getQuoteBoundaryWithIntro(html: string, boundary: number) {
  const searchStart = Math.max(0, boundary - 1800);
  const prefix = html.slice(searchStart, boundary);
  let nextBoundary = boundary;

  for (const pattern of replyIntroPatterns) {
    pattern.lastIndex = 0;

    for (let match = pattern.exec(prefix); match; match = pattern.exec(prefix)) {
      const introIndex = searchStart + match.index;
      nextBoundary = Math.min(nextBoundary, getContainingBlockStart(html, introIndex));
    }
  }

  const separatorIndex = prefix.lastIndexOf('<hr');

  if (separatorIndex >= 0) {
    nextBoundary = Math.min(nextBoundary, searchStart + separatorIndex);
  }

  return nextBoundary;
}

function findTextQuoteBoundary(text: string) {
  let boundary: number | null = null;

  for (const pattern of textReplyBoundaryPatterns) {
    pattern.lastIndex = 0;

    const match = pattern.exec(text);

    if (!match) {
      continue;
    }

    boundary = boundary === null ? match.index : Math.min(boundary, match.index);
  }

  return boundary;
}

function getContainingBlockStart(html: string, index: number) {
  const blockTags = ['<div', '<p', '<table', '<tr', '<td', '<blockquote', '<section', '<article'];
  let blockStart = -1;

  for (const blockTag of blockTags) {
    const candidate = html.lastIndexOf(blockTag, index);

    if (candidate > blockStart) {
      blockStart = candidate;
    }
  }

  return blockStart >= 0 ? blockStart : index;
}

function getHtmlDocumentParts(html: string): HtmlDocumentParts {
  const head = getCombinedHeadHtml(html);
  const bodyMatches = Array.from(html.matchAll(/<body\b([^>]*)>([\s\S]*?)<\/body>/gi));

  if (bodyMatches.length) {
    return {
      body: bodyMatches.map((match) => match[2] ?? '').join('\n'),
      bodyAttributes: bodyMatches[0]?.[1] ?? '',
      head,
      hasDocumentShell: true,
    };
  }

  const body = html
    .replace(/<!doctype\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '');

  return {
    body,
    bodyAttributes: '',
    head,
    hasDocumentShell: Boolean(head),
  };
}

function getCombinedHeadHtml(html: string) {
  return Array.from(html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/gi))
    .map((match) => match[1] ?? '')
    .join('\n');
}

function wrapHtmlDocumentPart(parts: HtmlDocumentParts, body: string) {
  if (!parts.hasDocumentShell) {
    return body;
  }

  return [
    '<html>',
    '<head>',
    parts.head,
    '</head>',
    `<body${parts.bodyAttributes}>`,
    body,
    '</body>',
    '</html>',
  ].join('');
}

function hasMeaningfulHtmlContent(html: string) {
  if (/<(?:img|table|video|audio|canvas|svg)\b/i.test(html)) {
    return true;
  }

  return getHtmlTextContent(html).length > 0;
}

function getHtmlTextContent(html: string) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&[#a-z0-9]+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}
