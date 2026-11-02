import Foundation
import Darwin
import FluidAudio
import MLXAudioTTS
import MLXAudioCore
import MLX

/// One serialized model process. The parent owns cancellation, lifetime and audio caching.
/// All engines load verified local assets supplied by the app. The parent denies network access.
@main
struct VoiceHelper {
    struct Request: Decodable {
        let id: Int
        let op: String
        let engine: String
        let text: String?
        let voice: String?
        let directory: String?
        let referencePath: String?
        let referenceText: String?
        let temperature: Float?
        let seed: UInt64?
        let speed: Float?
    }
    enum Failure: LocalizedError {
        case message(String)
        var errorDescription: String? { switch self { case .message(let text): return text } }
    }
    // Only published English presets; never invent names accepted merely by a regex.
    static let mingVoices = ["US_Emma", "UK_George", "UK_Charlotte"]
    // Kokoro voices that misread one- and two-word lines (for example "No." heard as "To know.") in a 10-line ASR check, word
    // error rate 0.6 or higher. Short-line padding and slower speech did not fix this, so these voices are not offered.
    static let kokoroWithheld: Set<String> = ["af_jessica", "af_river", "af_sarah", "am_eric", "am_onyx", "bf_alice", "bf_emma"]

    static func main() async {
        guard CommandLine.arguments.dropFirst().first == "serve" else { return }
        // Some inference dependencies print diagnostics. Keep stdout an unambiguous JSON protocol.
        let channel = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        fflush(stdout)
        dup2(STDERR_FILENO, STDOUT_FILENO)
        func emit(_ object: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
            channel.write(data + Data([10]))
        }
        // A pressure notification ends the worker even during a long native call.
        // The parent reloads the active model from disk for the next request.
        let pressure = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .global())
        pressure.setEventHandler { exit(75) }
        pressure.resume()
        defer { pressure.cancel() }
        // MLX keeps freed GPU buffers for reuse without bound by default. Cap that cache so a line's working set is returned afterwards.
        Memory.cacheLimit = 256 * 1024 * 1024
        var phonon: PocketTtsSmallManager?
        var kokoro: KokoroAneManager?
        var qwen: Qwen3TTSModel?
        var ming: MingDenseModel?
        var voices: [String] = []
        var loaded: String?
        while let line = readLine() {
            guard line.utf8.count <= 16_384, let data = line.data(using: .utf8),
                  let request = try? JSONDecoder().decode(Request.self, from: data) else {
                emit(["id": -1, "ok": false, "error": "Malformed voice request."]); continue
            }
            do {
                guard ["phonon", "ming", "kokoro", "qwen", "qwen-design"].contains(request.engine) else { throw Failure.message("Unknown voice engine.") }
                if request.op == "prepare" {
                    // Drop the other model before loading; avoid holding both on a small Mac.
                    phonon = nil; ming = nil; kokoro = nil; qwen = nil; loaded = nil; voices = []
                    Memory.clearCache()
                    guard let directory = request.directory, directory.hasPrefix("/") else {
                        throw Failure.message("A verified local model directory is required.")
                    }
                    let local = URL(fileURLWithPath: directory, isDirectory: true)
                    if request.engine == "phonon" {
                        let model = PocketTtsSmallManager(model: .phonon31m)
                        try await model.load(from: local)
                        voices = try await model.availableVoices().filter { $0.hasPrefix("en_") || $0.hasPrefix("characters_") || $0 == "default" }.sorted()
                        phonon = model
                    } else if request.engine == "kokoro" {
                        let ane = local.appendingPathComponent("kokoro-82m-coreml/ANE")
                        let source = local.appendingPathComponent("kokoro/voices")
                        let jsonFiles = (try? FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil)) ?? []
                        for file in jsonFiles where file.pathExtension == "json" {
                            let pack = try KokoroAneVoicePack.load(fromJSON: Data(contentsOf: file))
                            let output = ane.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".bin")
                            // Derived packs are rebuilt from the verified originals before every load.
                            try pack.binaryData.write(to: output, options: .atomic)
                        }
                        voices = try FileManager.default.contentsOfDirectory(atPath: ane.path)
                            .filter { $0.hasSuffix(".bin") && ($0.hasPrefix("af_") || $0.hasPrefix("am_") || $0.hasPrefix("bf_") || $0.hasPrefix("bm_")) }
                            .map { String($0.dropLast(4)) }.filter { !kokoroWithheld.contains($0) }.sorted()
                        let model = KokoroAneManager(directory: local)
                        try await model.initialize(preloadVoices: Set(voices))
                        kokoro = model
                    } else if request.engine == "ming" {
                        ming = try await MingDenseModel.fromModelDirectory(local)
                        voices = mingVoices
                    } else {
                        qwen = try await Qwen3TTSModel.fromModelDirectory(local)
                        // Base voices are the app-owned reference bank, not invented presets.
                        voices = []
                    }
                    loaded = request.engine
                    emit(["id": request.id, "ok": true, "voices": voices])
                } else if request.op == "synthesize" || request.op == "design" {
                    guard loaded == request.engine else { throw Failure.message("Load this engine first.") }
                    guard let voice = request.voice,
                          (request.engine == "qwen" || request.engine == "qwen-design" || voices.contains(voice)),
                          let text = request.text,
                          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                          text.utf16.count <= 1200, !text.contains("\0") else { throw Failure.message("Invalid voice or speech text.") }
                    // Seeded engines get a bounded number of retries with a different seed when the output fails the check.
                    // Kokoro and temperature-0 Ming are deterministic, so a retry would repeat the same defect.
                    let seeded = request.engine == "qwen" || request.engine == "qwen-design" || phonon != nil || (ming != nil && (request.temperature ?? 0) > 0)
                    let baseSeed = request.seed ?? 42
                    var wav = Data(), problem = "no audio", overlong: Data? = nil
                    for attempt in 0...(seeded ? 2 : 0) {
                        let seed = baseSeed &+ UInt64(attempt) &* 7919
                        let candidate: Data
                        if let model = phonon {
                            candidate = try await model.synthesize(text: text, voice: voice, temperature: request.temperature ?? 0.3, seed: seed)
                        } else if let model = kokoro {
                            candidate = try await model.synthesize(text: text, voice: voice, speed: request.speed ?? 1)
                        } else if let model = qwen {
                            let audio: MLXArray
                            if request.engine == "qwen-design" {
                                guard request.op == "design" else { throw Failure.message("Design once and save a reference before playback.") }
                                audio = try await model.generate(text: text, voice: voice, refAudio: nil, refText: nil, language: "English",
                                    generationParameters: GenerateParameters(temperature: request.temperature ?? 0.7, seed: seed))
                            } else {
                                guard let path = request.referencePath, let transcript = request.referenceText,
                                      !transcript.isEmpty else { throw Failure.message("A verified reference and exact transcript are required.") }
                                let (_, reference) = try loadAudioArray(from: URL(fileURLWithPath: path), sampleRate: model.sampleRate)
                                audio = try await model.generate(text: text, voice: nil, refAudio: reference, refText: transcript, language: "English",
                                    generationParameters: GenerateParameters(temperature: request.temperature ?? 0.7, seed: seed))
                            }
                            candidate = try wave(audio.asArray(Float.self), sampleRate: model.sampleRate)
                        } else if let model = ming {
                            // Preset identity and freeform direction are separate upstream tasks.
                            // Do not add an instruction here or pretend unsupported acting controls work.
                            let audio = try await model.generate(text: text, voice: voice, refAudio: nil, refText: nil, language: "en",
                                generationParameters: GenerateParameters(temperature: request.temperature ?? 0, seed: seed))
                            candidate = try wave(audio.asArray(Float.self), sampleRate: model.sampleRate)
                        } else { throw Failure.message("Voice engine is not loaded.") }
                        // Free MLX's buffer cache between lines; the first synthesis otherwise keeps gigabytes resident.
                        Memory.clearCache()
                        guard let clip = SpeechAudio.decode(candidate) else { throw Failure.message("The voice engine returned unreadable audio.") }
                        if let defect = SpeechAudio.defect(clip, text: text) {
                            problem = defect
                            // Real speech that merely runs long (digits, abbreviations) beats no line at all.
                            if defect == SpeechAudio.tooLong, overlong == nil, SpeechAudio.usableOverlong(clip, text: text) {
                                overlong = SpeechAudio.encode(SpeechAudio.normalized(clip))
                            }
                            continue
                        }
                        wav = SpeechAudio.encode(SpeechAudio.normalized(clip)); problem = ""
                        break
                    }
                    if !problem.isEmpty, let kept = overlong { wav = kept; problem = "" }
                    if !problem.isEmpty { throw Failure.message("The voice engine returned unusable audio (\(problem)). Try again or choose another voice.") }
                    guard wav.count <= 16 * 1024 * 1024 else { throw Failure.message("Generated audio exceeds the speech limit.") }
                    emit(["id": request.id, "ok": true, "audio": wav.base64EncodedString()])
                } else { throw Failure.message("Unknown voice operation.") }
            } catch {
                emit(["id": request.id, "ok": false, "error": error.localizedDescription])
            }
        }
    }

    static func wave(_ samples: [Float], sampleRate: Int) throws -> Data {
        guard !samples.isEmpty, samples.count <= 8_000_000, sampleRate > 0,
              samples.allSatisfy(\.isFinite) else { throw Failure.message("Invalid generated samples.") }
        var out = Data()
        func ascii(_ value: String) { out.append(value.data(using: .ascii)!) }
        func word<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { out.append(contentsOf: $0) } }
        ascii("RIFF"); word(UInt32(36 + samples.count * 2)); ascii("WAVEfmt ")
        word(UInt32(16)); word(UInt16(1)); word(UInt16(1)); word(UInt32(sampleRate)); word(UInt32(sampleRate * 2))
        word(UInt16(2)); word(UInt16(16)); ascii("data"); word(UInt32(samples.count * 2))
        for value in samples { word(Int16((min(1, max(-1, value)) * 32767).rounded())) }
        return out
    }
}
