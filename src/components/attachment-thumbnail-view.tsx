import { requireNativeView, requireOptionalNativeModule } from 'expo';
import { Platform, View, type ViewProps } from 'react-native';
import type { ComponentType } from 'react';

export type AttachmentThumbnailViewProps = ViewProps & {
  contentType?: string;
  dataUrl?: string;
  fileName?: string;
};

let NativeAttachmentThumbnailView: ComponentType<AttachmentThumbnailViewProps> | null = null;
const NativeAttachmentThumbnailModule =
  requireOptionalNativeModule<{
    openAsync: (dataUrl: string, fileName?: string, contentType?: string) => Promise<void>;
  }>('AttachmentThumbnailView');

try {
  NativeAttachmentThumbnailView = requireNativeView<AttachmentThumbnailViewProps>('AttachmentThumbnailView');
} catch {
  NativeAttachmentThumbnailView = null;
}

export const canUseNativeAttachmentThumbnail =
  Platform.OS === 'ios' && NativeAttachmentThumbnailView !== null;
export const canOpenNativeAttachmentPreview =
  Platform.OS === 'ios' && NativeAttachmentThumbnailModule !== null;

export function AttachmentThumbnailView(props: AttachmentThumbnailViewProps) {
  if (!NativeAttachmentThumbnailView || Platform.OS !== 'ios') {
    return <View style={props.style} />;
  }

  return <NativeAttachmentThumbnailView {...props} />;
}

export async function openNativeAttachmentPreviewAsync({
  contentType,
  dataUrl,
  fileName,
}: {
  contentType?: string;
  dataUrl?: string;
  fileName?: string;
}) {
  if (!dataUrl || !NativeAttachmentThumbnailModule || Platform.OS !== 'ios') {
    return false;
  }

  await NativeAttachmentThumbnailModule.openAsync(dataUrl, fileName, contentType);
  return true;
}
