import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });

type GradientAvatarProps = {
  color: string;
  label?: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  textSize?: number;
  textStyle?: StyleProp<TextStyle>;
};

export function GradientAvatar({
  color,
  label = '?',
  size,
  style,
  textSize,
  textStyle,
}: GradientAvatarProps) {
  const initials = label.trim().slice(0, 2) || '?';
  const fontSize = textSize ?? Math.round(size * (initials.length > 1 ? 0.38 : 0.52));

  return (
    <LinearGradient
      colors={avatarGradient(color)}
      end={{ x: 1, y: 1 }}
      start={{ x: 0.12, y: 0 }}
      style={[styles.avatar, { borderRadius: size / 2, height: size, width: size }, style]}>
      <Text
        maxFontSizeMultiplier={1.12}
        style={[styles.initials, { fontSize, height: size, lineHeight: size, width: size }, textStyle]}>
        {initials}
      </Text>
    </LinearGradient>
  );
}

export function avatarGradient(color: string): [string, string, string] {
  return [
    mixHex(color, '#FFFFFF', 0.26),
    color,
    mixHex(color, '#000000', 0.16),
  ];
}

function mixHex(color: string, target: string, amount: number) {
  const sourceRgb = parseHex(color);
  const targetRgb = parseHex(target);

  if (!sourceRgb || !targetRgb) {
    return color;
  }

  const mixed = sourceRgb.map((component, index) => {
    return Math.round(component + (targetRgb[index] - component) * amount);
  });

  return `#${mixed.map((component) => component.toString(16).padStart(2, '0')).join('')}`;
}

function parseHex(color: string) {
  const hex = color.replace('#', '');

  if (!/^[\da-f]{6}$/i.test(hex)) {
    return null;
  }

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: {
    color: '#FFFFFF',
    fontFamily: roundedFont,
    fontWeight: '600',
    includeFontPadding: false,
    textAlign: 'center',
    textAlignVertical: 'center',
  },
});
