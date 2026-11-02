import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

private let bookmarkKey = "inklot.phoneInboxFolder"
private func folderError(_ message: String) -> NSError {
  NSError(domain: "InklotPhoneFolder", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
private final class FolderPicker: NSObject, UIDocumentPickerDelegate {
  let complete: (Result<Bool, Error>) -> Void
  init(complete: @escaping (Result<Bool, Error>) -> Void) { self.complete = complete }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { complete(.success(false)) }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first, url.startAccessingSecurityScopedResource() else {
      complete(.failure(folderError("The selected folder could not be accessed."))); return
    }
    defer { url.stopAccessingSecurityScopedResource() }
    do {
      let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
      complete(.success(true))
    } catch { complete(.failure(error)) }
  }
}

public final class PhoneFolderModule: Module {
  private var picker: FolderPicker?
  public func definition() -> ModuleDefinition {
    Name("InklotPhoneFolder")
    Function("deviceName") { UIDevice.current.name }
    Function("configured") { UserDefaults.standard.data(forKey: bookmarkKey) != nil }
    AsyncFunction("pick") { (promise: Promise) in
      guard self.picker == nil else { promise.reject(folderError("A folder picker is already open.")); return }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject(folderError("Open Cold Open before choosing a folder.")); return
      }
      let delegate = FolderPicker { result in
        self.picker = nil
        switch result {
        case .success(let chosen): promise.resolve(chosen)
        case .failure(let error): promise.reject(error)
        }
      }
      self.picker = delegate
      let controller = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      controller.delegate = delegate
      controller.allowsMultipleSelection = false
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)
    AsyncFunction("read") { (deviceId: String) -> String? in
      guard let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
      var stale = false
      let root = try URL(resolvingBookmarkData: bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
      guard root.startAccessingSecurityScopedResource() else { throw folderError("Choose the folder again.") }
      defer { root.stopAccessingSecurityScopedResource() }
      var coordinationError: NSError?
      var result: String?
      var readError: Error?
      NSFileCoordinator().coordinate(readingItemAt: root, options: [], error: &coordinationError) { coordinated in
        do { result = try PhoneFolderStorage.read(root: coordinated, deviceId: deviceId) }
        catch { readError = error }
      }
      if let error = coordinationError { throw error }
      if let error = readError { throw error }
      return result
    }
    AsyncFunction("write") { (deviceId: String, receiptId: String, json: String) in
      try self.write(deviceId: deviceId, receiptId: receiptId, json: json)
    }
  }
  private func write(deviceId: String, receiptId: String, json: String) throws {
    let pattern = #"^[-A-Za-z0-9_]{12,80}$"#
    guard deviceId.range(of: pattern, options: .regularExpression) != nil,
          receiptId.range(of: pattern, options: .regularExpression) != nil,
          let bytes = json.data(using: .utf8), bytes.count <= 26000,
          let bookmark = UserDefaults.standard.data(forKey: bookmarkKey) else {
      throw folderError("Choose an iCloud Drive folder before saving offline items.")
    }
    var stale = false
    let root = try URL(resolvingBookmarkData: bookmark, options: .withoutUI, relativeTo: nil, bookmarkDataIsStale: &stale)
    guard root.startAccessingSecurityScopedResource() else {
      throw folderError("Folder access expired. Choose the iCloud Drive folder again.")
    }
    defer { root.stopAccessingSecurityScopedResource() }
    if stale {
      UserDefaults.standard.set(try root.bookmarkData(options: .minimalBookmark,
        includingResourceValuesForKeys: nil, relativeTo: nil), forKey: bookmarkKey)
    }
    var coordinationError: NSError?
    var writeError: Error?
    NSFileCoordinator().coordinate(writingItemAt: root, options: .forMerging, error: &coordinationError) { coordinated in
      do { try PhoneFolderStorage.write(root: coordinated, deviceId: deviceId, receiptId: receiptId, json: json) }
      catch { writeError = error }
    }
    if let error = coordinationError { throw error }
    if let error = writeError { throw error }
  }
}
