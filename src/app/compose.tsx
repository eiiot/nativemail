import { GradientAvatar } from '@/components/gradient-avatar';
import { getComposeDraft } from '@/lib/compose-drafts';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { MenuView, type MenuAction, type NativeActionEvent } from '@expo/ui/community/menu';
import { PropsWithChildren, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type ViewStyle,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

const tint = '#0A84FF';
const textScale = { maxFontSizeMultiplier: 1.12 };
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const defaultBody = '\nEliot';
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
const composeMenuActions: MenuAction[] = [
  { id: 'signature', title: 'Change signature', image: 'signature' },
  { id: 'attach', title: 'Attach files...', image: 'paperclip' },
  {
    id: 'insert-image',
    title: 'Insert image...',
    image: 'photo',
    subactions: [
      { id: 'photo-library', title: 'Photo Library', image: 'photo.on.rectangle' },
      { id: 'camera', title: 'Take Photo', image: 'camera' },
    ],
  },
  { id: 'tracking', title: 'Enable tracking', image: 'star' },
  { id: 'labels', title: 'Labels', image: 'tag' },
];

export default function ComposeScreen() {
  const params = useLocalSearchParams<{
    body?: string;
    draftId?: string;
    mode?: string;
    subject?: string;
    to?: string;
  }>();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const draft = getComposeDraft(getComposeParam(params.draftId));
  const initialTo = draft?.to ?? getComposeParam(params.to);
  const initialSubject = draft?.subject ?? getComposeParam(params.subject);
  const initialBody = (draft?.body ?? getComposeParam(params.body)) || defaultBody;
  const initialHtmlBody = draft?.htmlBody ?? getHtmlBodyFromPlainText(initialBody);
  const startsWithRecipient = initialTo.trim().length > 0;
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [recipientsExpanded, setRecipientsExpanded] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [htmlBody, setHtmlBody] = useState(initialHtmlBody);
  const canSend = to.trim().length > 0 && (body.trim().length > 0 || htmlBody.trim().length > 0);
  const close = () => {
    pressHaptic();
    router.back();
  };
  const tapAccessory = () => {
    pressHaptic();
  };
  const handleMenuAction = (_event: NativeActionEvent) => {
    pressHaptic();
  };
  const send = () => {
    pressHaptic();
  };
  const toggleRecipients = () => {
    pressHaptic();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRecipientsExpanded((expanded) => !expanded);
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.background,
          paddingBottom: Math.max(12, insets.bottom),
        },
      ]}>
      <View style={styles.toolbar}>
        <View style={styles.leadingControls}>
          <GlassSurface colors={colors} style={styles.circleButton}>
            <Pressable accessibilityRole="button" onPress={close} style={styles.buttonContent}>
              <SymbolView name="xmark" tintColor={colors.text} size={20} weight="regular" />
            </Pressable>
          </GlassSurface>

          <GlassSurface colors={colors} style={styles.formatGroup}>
            <View style={styles.formatGroupContent}>
              <Pressable accessibilityRole="button" onPress={tapAccessory} style={styles.formatSegment}>
                <Text {...textScale} style={[styles.formatText, { color: colors.text }]}>Aa</Text>
              </Pressable>
              <View style={[styles.formatDivider, { backgroundColor: colors.groupDivider }]} />
              <MenuView
                actions={composeMenuActions}
                onPressAction={handleMenuAction}
                style={styles.menuHost}>
                <View style={styles.formatSegment}>
                  <SymbolView name="ellipsis" tintColor={colors.text} size={19} weight="bold" />
                </View>
              </MenuView>
            </View>
          </GlassSurface>
        </View>

        <GlassSurface colors={colors} style={styles.circleButton}>
          <Pressable accessibilityRole="button" onPress={send} style={styles.buttonContent}>
            <SymbolView
              name="paperplane.fill"
              tintColor={canSend ? tint : colors.disabledIcon}
              size={20}
              weight="regular"
            />
          </Pressable>
        </GlassSurface>
      </View>

      <View style={styles.fields}>
        <View style={[styles.fieldRow, { borderBottomColor: colors.separator }]}>
          <SingleLineComposeField
            autoFocus={!startsWithRecipient}
            autoCapitalize="none"
            autoCorrect={false}
            colors={colors}
            inputMode="email"
            keyboardType="email-address"
            label="To:"
            onChangeText={setTo}
            value={to}
          />
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={toggleRecipients}
            style={styles.recipientToggle}>
            <SymbolView
              name={recipientsExpanded ? 'chevron.up.circle' : 'chevron.down.circle'}
              tintColor={tint}
              size={23}
              weight="medium"
            />
          </Pressable>
        </View>

        {recipientsExpanded ? (
          <>
            <View style={[styles.fieldRow, { borderBottomColor: colors.separator }]}>
              <SingleLineComposeField
                autoCapitalize="none"
                autoCorrect={false}
                colors={colors}
                inputMode="email"
                keyboardType="email-address"
                label="Cc:"
                onChangeText={setCc}
                value={cc}
              />
            </View>

            <View style={[styles.fieldRow, { borderBottomColor: colors.separator }]}>
              <SingleLineComposeField
                autoCapitalize="none"
                autoCorrect={false}
                colors={colors}
                inputMode="email"
                keyboardType="email-address"
                label="Bcc:"
                onChangeText={setBcc}
                value={bcc}
              />
            </View>
          </>
        ) : null}

        <View style={[styles.fieldRow, { borderBottomColor: colors.separator }]}>
          <Text {...textScale} style={[styles.fieldLabel, { color: colors.text }]}>From:</Text>
          <GradientAvatar color="#164B8B" label="E" size={26} style={styles.fromAvatar} textSize={15} />
          <Text {...textScale} numberOfLines={1} style={[styles.fromText, { color: colors.text }]}>
            eliot.supceo@gmail.com
          </Text>
        </View>

        <View style={[styles.fieldRow, { borderBottomColor: colors.separator }]}>
          <SingleLineComposeField
            colors={colors}
            label="Subject:"
            onChangeText={setSubject}
            value={subject}
          />
        </View>

        <ComposeBodyEditor
          autoFocus={startsWithRecipient}
          colors={colors}
          initialHtml={initialHtmlBody}
          onChange={({ html, text }) => {
            setHtmlBody(html);
            setBody(text);
          }}
        />
      </View>
    </View>
  );
}

function getComposeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function ComposeBodyEditor({
  autoFocus,
  colors,
  initialHtml,
  onChange,
}: {
  autoFocus: boolean;
  colors: ColorSet;
  initialHtml: string;
  onChange: (value: { html: string; text: string }) => void;
}) {
  const editorDocument = useMemo(
    () => getComposeEditorDocument({ autoFocus, colors, initialHtml }),
    [autoFocus, colors.background, colors.secondaryText, colors.text, initialHtml],
  );
  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);

      if (
        payload &&
        payload.type === 'change' &&
        typeof payload.html === 'string' &&
        typeof payload.text === 'string'
      ) {
        onChange({ html: payload.html, text: payload.text });
      }
    } catch {
      // Ignore malformed editor messages.
    }
  };

  return (
    <WebView
      automaticallyAdjustContentInsets={false}
      bounces={false}
      hideKeyboardAccessoryView={false}
      keyboardDisplayRequiresUserAction={!autoFocus}
      onMessage={handleMessage}
      originWhitelist={['*']}
      scrollEnabled
      source={{ html: editorDocument }}
      style={[styles.bodyEditor, { backgroundColor: colors.background }]}
      textInteractionEnabled
    />
  );
}

function getComposeEditorDocument({
  autoFocus,
  colors,
  initialHtml,
}: {
  autoFocus: boolean;
  colors: ColorSet;
  initialHtml: string;
}) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    html,
    body {
      background: ${colors.background};
      color: ${colors.text};
      font: -apple-system-body;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 16px;
      line-height: 23px;
      margin: 0;
      min-height: 100%;
      padding: 0;
      -webkit-text-size-adjust: 100%;
    }

    #editor {
      box-sizing: border-box;
      min-height: 100vh;
      outline: none;
      padding: 20px 0 56px;
      white-space: normal;
      word-break: break-word;
    }

    #editor:empty::before {
      color: ${colors.secondaryText};
      content: attr(data-placeholder);
    }

    div {
      min-height: 23px;
    }

    blockquote {
      border-left: 2px solid ${colors.separator};
      color: ${colors.secondaryText};
      margin: 0 0 0 0.8em;
      padding-left: 0.8em;
    }

    a {
      color: ${tint};
    }
  </style>
</head>
<body>
  <div id="editor" contenteditable="true" data-placeholder="">${initialHtml}</div>
  <script>
    (function () {
      var editor = document.getElementById('editor');
      var postTimer = null;
      var shouldAutoFocus = ${autoFocus ? 'true' : 'false'};

      function postChange() {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'change',
          html: editor.innerHTML,
          text: editor.innerText || ''
        }));
      }

      function schedulePost() {
        clearTimeout(postTimer);
        postTimer = setTimeout(postChange, 80);
      }

      function focusAtStart() {
        editor.focus();
        var range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      editor.addEventListener('input', schedulePost);
      editor.addEventListener('blur', postChange);
      editor.addEventListener('paste', function () {
        setTimeout(postChange, 0);
      });

      setTimeout(function () {
        postChange();

        if (shouldAutoFocus) {
          focusAtStart();
        }
      }, 0);
    })();
  </script>
