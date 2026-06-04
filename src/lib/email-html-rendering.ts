export type EmailHtmlColorSet = {
  background: string;
  groupDivider: string;
  secondaryText: string;
  text: string;
};

export const defaultEmailBodyWidth = 390;
export const minEmailBodyWebViewHeight = 80;
export const maxEmailBodyWebViewHeight = 60000;

export function getEmailHtmlDocument({
  colors,
  contentWidth,
  horizontalPadding,
  html,
}: {
  colors: EmailHtmlColorSet;
  contentWidth: number;
  horizontalPadding: number;
  html: string;
}) {
  const email = getEmailHtmlParts(html);

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<meta name="nativemail-content-width" content="${contentWidth}">`,
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data: cid: blob: http: https:; style-src &#39;unsafe-inline&#39;; font-src data:; media-src none; object-src none; frame-src none; connect-src none; script-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">',
    '<style>',
    getEmailHtmlStyles(colors, email.hasBodyMarginAttributes, horizontalPadding),
    '</style>',
    email.head,
    '</head>',
    `<body${email.bodyAttributes}>`,
    email.body,
    '</body>',
    '</html>',
  ].join('');
}

export function getEmailBodyHeightScript(contentWidth: number) {
  return `
    (function () {
      var lastHeight = 0;
      var displayWidth = ${contentWidth};

      function getNaturalWidth() {
        var body = document.body;
        var doc = document.documentElement;

        return Math.max(
          displayWidth,
          body ? body.scrollWidth : 0,
          body ? body.offsetWidth : 0,
          doc ? doc.scrollWidth : 0,
          doc ? doc.offsetWidth : 0
        );
      }

      function getHeight() {
        var body = document.body;
        var doc = document.documentElement;

        return Math.max(
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          doc ? doc.clientHeight : 0,
          doc ? doc.scrollHeight : 0,
          doc ? doc.offsetHeight : 0
        );
      }

      function getHost(value) {
        try {
          return new URL(value, document.baseURI).hostname;
        } catch (error) {
          return '';
        }
      }

      function getImageDebug(phase) {
        var images = Array.prototype.slice.call(document.images || []);

        return {
          phase: phase,
          imageCount: images.length,
          images: images.map(function (image) {
            return {
              complete: Boolean(image.complete),
              currentSrcHost: getHost(image.currentSrc || ''),
              naturalHeight: image.naturalHeight || 0,
              naturalWidth: image.naturalWidth || 0,
              srcHost: getHost(image.getAttribute('src') || image.src || ''),
              srcPrefix: (image.getAttribute('src') || image.src || '').slice(0, 160),
              status: image.getAttribute('data-nativemail-image-status') || 'snapshot'
            };
          })
        };
      }

      function postImageDebug(phase) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'image-debug',
          imageDebug: getImageDebug(phase)
        }));
      }

      function attachImageDebug() {
        var images = Array.prototype.slice.call(document.images || []);

        images.forEach(function (image) {
          if (image.__nativemailImageDebugAttached) {
            return;
          }

          image.__nativemailImageDebugAttached = true;
          image.addEventListener('load', function () {
            image.setAttribute('data-nativemail-image-status', 'load');
            postImageDebug('image-load');
            postHeight();
          });
          image.addEventListener('error', function () {
            image.setAttribute('data-nativemail-image-status', 'error');
            postImageDebug('image-error');
            postHeight();
          });
        });
      }

      function postHeight() {
        var naturalWidth = getNaturalWidth();
        var scale = naturalWidth > displayWidth ? displayWidth / naturalWidth : 1;
        var viewport = document.querySelector('meta[name="viewport"]');

        if (viewport && naturalWidth > displayWidth) {
          viewport.setAttribute(
            'content',
            'width=' + Math.ceil(naturalWidth) + ', initial-scale=' + scale + ', viewport-fit=cover'
          );
        }

        var height = getHeight() * scale;

        if (!height || Math.abs(height - lastHeight) <= 1) {
          return;
        }

        lastHeight = height;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'height',
          height: height
        }));
      }

      attachImageDebug();
      postImageDebug('initial');
      postHeight();
      window.addEventListener('load', function () {
        attachImageDebug();
        postImageDebug('window-load');
        postHeight();
      });
      window.addEventListener('resize', postHeight);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-50');
        postHeight();
      }, 50);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-250');
        postHeight();
      }, 250);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-1000');
        postHeight();
      }, 1000);

      if (window.ResizeObserver) {
        var resizeObserver = new ResizeObserver(postHeight);
        resizeObserver.observe(document.documentElement);

        if (document.body) {
          resizeObserver.observe(document.body);
        }
      }

      if (window.MutationObserver && document.body) {
        new MutationObserver(function () {
          attachImageDebug();
          postImageDebug('mutation');
          postHeight();
        }).observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true
        });
      }
    })();
    true;
  `;
}

export function clampEmailBodyHeight(height: number) {
  return Math.min(maxEmailBodyWebViewHeight, Math.max(minEmailBodyWebViewHeight, Math.ceil(height)));
}

export function estimateEmailBodyHeight(html: string, contentWidth: number) {
  const text = sanitizeEmailHtml(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const imageCount = (html.match(/<img\b/gi) ?? []).length;
  const charsPerLine = Math.max(28, Math.floor(contentWidth / 8.5));
  const textLines = Math.ceil(text.length / charsPerLine);

  return clampEmailBodyHeight(32 + textLines * 23 + imageCount * Math.min(260, contentWidth * 0.62));
}

function getEmailHtmlStyles(
  colors: EmailHtmlColorSet,
  hasBodyMarginAttributes: boolean,
  horizontalPadding: number,
) {
  return `
    html {
      background: ${colors.background};
      -webkit-text-size-adjust: 100%;
    }
    body {
      background: ${colors.background};
      color: ${colors.text};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.44;
      ${hasBodyMarginAttributes ? '' : `margin: 8px ${horizontalPadding}px;`}
      overflow-x: hidden;
      word-break: normal;
      overflow-wrap: anywhere;
      -webkit-text-size-adjust: 100%;
    }
    blockquote {
      border-left: 3px solid ${colors.groupDivider};
      color: ${colors.secondaryText};
      margin-left: 0;
      padding-left: 12px;
    }
    img {
      max-width: 100% !important;
      height: auto !important;
    }
    pre, code {
      white-space: pre-wrap;
    }
  `;
}

function getEmailHtmlParts(html: string) {
  const sanitized = sanitizeEmailHtml(html);
  const headMatch = sanitized.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = sanitized.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
  const head = headMatch?.[1] ?? '';

  if (bodyMatch) {
    const bodyAttributes = bodyMatch[1] ?? '';

    return {
      body: bodyMatch[2],
      bodyAttributes: sanitizeEmailBodyAttributes(bodyAttributes),
      hasBodyMarginAttributes: hasEmailBodyMarginAttributes(bodyAttributes),
      head,
    };
  }

  return {
    body: sanitized
      .replace(/<!doctype\b[^>]*>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?html\b[^>]*>/gi, ''),
    bodyAttributes: '',
    hasBodyMarginAttributes: false,
    head,
  };
}

function hasEmailBodyMarginAttributes(attributes: string) {
  return /\s(?:leftmargin|rightmargin|topmargin|bottommargin|marginwidth|marginheight)\s*=/i.test(attributes);
}

function sanitizeEmailBodyAttributes(attributes: string) {
  const normalized = attributes
    .replace(/[<>]/g, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .trim();

  return normalized ? ` ${normalized}` : '';
}

function sanitizeEmailHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+(href|src)\s*=\s*"javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s+(href|src)\s*=\s*'javascript:[^']*'/gi, " $1='#'")
    .replace(/\s+(href|src)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
}
