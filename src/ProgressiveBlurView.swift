internal import ExpoModulesCore
import CoreImage.CIFilterBuiltins
import QuartzCore
import UIKit

class ProgressiveBlurView: Module {
  public func definition() -> ModuleDefinition {
    View(ExpoProgressiveBlurView.self) {
      Prop("maxBlurRadius") { (view, radius: CGFloat?) in
        view.maxBlurRadius = radius ?? 18
      }

      Prop("direction") { (view, direction: String?) in
        view.direction = direction == "blurredBottomClearTop" ? .blurredBottomClearTop : .blurredTopClearBottom
      }

      Prop("startOffset") { (view, startOffset: CGFloat?) in
        view.startOffset = startOffset ?? -0.06
      }

      Prop("tintColor") { (view, tintColor: UIColor?) in
        view.tintColorOverlay = tintColor ?? .clear
      }
    }
  }
}

final class ExpoProgressiveBlurView: ExpoView {
  var maxBlurRadius: CGFloat = 18 {
    didSet { rebuildBlurViewIfNeeded(oldValue != maxBlurRadius) }
  }

  var direction: VariableBlurDirection = .blurredTopClearBottom {
    didSet { rebuildBlurViewIfNeeded(oldValue != direction) }
  }

  var startOffset: CGFloat = -0.06 {
    didSet { rebuildBlurViewIfNeeded(oldValue != startOffset) }
  }

  var tintColorOverlay: UIColor = .clear {
    didSet { tintView.backgroundColor = tintColorOverlay }
  }

  private let tintView = UIView()
  private var blurView: VariableBlurUIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    isUserInteractionEnabled = false

    tintView.isUserInteractionEnabled = false
    tintView.backgroundColor = tintColorOverlay

    rebuildBlurView()
    addSubview(tintView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    blurView?.frame = bounds
    tintView.frame = bounds
  }

  private func rebuildBlurViewIfNeeded(_ shouldRebuild: Bool) {
    guard shouldRebuild else {
      return
    }

    rebuildBlurView()
  }

  private func rebuildBlurView() {
    blurView?.removeFromSuperview()

    let nextBlurView = VariableBlurUIView(
      maxBlurRadius: maxBlurRadius,
      direction: direction,
      startOffset: startOffset
    )
    nextBlurView.frame = bounds
    nextBlurView.isUserInteractionEnabled = false

    insertSubview(nextBlurView, at: 0)
    blurView = nextBlurView
  }
}

enum VariableBlurDirection: Equatable {
  case blurredTopClearBottom
  case blurredBottomClearTop
}

/// Adapted from nikstar/VariableBlur, MIT licensed.
/// Original: https://github.com/nikstar/VariableBlur
final class VariableBlurUIView: UIVisualEffectView {
  init(
    maxBlurRadius: CGFloat = 18,
    direction: VariableBlurDirection = .blurredTopClearBottom,
    startOffset: CGFloat = -0.06
  ) {
    super.init(effect: UIBlurEffect(style: .regular))

    let className = String("retliFAC".reversed())
    guard let filterClass = NSClassFromString(className) as? NSObject.Type else {
      print("[ProgressiveBlurView] Error: Can't find filter class")
      return
    }

    let selectorName = String(":epyThtiWretlif".reversed())
    guard let variableBlur = filterClass
      .perform(NSSelectorFromString(selectorName), with: "variableBlur")?
      .takeUnretainedValue() as? NSObject else {
      print("[ProgressiveBlurView] Error: Can't create variable blur filter")
      return
    }

    variableBlur.setValue(maxBlurRadius, forKey: "inputRadius")
    variableBlur.setValue(makeGradientImage(startOffset: startOffset, direction: direction), forKey: "inputMaskImage")
    variableBlur.setValue(true, forKey: "inputNormalizeEdges")

    let backdropLayer = subviews.first?.layer
    backdropLayer?.filters = [variableBlur]

    for subview in subviews.dropFirst() {
      subview.alpha = 0
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func didMoveToWindow() {
    guard let window, let backdropLayer = subviews.first?.layer else {
      return
    }

    backdropLayer.setValue(window.traitCollection.displayScale, forKey: "scale")
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    // Calling super can reactivate the stock visual-effect subviews and create a hard edge.
  }

  private func makeGradientImage(
    width: CGFloat = 100,
    height: CGFloat = 100,
    startOffset: CGFloat,
    direction: VariableBlurDirection
  ) -> CGImage {
    let gradient = CIFilter.linearGradient()
    gradient.color0 = CIColor.black
    gradient.color1 = CIColor.clear
    gradient.point0 = CGPoint(x: 0, y: height)
    gradient.point1 = CGPoint(x: 0, y: startOffset * height)

    if direction == .blurredBottomClearTop {
      gradient.point0.y = 0
      gradient.point1.y = height - gradient.point1.y
    }

    return CIContext().createCGImage(
      gradient.outputImage!,
      from: CGRect(x: 0, y: 0, width: width, height: height)
    )!
  }
}
