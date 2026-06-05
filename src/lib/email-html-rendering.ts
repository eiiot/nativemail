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

export function getEmailBodyHeightScript(contentWidth: number, darkMode = false) {
  return `
    (function () {
      var lastHeight = 0;
      var displayWidth = ${contentWidth};
      var darkMode = ${darkMode ? 'true' : 'false'};
      var darkSurfaceColor = 'rgb(28, 28, 30)';
      var darkTextColor = 'rgb(242, 242, 247)';
      var darkSecondaryTextColor = 'rgb(174, 174, 178)';
      var darkBorderColor = 'rgb(58, 58, 60)';
      var darkLinkColor = 'rgb(255, 159, 10)';
      var darkSurfaceRgb = { r: 28, g: 28, b: 30, a: 1 };
      var darkModeDebug = {
        accentTextCount: 0,
        backgroundCount: 0,
        borderCount: 0,
        linkCount: 0,
        skippedBackgroundImageCount: 0,
        skippedColoredBackgroundCount: 0,
        textCount: 0
      };

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

      function parseColor(value) {
        if (!value || value === 'transparent') {
          return null;
        }

        var match = value.match(/rgba?\\(([^)]+)\\)/i);

        if (!match) {
          return null;
        }

        var parts = match[1].split(',').map(function (part) {
          return part.trim();
        });
        var alpha = parts.length > 3 ? parseFloat(parts[3]) : 1;

        if (parts.length < 3 || alpha <= 0.05) {
          return null;
        }

        return {
          a: Number.isFinite(alpha) ? alpha : 1,
          b: parseFloat(parts[2]),
          g: parseFloat(parts[1]),
          r: parseFloat(parts[0])
        };
      }

      function getLuminance(color) {
        function channel(value) {
          var normalized = value / 255;

          return normalized <= 0.03928
            ? normalized / 12.92
            : Math.pow((normalized + 0.055) / 1.055, 2.4);
        }

        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      }

      function getContrastRatio(first, second) {
        var firstLuminance = getLuminance(first);
        var secondLuminance = getLuminance(second);
        var lighter = Math.max(firstLuminance, secondLuminance);
        var darker = Math.min(firstLuminance, secondLuminance);

        return (lighter + 0.05) / (darker + 0.05);
      }

      function getColorRange(color) {
        return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      }

      function isNeutralColor(color) {
        return getColorRange(color) <= 24;
      }

      function isSaturatedColor(color) {
        return getColorRange(color) >= 56;
      }

      function isNearWhiteSurface(color) {
        return color.a > 0.65 && getLuminance(color) >= 0.78 && isNeutralColor(color);
      }

      function isDarkReadableText(color) {
        return color.a > 0.65 && getLuminance(color) <= 0.42;
      }

      function hasOpaqueBackground(computedStyle) {
        return Boolean(parseColor(computedStyle.backgroundColor));
      }

      function hasTransformedSurfaceAncestor(element) {
        var current = element;

        while (current && current !== document.documentElement) {
          if (current.getAttribute && current.getAttribute('data-nativemail-dark-surface') === '1') {
            return true;
          }

          current = current.parentElement;
        }

        return false;
      }

      function setImportantStyle(element, property, value) {
        element.style.setProperty(property, value, 'important');
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function rgbToHsl(color) {
        var r = color.r / 255;
        var g = color.g / 255;
        var b = color.b / 255;
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var h = 0;
        var s = 0;
        var l = (max + min) / 2;
        var delta = max - min;

        if (delta) {
          s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

          if (max === r) {
            h = (g - b) / delta + (g < b ? 6 : 0);
          } else if (max === g) {
            h = (b - r) / delta + 2;
          } else {
            h = (r - g) / delta + 4;
          }

          h /= 6;
        }

        return { h: h, l: l, s: s };
      }

      function hslToRgb(hsl) {
        function hueToRgb(p, q, t) {
          if (t < 0) {
            t += 1;
          }

          if (t > 1) {
            t -= 1;
          }

          if (t < 1 / 6) {
            return p + (q - p) * 6 * t;
          }

          if (t < 1 / 2) {
            return q;
          }

          if (t < 2 / 3) {
            return p + (q - p) * (2 / 3 - t) * 6;
          }

          return p;
        }

        if (!hsl.s) {
          var gray = Math.round(hsl.l * 255);

          return { r: gray, g: gray, b: gray, a: 1 };
        }

        var q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
        var p = 2 * hsl.l - q;

        return {
          a: 1,
          b: Math.round(hueToRgb(p, q, hsl.h - 1 / 3) * 255),
          g: Math.round(hueToRgb(p, q, hsl.h) * 255),
          r: Math.round(hueToRgb(p, q, hsl.h + 1 / 3) * 255)
        };
      }

      function toRgbString(color) {
        return 'rgb(' + Math.round(color.r) + ', ' + Math.round(color.g) + ', ' + Math.round(color.b) + ')';
      }

      function getReadableAccentColor(color) {
        var hsl = rgbToHsl(color);
        var nextColor = hslToRgb({
          h: hsl.h,
          l: clamp(Math.max(hsl.l, 0.64), 0.64, 0.76),
          s: clamp(Math.max(hsl.s, 0.55), 0.55, 0.9)
        });

        return getContrastRatio(nextColor, darkSurfaceRgb) >= 4.5
          ? toRgbString(nextColor)
          : darkLinkColor;
      }

      function maybeTransformBorder(element, computedStyle, side) {
        var width = parseFloat(computedStyle.getPropertyValue('border-' + side + '-width') || '0');

        if (!width) {
          return;
        }

        var color = parseColor(computedStyle.getPropertyValue('border-' + side + '-color'));

        if (color && isNearWhiteSurface(color)) {
          setImportantStyle(element, 'border-' + side + '-color', darkBorderColor);
          darkModeDebug.borderCount += 1;
        }
      }

      function applyDarkModeTransform() {
        if (!darkMode || !document.body || document.body.__nativemailDarkModeApplied) {
          return;
        }

        document.body.__nativemailDarkModeApplied = true;
        document.documentElement.style.setProperty('color-scheme', 'dark', 'important');
        document.documentElement.style.setProperty('background-color', darkSurfaceColor, 'important');
        document.body.style.setProperty('background-color', darkSurfaceColor, 'important');
        document.body.style.setProperty('color', darkTextColor, 'important');
        document.body.setAttribute('data-nativemail-dark-surface', '1');

        var elements = Array.prototype.slice.call(document.body.querySelectorAll(
          'body, table, tbody, thead, tfoot, tr, td, th, div, p, section, article, main, header, footer, center, span, font, blockquote, ul, ol, li, h1, h2, h3, h4, h5, h6, a'
        ));

        elements.unshift(document.body);

        elements.forEach(function (element) {
          var tagName = element.tagName ? element.tagName.toLowerCase() : '';

          if (tagName === 'img' || tagName === 'svg' || tagName === 'picture') {
            return;
          }

          var computedStyle = window.getComputedStyle(element);
          var background = parseColor(computedStyle.backgroundColor);
          var hasBackgroundImage = computedStyle.backgroundImage && computedStyle.backgroundImage !== 'none';
          var transformedSurface = false;

          if (background && isNearWhiteSurface(background)) {
            if (hasBackgroundImage) {
              darkModeDebug.skippedBackgroundImageCount += 1;
            } else {
              setImportantStyle(element, 'background-color', darkSurfaceColor);
              element.setAttribute('data-nativemail-dark-surface', '1');
              transformedSurface = true;
              darkModeDebug.backgroundCount += 1;
            }
          } else if (background && getLuminance(background) >= 0.56 && !isNeutralColor(background)) {
            darkModeDebug.skippedColoredBackgroundCount += 1;
          }

          maybeTransformBorder(element, computedStyle, 'top');
          maybeTransformBorder(element, computedStyle, 'right');
          maybeTransformBorder(element, computedStyle, 'bottom');
          maybeTransformBorder(element, computedStyle, 'left');

          var textColor = parseColor(computedStyle.color);
          var hasSurface = transformedSurface || hasTransformedSurfaceAncestor(element);
          var hasOwnNonTransformedBackground =
            hasOpaqueBackground(computedStyle) &&
            !transformedSurface &&
            element.getAttribute('data-nativemail-dark-surface') !== '1';

          if (!textColor || !hasSurface || hasOwnNonTransformedBackground) {
            return;
          }

          if (tagName === 'a') {
            if (getContrastRatio(textColor, darkSurfaceRgb) < 4.5) {
              var hasInlineLinkColor = Boolean(element.style && element.style.color);
              var nextLinkColor = hasInlineLinkColor && isSaturatedColor(textColor)
                ? getReadableAccentColor(textColor)
                : darkLinkColor;

              setImportantStyle(element, 'color', nextLinkColor);
              setImportantStyle(element, 'text-decoration-color', nextLinkColor);
              darkModeDebug.linkCount += 1;
            }

            return;
          }

          if (!isNeutralColor(textColor) && isSaturatedColor(textColor) && getContrastRatio(textColor, darkSurfaceRgb) < 4.5) {
            setImportantStyle(element, 'color', getReadableAccentColor(textColor));
            darkModeDebug.accentTextCount += 1;
          } else if (isDarkReadableText(textColor) || getContrastRatio(textColor, darkSurfaceRgb) < 4.5) {
            setImportantStyle(element, 'color', darkTextColor);
            darkModeDebug.textCount += 1;
          } else if (isNeutralColor(textColor) && getContrastRatio(textColor, darkSurfaceRgb) < 7) {
            setImportantStyle(element, 'color', darkSecondaryTextColor);
            darkModeDebug.textCount += 1;
          }
        });

        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'dark-mode-debug',
          darkModeDebug: darkModeDebug
        }));
      }

      function getImageDebug(phase) {
        var images = Array.prototype.slice.call(document.images || []);

        return {
          phase: phase,
          imageCount: images.length,
          images: images.map(function (image) {
            var rect = image.getBoundingClientRect();
            var parent = image.parentElement;
            var parentRect = parent ? parent.getBoundingClientRect() : null;

            return {
              complete: Boolean(image.complete),
              currentSrcHost: getHost(image.currentSrc || ''),
              heightAttr: image.getAttribute('height') || '',
              naturalHeight: image.naturalHeight || 0,
              naturalWidth: image.naturalWidth || 0,
              parentTag: parent ? parent.tagName.toLowerCase() : '',
              parentWidth: parentRect ? Math.round(parentRect.width) : 0,
              renderedHeight: Math.round(rect.height),
              renderedWidth: Math.round(rect.width),
              srcHost: getHost(image.getAttribute('src') || image.src || ''),
              srcPrefix: (image.getAttribute('src') || image.src || '').slice(0, 160),
              status: image.getAttribute('data-nativemail-image-status') || 'snapshot',
              widthAttr: image.getAttribute('width') || ''
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

      applyDarkModeTransform();
      attachImageDebug();
      postImageDebug('initial');
      postHeight();
      window.addEventListener('load', function () {
        applyDarkModeTransform();
        attachImageDebug();
        postImageDebug('window-load');
        postHeight();
      });
      window.addEventListener('resize', postHeight);
      setTimeout(function () {
        applyDarkModeTransform();
        attachImageDebug();
        postImageDebug('timer-50');
        postHeight();
      }, 50);
      setTimeout(function () {
        applyDarkModeTransform();
        attachImageDebug();
        postImageDebug('timer-250');
        postHeight();
      }, 250);
      setTimeout(function () {
        applyDarkModeTransform();
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
      max-width: 100%;
    }
    img[width][height] {
      max-width: none;
    }
    pre, code {
      white-space: pre-wrap;
    }
    .nativemail-outside-body {
      font: inherit;
      margin: 16px 0 0;
      white-space: pre-wrap;
    }
  `;
}

