internal import ExpoModulesCore
import QuickLook
import QuickLookThumbnailing
import UIKit

class AttachmentThumbnailView: Module {
  private var previewContext: AttachmentPreviewContext?

  public func definition() -> ModuleDefinition {
    AsyncFunction("openAsync") { (dataUrl: String, fileName: String?, contentType: String?, promise: Promise) in
      DispatchQueue.main.async {
        guard let currentViewController = self.appContext?.utilities?.currentViewController() else {
          promise.reject(AttachmentPreviewException("Could not find a view controller to present the attachment."))
          return
        }

        guard let fileUrl = writeAttachmentDataUrlToTemporaryFile(
          dataUrl,
          fileName: fileName,
          contentType: contentType
        ) else {
          promise.reject(AttachmentPreviewException("Could not prepare the attachment preview."))
          return
        }

        let previewController = QLPreviewController()
        let previewContext = AttachmentPreviewContext(fileUrl: fileUrl) { [weak self] in
          self?.previewContext = nil
        }
        self.previewContext = previewContext
        previewController.dataSource = previewContext
        previewController.delegate = previewContext
        currentViewController.present(previewController, animated: true) {
          promise.resolve(nil)
        }
      }
    }

    View(ExpoAttachmentThumbnailView.self) {
      Prop("contentType") { (view, contentType: String?) in
        view.contentType = contentType
      }

      Prop("dataUrl") { (view, dataUrl: String?) in
        view.dataUrl = dataUrl
      }

      Prop("fileName") { (view, fileName: String?) in
        view.fileName = fileName
      }
    }
  }
}

final class AttachmentPreviewContext: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let fileUrl: URL
  private let onDismiss: () -> Void

  init(fileUrl: URL, onDismiss: @escaping () -> Void) {
    self.fileUrl = fileUrl
    self.onDismiss = onDismiss
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    fileUrl as NSURL
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    try? FileManager.default.removeItem(at: fileUrl)
    onDismiss()
  }
}

final class AttachmentPreviewException: GenericException<String> {
  override var reason: String {
    param
  }
}

final class ExpoAttachmentThumbnailView: ExpoView {
  var contentType: String? {
    didSet { renderThumbnail() }
  }

  var dataUrl: String? {
    didSet { renderThumbnail() }
  }

  var fileName: String? {
    didSet { renderThumbnail() }
  }

  private let imageView = UIImageView()
  private var generation = 0
  private var renderedKey: String?
  private var temporaryFileUrl: URL?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = UIColor.systemGray6

    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.backgroundColor = UIColor.systemGray6
    addSubview(imageView)
  }

  deinit {
    removeTemporaryFile()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    renderThumbnail()
  }

  private func renderThumbnail() {
    let nextKey = [
      dataUrl ?? "",
      fileName ?? "",
      contentType ?? "",
      "\(Int(bounds.width))x\(Int(bounds.height))",
    ].joined(separator: "|")

    guard nextKey != renderedKey else {
      return
    }

    renderedKey = nextKey
    generation += 1
    let currentGeneration = generation

    guard bounds.width > 0, bounds.height > 0 else {
      return
    }

    removeTemporaryFile()

    guard let dataUrl, let fileUrl = writeAttachmentDataUrlToTemporaryFile(
      dataUrl,
      fileName: fileName,
      contentType: contentType
    ) else {
      imageView.image = nil
      return
    }

    temporaryFileUrl = fileUrl

    let request = QLThumbnailGenerator.Request(
      fileAt: fileUrl,
      size: bounds.size,
      scale: window?.screen.scale ?? UIScreen.main.scale,
      representationTypes: [.thumbnail, .icon]
    )

    QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] thumbnail, _ in
      DispatchQueue.main.async {
        guard let self, self.generation == currentGeneration else {
          return
        }

        self.imageView.image = thumbnail?.uiImage
      }
    }
  }

  private func removeTemporaryFile() {
    guard let temporaryFileUrl else {
      return
    }

    try? FileManager.default.removeItem(at: temporaryFileUrl)
    self.temporaryFileUrl = nil
  }
}

private func writeAttachmentDataUrlToTemporaryFile(
  _ dataUrl: String,
  fileName: String?,
  contentType: String?
) -> URL? {
  let parts = dataUrl.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)

  guard parts.count == 2, parts[0].contains(";base64") else {
    return nil
  }

  guard let data = Data(base64Encoded: String(parts[1])) else {
    return nil
  }

  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent(UUID().uuidString)
    .appendingPathExtension(attachmentFileExtension(fileName: fileName, contentType: contentType))

  do {
    try data.write(to: url, options: [.atomic])
    return url
  } catch {
    return nil
  }
}

private func attachmentFileExtension(fileName: String?, contentType: String?) -> String {
  if let fileName, let extensionStart = fileName.lastIndex(of: ".") {
    let ext = String(fileName[fileName.index(after: extensionStart)...])

    if !ext.isEmpty {
      return ext
    }
  }

  switch contentType?.lowercased() {
  case "application/pdf":
    return "pdf"
  case "image/jpeg":
    return "jpg"
  case "image/png":
    return "png"
  case "image/gif":
    return "gif"
  default:
    return "dat"
  }
}
