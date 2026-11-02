import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native folder writer atomically creates the picked-folder layout and refuses redirected folders", {
  skip: process.platform !== "darwin",
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "inklot-native-folder-"));
  try {
    const main = join(temp, "main.swift"), executable = join(temp, "test-folder");
    await writeFile(main, `import Foundation
func verify(_ value: Bool) { precondition(value) }
let fm = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("picked")
try fm.createDirectory(at: root, withIntermediateDirectories: false)
let device = "device-123456789", receipt = "receipt-123456789"
try PhoneFolderStorage.write(root: root, deviceId: device, receiptId: receipt, json: "{\\"text\\":\\"First\\"}")
let folder = root.appendingPathComponent("Inklot Phone Inbox/" + device)
let destination = folder.appendingPathComponent(receipt + ".json")
verify(try String(contentsOf: destination, encoding: .utf8) == "{\\"text\\":\\"First\\"}")
try PhoneFolderStorage.write(root: root, deviceId: device, receiptId: receipt, json: "{\\"text\\":\\"Retry\\"}")
verify(try String(contentsOf: destination, encoding: .utf8) == "{\\"text\\":\\"Retry\\"}")
verify(try fm.contentsOfDirectory(atPath: folder.path) == [receipt + ".json"])
let production = folder.appendingPathComponent("production.json")
try Data("snapshot".utf8).write(to: production)
verify(try PhoneFolderStorage.read(root: root, deviceId: device) == "snapshot")
try Data(repeating: 120, count: 2_000_000).write(to: production)
verify(try PhoneFolderStorage.read(root: root, deviceId: device)?.utf8.count == 2_000_000)
try Data(String(repeating: "字", count: 700_000).utf8).write(to: production)
do { _ = try PhoneFolderStorage.read(root: root, deviceId: device); fatalError("Oversize UTF-8 read succeeded") } catch {}
try fm.removeItem(at: production)
try fm.createSymbolicLink(at: production, withDestinationURL: destination)
verify(try PhoneFolderStorage.read(root: root, deviceId: device) == nil)
func refuses(_ work: () throws -> Void) { do { try work(); fatalError("Unsafe write succeeded") } catch {} }
refuses { try PhoneFolderStorage.write(root: root, deviceId: "../bad", receiptId: receipt, json: "{}") }
refuses { try PhoneFolderStorage.write(root: root, deviceId: device, receiptId: receipt, json: String(repeating: "字", count: 9000)) }
let outside = root.appendingPathComponent("outside")
try fm.createDirectory(at: outside, withIntermediateDirectories: false)
try fm.removeItem(at: folder)
try fm.createSymbolicLink(at: folder, withDestinationURL: outside)
refuses { try PhoneFolderStorage.write(root: root, deviceId: device, receiptId: receipt, json: "{}") }
verify(try fm.contentsOfDirectory(atPath: outside.path).isEmpty)
print("native folder writer passed")
`);
    execFileSync("swiftc", ["-module-cache-path", join(temp, "cache"), resolve(import.meta.dirname,
      "../modules/phone-folder/ios/PhoneFolderStorage.swift"), main, "-o", executable], { timeout: 60000 });
    assert.match(execFileSync(executable, [temp], { encoding: "utf8", timeout: 10000 }), /passed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
