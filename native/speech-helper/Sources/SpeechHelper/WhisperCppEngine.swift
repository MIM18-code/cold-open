import FluidAudio
import Foundation

/// whisper.cpp through its `whisper-cli` binary, for writers who already run Whisper.
///
/// It runs as a child process per take, so it pays its model load on every
/// transcription. That is acceptable for an optional engine and keeps GGML out
/// of this helper's address space.
actor WhisperCppEngine: SpeechEngine {
    nonisolated let name = "whisper-cpp"
    private let binary: URL
    private let model: URL
    private let converter = AudioConverter()

    init(model: String?) throws {
        let candidates = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]
        guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw SpeechError.unavailable("whisper-cli is not installed (brew install whisper-cpp).")
        }
        guard let model, FileManager.default.fileExists(atPath: model) else {
            throw SpeechError.unavailable("Pass --whisper-model with a ggml model file.")
        }
        self.binary = URL(fileURLWithPath: path)
        self.model = URL(fileURLWithPath: model)
    }

    func prepare(allowDownload: Bool) async throws {}

    func transcribe(file: URL) async throws -> Transcript {
        let start = ContinuousClock.now
        // whisper-cli wants 16 kHz mono PCM; reuse the same resampler Parakeet uses.
        let samples = try converter.resampleAudioFile(file)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wav = directory.appendingPathComponent("take.wav")
        try writeWav(samples, to: wav)
        let process = Process()
        process.executableURL = binary
        process.arguments = ["-m", model.path, "-f", wav.path, "-l", "en", "-nt", "-np", "-oj",
                             "-of", directory.appendingPathComponent("out").path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw SpeechError.failed("whisper-cli exited with status \(process.terminationStatus).")
        }
        let data = try Data(contentsOf: directory.appendingPathComponent("out.json"))
        struct Output: Decodable {
            struct Segment: Decodable {
                struct Offsets: Decodable { let from: Int; let to: Int }
                let offsets: Offsets
                let text: String
            }
            let transcription: [Segment]
        }
        let output = try JSONDecoder().decode(Output.self, from: data)
        let text = output.transcription.map(\.text).joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Transcript(engine: name, text: text, words: [], audioSeconds: Double(samples.count) / 16_000,
                          transcribeMs: elapsedMs(since: start))
    }
}

func writeWav(_ samples: [Float], to url: URL, sampleRate: Int = 16_000) throws {
    var data = Data()
    func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    let byteCount = samples.count * 2
    data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + byteCount))
    data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
    append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
    data.append(contentsOf: Array("data".utf8)); append(UInt32(byteCount))
    for sample in samples { append(Int16(max(-1, min(1, sample)) * Float(Int16.max))) }
    try data.write(to: url)
}