function getEmailHtmlParts(html: string) {
  const sanitized = sanitizeEmailHtml(html);
  const head = getCombinedHeadHtml(sanitized);
  const bodyMatches = Array.from(sanitized.matchAll(/<body\b([^>]*)>([\s\S]*?)<\/body>/gi));

  if (bodyMatches.length) {
    const bodyAttributes = bodyMatches[0]?.[1] ?? '';
    const bodyHtml = bodyMatches.map((match) => match[2] ?? '').join('\n');
    const trailingHtml = getTrailingHtmlAfterLastBody(sanitized, bodyMatches);
    const body = trailingHtml ? `${bodyHtml}\n${trailingHtml}` : bodyHtml;

    return {
      body,
      bodyAttributes: sanitizeEmailBodyAttributes(bodyAttributes),
      hasBodyMarginAttributes: bodyMatches.some((match) => hasEmailBodyMarginAttributes(match[1] ?? '')),
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

function getCombinedHeadHtml(html: string) {
  return Array.from(html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head>/gi))
    .map((match) => match[1] ?? '')
    .join('\n');
}

function getTrailingHtmlAfterLastBody(html: string, bodyMatches: RegExpMatchArray[]) {
  const lastBodyMatch = bodyMatches[bodyMatches.length - 1];
  const trailingText = html
    .slice((lastBodyMatch.index ?? 0) + lastBodyMatch[0].length)
    .replace(/<\/?html\b[^>]*>/gi, '')
    .trim();

  if (!trailingText) {
    return '';
  }

  if (/<[a-z][\s\S]*>/i.test(trailingText)) {
    return trailingText;
  }

  return `<pre class="nativemail-outside-body">${escapeHtml(trailingText)}</pre>`;
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

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
