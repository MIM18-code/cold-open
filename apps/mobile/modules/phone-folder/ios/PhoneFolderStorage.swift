import Darwin
import Foundation

private func storageError(_ message: String) -> NSError {
  NSError(domain: "InklotPhoneFolder", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

enum PhoneFolderStorage {
  private static func directory(_ url: URL) throws {
    var info = stat()
    if lstat(url.path, &info) != 0 {
      guard errno == ENOENT else { throw storageError("Cannot inspect the inbox folder.") }
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
      guard lstat(url.path, &info) == 0 else { throw storageError("Cannot inspect the new inbox folder.") }
    }
    guard info.st_mode & S_IFMT == S_IFDIR else { throw storageError("The inbox folder is a link or special file.") }
  }
  static func read(root: URL, deviceId: String) throws -> String? {
    guard deviceId.range(of: #"^[-A-Za-z0-9_]{12,80}$"#, options: .regularExpression) != nil else {
      throw storageError("Invalid phone identity.")
    }
    let inbox = root.appendingPathComponent("Inklot Phone Inbox")
    let device = inbox.appendingPathComponent(deviceId)
    try directory(root); try directory(inbox); try directory(device)
    let path = device.appendingPathComponent("production.json")
    let fd = open(path.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if fd < 0 { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 2_000_000 else {
      throw storageError("Invalid production snapshot.")
    }
    var bytes = [UInt8](repeating: 0, count: Int(info.st_size) + 1)
    let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    guard count >= 0, count <= 2_000_000 else { throw storageError("Cannot read production snapshot.") }
    return String(bytes: bytes.prefix(count), encoding: .utf8)
  }
  static func write(root: URL, deviceId: String, receiptId: String, json: String) throws {
    let pattern = #"^[-A-Za-z0-9_]{12,80}$"#
    guard deviceId.range(of: pattern, options: .regularExpression) != nil,
          receiptId.range(of: pattern, options: .regularExpression) != nil,
          let bytes = json.data(using: .utf8), bytes.count <= 26000 else {
      throw storageError("Invalid offline inbox item.")
    }
    try directory(root)
    // Shared with the Mac app and already in writers' iCloud; keeps the old app name.
    let inbox = root.appendingPathComponent("Inklot Phone Inbox", isDirectory: true)
    try directory(inbox)
    let device = inbox.appendingPathComponent(deviceId, isDirectory: true)
    try directory(device)
    let destination = device.appendingPathComponent(receiptId + ".json")
    let temp = device.appendingPathComponent("." + UUID().uuidString + ".tmp")
    let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw storageError("Could not create the offline item.") }
    defer { close(fd); try? FileManager.default.removeItem(at: temp) }
    try bytes.withUnsafeBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        guard count > 0 else { throw storageError("Could not save the offline item.") }
        offset += count
      }
    }
    guard fsync(fd) == 0, rename(temp.path, destination.path) == 0 else {
      throw storageError("Could not finish saving the offline item.")
    }
  }
}
