import FluidAudio
import Foundation

/// One recognized word with its position in the audio, when the engine reports it.
struct WordTiming: Codable, Sendable {
    let word: String
    let start: Double
    let end: Double
}

/// What every engine returns: the text, word timings where available, and how long it took.
struct Transcript: Codable, Sendable {
    let engine: String
    let text: String
    let words: [WordTiming]
    let audioSeconds: Double
    let transcribeMs: Double
}

enum SpeechError: LocalizedError {
    case unavailable(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .unavailable(let message), .failed(let message): return message
        }
    }
}

/// A recognizer the app can swap without touching the formatter.
///
/// `prepare` loads weights (or checks the OS assets) once; `transcribe` may then
/// run many times. Engines never download anything unless `allowDownload` is set,
/// so a writer's first take cannot silently start a large download.
protocol SpeechEngine: Actor {
    nonisolated var name: String { get }
    func prepare(allowDownload: Bool) async throws
    func transcribe(file: URL) async throws -> Transcript
}

enum EngineKind: String, CaseIterable {
    case parakeet, apple, whisper

    func make(options: [String: String]) throws -> SpeechEngine {
        switch self {
        case .parakeet:
            guard let precision = ParakeetEncoderPrecision(rawValue: options["precision"] ?? "int8-v2") else {
                throw SpeechError.unavailable("Unknown Parakeet precision. Use int8, int8-v2 or int4.")
            }
            return ParakeetEngine(precision: precision)
        case .apple:
            if #available(macOS 26.0, *) {
                return AppleSpeechEngine(localeIdentifier: options["locale"] ?? "en-US")
            }
            throw SpeechError.unavailable("Apple on-device speech needs macOS 26 or later.")
        case .whisper:
            return try WhisperCppEngine(model: options["whisper-model"])
        }
    }
}

func elapsedMs(since start: ContinuousClock.Instant) -> Double {
    let duration = ContinuousClock.now - start
    return Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
}
