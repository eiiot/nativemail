export type EmailReplyHtmlSplit = {
  afterQuoteHtml: string | null;
  bodyHtml: string;
  quoteHtml: string | null;
};

export type EmailReplyTextSplit = {
  bodyText: string;
  quoteText: string | null;
};

export type EmailForwardHtmlSplit = {
  forwardedHtml: string;
  introHtml: string;
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

const forwardedIntroPatterns = [
  /\bBegin forwarded message\s*:/i,
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /\bForwarded message\s*:/i,
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
    return { afterQuoteHtml: null, bodyHtml: html, quoteHtml: null };
  }

  const fragments = splitHtmlQuoteFragments(parts.body, quoteBoundary);
  const body = fragments.body.trim();
  const quote = fragments.quote.trim();
  const afterQuote = fragments.afterQuote.trim();

  if (!hasMeaningfulHtmlContent(body) || !hasMeaningfulHtmlContent(quote)) {
    return { afterQuoteHtml: null, bodyHtml: html, quoteHtml: null };
  }

  return {
    afterQuoteHtml: afterQuote ? wrapHtmlDocumentPart(parts, afterQuote) : null,
    bodyHtml: wrapHtmlDocumentPart(parts, body),
    quoteHtml: wrapHtmlDocumentPart(parts, quote),
  };
}

