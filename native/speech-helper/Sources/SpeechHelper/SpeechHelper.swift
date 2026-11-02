import Foundation

/// Command line and line-delimited JSON front end for the speech engines.
///
///     speech-helper engines
///     speech-helper download --engine parakeet|apple
///     speech-helper transcribe --engine parakeet [--whisper-model PATH] [--locale en-US] FILE...
///     speech-helper serve        (one JSON request per stdin line, one JSON reply per stdout line)
///
/// `serve` is what the Electron app talks to: it keeps each prepared engine
/// loaded, so only the first take pays the model load.
@main
struct SpeechHelper {
    static func main() async {
        var arguments = Array(CommandLine.arguments.dropFirst())
        guard !arguments.isEmpty else { usage() }
        let command = arguments.removeFirst()
        var options: [String: String] = [:]
        var files: [String] = []
        while !arguments.isEmpty {
            let argument = arguments.removeFirst()
            if argument.hasPrefix("--"), !arguments.isEmpty {
                options[String(argument.dropFirst(2))] = arguments.removeFirst()
            } else {
                files.append(argument)
            }
        }
        do {
            switch command {
            case "engines":
                emit(["engines": EngineKind.allCases.map(\.rawValue)])
            case "download":
                let engine = try kind(options).make(options: options)
                try await engine.prepare(allowDownload: true)
                emit(["event": "ready", "engine": engine.name])
            case "transcribe":
                let start = ContinuousClock.now
                let engine = try kind(options).make(options: options)
                try await engine.prepare(allowDownload: false)
                emit(["event": "loaded", "engine": engine.name, "loadMs": elapsedMs(since: start)])
                for file in files {
                    emit(try await engine.transcribe(file: URL(fileURLWithPath: file)))
                }
            case "serve":
                try await serve()
            default:
                usage()
            }
        } catch {
            emit(["error": error.localizedDescription])
            exit(1)
        }
    }

    static func kind(_ options: [String: String]) throws -> EngineKind {
        guard let kind = EngineKind(rawValue: options["engine"] ?? "parakeet") else {
            throw SpeechError.unavailable("Unknown engine. Use one of: "
                                          + EngineKind.allCases.map(\.rawValue).joined(separator: ", "))
        }
        return kind
    }

    struct Request: Decodable {
        let id: Int
        let op: String
        let engine: String?
        let path: String?
        let options: [String: String]?
    }

    static func serve() async throws {
        var engines: [String: SpeechEngine] = [:]
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(Request.self, from: data)
            else {
                emit(["ok": false, "error": "Malformed request."])
                continue
            }
            do {
                let options = request.options ?? [:]
                let kindName = request.engine ?? "parakeet"
                guard let kind = EngineKind(rawValue: kindName) else {
                    throw SpeechError.unavailable("Unknown engine \(kindName).")
                }
                // Options (locale, precision, model) are part of the engine's identity.
                let key = kindName + options.sorted { $0.key < $1.key }.map { "|\($0.key)=\($0.value)" }.joined()
                switch request.op {
                case "prepare":
                    let start = ContinuousClock.now
                    let engine = try engines[key] ?? kind.make(options: options)
                    try await engine.prepare(allowDownload: false)
                    engines[key] = engine
                    emit(["id": request.id, "ok": true, "loadMs": elapsedMs(since: start)])
                case "transcribe":
                    guard let engine = engines[key] else { throw SpeechError.failed("Prepare \(key) first.") }
                    guard let path = request.path else { throw SpeechError.failed("No audio path.") }
                    let transcript = try await engine.transcribe(file: URL(fileURLWithPath: path))
                    emitReply(id: request.id, transcript: transcript)
                case "release":
                    engines[key] = nil
                    emit(["id": request.id, "ok": true])
                default:
                    throw SpeechError.failed("Unknown op \(request.op).")
                }
            } catch {
                emit(["id": request.id, "ok": false, "error": error.localizedDescription])
            }
        }
    }

    static func emitReply(id: Int, transcript: Transcript) {
        struct Reply: Encodable { let id: Int; let ok = true; let result: Transcript }
        emit(Reply(id: id, result: transcript))
    }

    static func emit(_ value: some Encodable) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return }
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }

    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    }

    static func usage() -> Never {
        FileHandle.standardError.write(Data("usage: speech-helper engines | download --engine E | transcribe --engine E FILE... | serve\n".utf8))
        exit(2)
    }
}