</body>
</html>`;
}

function getHtmlBodyFromPlainText(text: string) {
  const lines = text.split(/\r?\n/);

  return lines
    .map((line) => (line.length ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
    .join('');
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function SingleLineComposeField({
  autoCapitalize,
  autoCorrect,
  autoFocus,
  colors,
  inputMode,
  keyboardType,
  label,
  onChangeText,
  value,
}: {
  autoCapitalize?: 'none';
  autoCorrect?: boolean;
  autoFocus?: boolean;
  colors: ColorSet;
  inputMode?: 'email';
  keyboardType?: KeyboardTypeOptions;
  label: string;
  onChangeText: (value: string) => void;
  value: string;
}) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(autoFocus === true);
  const showInput = focused || value.length === 0;

  useEffect(() => {
    if (!focused) {
      return;
    }

    const focusTimeout = setTimeout(() => inputRef.current?.focus(), 0);

    return () => clearTimeout(focusTimeout);
  }, [focused]);

  return (
    <>
      <Text {...textScale} style={[styles.fieldLabel, { color: colors.text }]}>
        {label}
      </Text>
      {showInput ? (
        <TextInput
          ref={inputRef}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          autoFocus={autoFocus}
          inputMode={inputMode}
          keyboardType={keyboardType}
          maxFontSizeMultiplier={1.12}
          multiline={false}
          numberOfLines={1}
          onBlur={() => setFocused(false)}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          returnKeyType="next"
          scrollEnabled
          selectionColor={tint}
          style={[styles.fieldInput, { color: colors.text }]}
          value={value}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setFocused(true)}
          style={styles.fieldPreviewButton}>
          <Text
            {...textScale}
            ellipsizeMode="tail"
            numberOfLines={1}
            style={[styles.fieldPreviewText, { color: colors.text }]}>
            {value}
          </Text>
        </Pressable>
      )}
    </>
  );
}

function GlassSurface({
  children,
  colors,
  style,
}: PropsWithChildren<{
  colors: ColorSet;
  style?: StyleProp<ViewStyle>;
}>) {
  const canUseGlass = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

  if (canUseGlass) {
    return (
      <GlassView
        isInteractive
        tintColor={colors.glassTint}
        glassEffectStyle="regular"
        style={[styles.glassBase, style]}>
        {children}
      </GlassView>
    );
  }

  return (
    <View
      style={[
        styles.glassBase,
        {
          backgroundColor: colors.fallbackGlass,
          borderColor: colors.fallbackBorder,
          borderWidth: StyleSheet.hairlineWidth,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#FFFFFF',
  text: '#050505',
  separator: '#DCDCE1',
  disabledIcon: '#B8B8BE',
  groupDivider: 'rgba(60, 60, 67, 0.16)',
  glassTint: 'rgba(255, 255, 255, 0.64)',
  fallbackGlass: 'rgba(255, 255, 255, 0.88)',
  fallbackBorder: 'rgba(255, 255, 255, 0.68)',
  secondaryText: '#70707A',
};

const darkColors = {
  background: '#101012',
  text: '#F5F5F5',
  separator: '#2B2B2F',
  disabledIcon: '#5C5C62',
  groupDivider: 'rgba(235, 235, 245, 0.16)',
  glassTint: 'rgba(36, 36, 38, 0.64)',
  fallbackGlass: 'rgba(36, 36, 38, 0.88)',
  fallbackBorder: 'rgba(255, 255, 255, 0.1)',
  secondaryText: '#9A9AA2',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 16,
  },
  toolbar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
  },
  leadingControls: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  glassBase: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  circleButton: {
    borderRadius: 23,
    height: 46,
    width: 46,
  },
  buttonContent: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  formatGroup: {
    borderRadius: 23,
    height: 46,
    width: 94,
  },
  formatGroupContent: {
    alignItems: 'center',
    flexDirection: 'row',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  formatSegment: {
    alignItems: 'center',
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  formatDivider: {
    height: 24,
    width: StyleSheet.hairlineWidth,
  },
  menuHost: {
    height: 46,
    width: 46,
  },
  formatText: {
    fontFamily: systemFont,
    fontSize: 21,
    fontWeight: '500',
    lineHeight: 26,
  },
  fields: {
    flex: 1,
    paddingTop: 18,
  },
  fieldRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 50,
    overflow: 'hidden',
  },
  fieldLabel: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
    marginRight: 8,
  },
  fieldInput: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    height: 42,
    lineHeight: 21,
    minHeight: 42,
    overflow: 'hidden',
    padding: 0,
  },
  fieldPreviewButton: {
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    minWidth: 0,
  },
  fieldPreviewText: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
    minWidth: 0,
  },
  recipientToggle: {
    alignItems: 'center',
    height: 42,
    justifyContent: 'center',
    marginLeft: 8,
    width: 32,
  },
  fromAvatar: {
    borderRadius: 13,
    height: 26,
    marginRight: 9,
    width: 26,
  },
  fromText: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
    minWidth: 0,
  },
  bodyEditor: {
    backgroundColor: 'transparent',
    flex: 1,
  },
});