export function splitEmailForwardHtml(html: string): EmailForwardHtmlSplit | null {
  const parts = getHtmlDocumentParts(html);
  const split = findAppleMailForwardSplit(parts.body);

  if (!split) {
    return null;
  }

  const intro = parts.body.slice(0, split.forwardedBodyStart).trim();
  const forwarded = parts.body.slice(split.forwardedBodyStart).trim();

  if (!hasMeaningfulHtmlContent(intro) || !hasMeaningfulHtmlContent(forwarded)) {
    return null;
  }

  return {
    forwardedHtml: wrapHtmlDocumentPart(parts, forwarded),
    introHtml: wrapHtmlDocumentPart(parts, intro),
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

function findAppleMailForwardSplit(html: string) {
  const rawIntroMatch = getFirstForwardedIntroMatch(html);
  const hasIntro = rawIntroMatch ?? getFirstForwardedIntroMatch(getHtmlTextContent(html));

  if (!hasIntro) {
    return null;
  }

  const citeBoundary = getFirstTypeCiteBlockquoteBoundary(html, rawIntroMatch?.index ?? 0);

  if (citeBoundary === null) {
    return null;
  }

  const headerEnd = getElementEnd(html, citeBoundary, 'blockquote');

  if (headerEnd === null) {
    return null;
  }

  const forwardedBodyMatch = /<blockquote\b(?=[^>]*\btype\s*=\s*["']cite["'])[^>]*>/i.exec(html.slice(headerEnd));

  if (!forwardedBodyMatch) {
    return null;
  }

  return {
    forwardedBodyStart: headerEnd + forwardedBodyMatch.index,
  };
}

function getFirstTypeCiteBlockquoteBoundary(html: string, startIndex: number) {
  const match = /<blockquote\b(?=[^>]*\btype\s*=\s*["']cite["'])[^>]*>/i.exec(html.slice(startIndex));

  return match ? startIndex + match.index : null;
}

function getElementEnd(html: string, startIndex: number, tagName: string) {
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const closePattern = new RegExp(`</${tagName}\\s*>`, 'gi');
  let depth = 0;
  let cursor = startIndex;

  while (cursor < html.length) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;

    const openMatch = openPattern.exec(html);
    const closeMatch = closePattern.exec(html);

    if (!closeMatch) {
      return null;
    }

    if (openMatch && openMatch.index < closeMatch.index) {
      depth += 1;
      cursor = openPattern.lastIndex;
      continue;
    }

    depth -= 1;
    cursor = closePattern.lastIndex;

    if (depth <= 0) {
      return cursor;
    }
  }

  return null;
}

function findHtmlQuoteBoundary(html: string) {
  const boundary = getFirstKnownHtmlBoundary(html) ?? getOutlookHeaderBoundary(html);

  if (boundary === null) {
    return null;
  }

  if (isForwardedHtmlBoundary(html, boundary)) {
    return null;
  }

  return getQuoteBoundaryWithIntro(html, boundary);
}

function splitHtmlQuoteFragments(html: string, quoteBoundary: number) {
  if (isOutlookReplyForwardHeaderBoundary(html, quoteBoundary)) {
    return {
      afterQuote: '',
      body: html.slice(0, quoteBoundary),
      quote: html.slice(quoteBoundary),
    };
  }

  const boundary = getFirstKnownHtmlBoundaryAfter(html, quoteBoundary);
  const quoteEnd = boundary === null ? null : getHtmlBoundaryElementEnd(html, boundary);

  if (quoteEnd === null || quoteEnd <= quoteBoundary || quoteEnd >= html.length) {
    return {
      afterQuote: '',
      body: html.slice(0, quoteBoundary),
      quote: html.slice(quoteBoundary),
    };
  }

  const afterQuote = html.slice(quoteEnd);

  if (!shouldKeepVisibleHtmlAfterQuote(afterQuote)) {
    return {
      afterQuote: '',
      body: html.slice(0, quoteBoundary),
      quote: html.slice(quoteBoundary),
    };
  }

  return {
    afterQuote,
    body: html.slice(0, quoteBoundary),
    quote: html.slice(quoteBoundary, quoteEnd),
  };
}

function isOutlookReplyForwardHeaderBoundary(html: string, quoteBoundary: number) {
  const boundaryPrefix = html.slice(quoteBoundary, Math.min(html.length, quoteBoundary + 1800));

  return /^\s*(?:<hr\b[^>]*>\s*)?(?:[\s\S]{0,800}?)<div\b(?=[^>]*\bid\s*=\s*["']divRplyFwdMsg["'])[^>]*>/i.test(boundaryPrefix);
}

function getFirstKnownHtmlBoundaryAfter(html: string, startIndex: number) {
  const searchEnd = Math.min(html.length, startIndex + 2400);
  const search = html.slice(startIndex, searchEnd);
  const boundary = getFirstKnownHtmlBoundary(search);

  return boundary === null ? null : startIndex + boundary;
}

function getHtmlBoundaryElementEnd(html: string, boundary: number) {
  const tagMatch = /^<([a-z][a-z0-9:-]*)\b/i.exec(html.slice(boundary));
  const tagName = tagMatch?.[1]?.toLowerCase();

  if (!tagName) {
    return null;
  }

  return getElementEnd(html, boundary, tagName);
}

function shouldKeepVisibleHtmlAfterQuote(html: string) {
  if (!hasMeaningfulHtmlContent(html)) {
    return false;
  }

  const text = getHtmlTextContent(html);

  if (!text) {
    return false;
  }

  if (text.length <= 600) {
    return true;
  }

  return /\b(?:best|regards|thanks|thank you|sent from my|cheers|sincerely)\b/i.test(text.slice(0, 240));
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

    if (isForwardedTextBoundary(text, match.index)) {
      continue;
    }

    boundary = boundary === null ? match.index : Math.min(boundary, match.index);
  }

  return boundary;
}

function isForwardedHtmlBoundary(html: string, boundary: number) {
  const before = getHtmlTextContent(html.slice(Math.max(0, boundary - 1200), boundary));
  const after = getHtmlTextContent(html.slice(boundary, Math.min(html.length, boundary + 1200)));

  return hasForwardedIntro(before) || hasForwardedIntro(after);
}

function isForwardedTextBoundary(text: string, boundary: number) {
  const before = text.slice(Math.max(0, boundary - 1200), boundary);
  const after = text.slice(boundary, Math.min(text.length, boundary + 1200));

  return hasForwardedIntro(before) || hasForwardedIntro(after);
}

function hasForwardedIntro(text: string) {
  return Boolean(getFirstForwardedIntroMatch(text));
}

function getFirstForwardedIntroMatch(text: string) {
  let firstMatch: RegExpExecArray | null = null;

  for (const pattern of forwardedIntroPatterns) {
    const match = pattern.exec(text);

    if (!match) {
      continue;
    }

    if (!firstMatch || match.index < firstMatch.index) {
      firstMatch = match;
    }
  }

  return firstMatch;
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
