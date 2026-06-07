import { GradientAvatar } from '@/components/gradient-avatar';
import { Image as ExpoImage } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

const failedAvatarUrls = new Set<string>();

type ProfileAvatarProps = {
  avatarUrl?: string;
  color: string;
  label?: string;
  size: number;
  style?: StyleProp<ViewStyle>;
  textSize?: number;
  textStyle?: StyleProp<TextStyle>;
};

export function ProfileAvatar({
  avatarUrl,
  color,
  label,
  size,
  style,
  textSize,
  textStyle,
}: ProfileAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const failed = Boolean(avatarUrl && (failedAvatarUrls.has(avatarUrl) || failedUrl === avatarUrl));
  const loaded = Boolean(avatarUrl && loadedUrl === avatarUrl && !failed);

  return (
    <View style={[styles.container, { borderRadius: size / 2, height: size, width: size }, style]}>
      <GradientAvatar
        color={color}
        label={label}
        size={size}
        style={StyleSheet.absoluteFill}
        textSize={textSize}
        textStyle={textStyle}
      />
      {avatarUrl && !failed ? (
        <>
          <View style={[styles.imageBackground, { opacity: loaded ? 1 : 0 }]} />
          <ExpoImage
            cachePolicy="memory-disk"
            contentFit="cover"
            onError={() => {
              failedAvatarUrls.add(avatarUrl);
              setFailedUrl(avatarUrl);
              setLoadedUrl(null);
            }}
            onLoad={() => setLoadedUrl(avatarUrl)}
            recyclingKey={avatarUrl}
            source={getAvatarImageSource(avatarUrl)}
            style={[styles.image, { opacity: loaded ? 1 : 0 }]}
            transition={80}
          />
        </>
      ) : null}
    </View>
  );
}

function getAvatarImageSource(avatarUrl: string) {
  const headers = getAvatarRequestHeaders(avatarUrl);

  return headers ? { headers, uri: avatarUrl } : { uri: avatarUrl };
}

function getAvatarRequestHeaders(avatarUrl: string) {
  try {
    if (new URL(avatarUrl).hostname === 'www.fastmailcdn.com') {
      return { Origin: 'https://app.fastmail.com' };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  imageBackground: {
    backgroundColor: '#FFFFFF',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  image: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
