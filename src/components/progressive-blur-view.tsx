import { requireNativeView } from 'expo';
import { ViewProps } from 'react-native';

export type ProgressiveBlurDirection = 'blurredTopClearBottom' | 'blurredBottomClearTop';

export type ProgressiveBlurViewProps = ViewProps & {
  maxBlurRadius?: number;
  startOffset?: number;
  direction?: ProgressiveBlurDirection;
  tintColor?: string;
};

const NativeProgressiveBlurView = requireNativeView<ProgressiveBlurViewProps>('ProgressiveBlurView');

export function ProgressiveBlurView({
  direction = 'blurredTopClearBottom',
  maxBlurRadius = 18,
  startOffset = -0.06,
  style,
  tintColor = 'transparent',
  ...rest
}: ProgressiveBlurViewProps) {
  return (
    <NativeProgressiveBlurView
      {...rest}
      direction={direction}
      maxBlurRadius={maxBlurRadius}
      startOffset={startOffset}
      style={style}
      tintColor={tintColor}
    />
  );
}
