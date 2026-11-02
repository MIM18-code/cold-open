import FluidAudio
import Foundation

/// Parakeet TDT 0.6B v3 through FluidAudio's Core ML conversion (Neural Engine by default).
///
/// `precision` picks the encoder file. FluidAudio's default (`int8`) is a 6-bit
/// palettized encoder with a known token-corruption bug (FluidAudio #760);
/// `int8-v2` is its re-quantized fix and is what this helper uses.
actor ParakeetEngine: SpeechEngine {
    nonisolated let name: String
    private let precision: ParakeetEncoderPrecision
    private var manager: AsrManager?
    private let converter = AudioConverter()

    init(precision: ParakeetEncoderPrecision = .int8V2) {
        self.precision = precision
        self.name = "parakeet-coreml-" + precision.rawValue
    }

    func prepare(allowDownload: Bool) async throws {
        if manager != nil { return }
        let models: AsrModels
        if allowDownload {
            models = try await AsrModels.downloadAndLoad(version: .v3, encoderPrecision: precision)
        } else {
            let directory = AsrModels.defaultCacheDirectory(for: .v3)
            guard AsrModels.modelsExist(at: directory, version: .v3, encoderPrecision: precision) else {
                throw SpeechError.unavailable(
                    "Parakeet Core ML weights are not downloaded. Run `speech-helper download --engine parakeet` once.")
            }
            models = try await AsrModels.load(from: directory, version: .v3, encoderPrecision: precision)
        }
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        self.manager = manager
    }

    func transcribe(file: URL) async throws -> Transcript {
        guard let manager else { throw SpeechError.failed("Parakeet is not loaded.") }
        let start = ContinuousClock.now
        let samples = try converter.resampleAudioFile(file)
        var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(samples, decoderState: &state)
        let words = buildWordTimings(from: result.tokenTimings ?? []).map {
            WordTiming(word: $0.word, start: $0.startTime, end: $0.endTime)
        }
        return Transcript(engine: name, text: result.text.trimmingCharacters(in: .whitespacesAndNewlines),
                          words: words, audioSeconds: Double(samples.count) / 16_000,
                          transcribeMs: elapsedMs(since: start))
    }
}
