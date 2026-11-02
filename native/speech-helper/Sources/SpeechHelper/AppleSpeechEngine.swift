import AVFoundation
import Foundation
import Speech

/// Apple's on-device SpeechAnalyzer + SpeechTranscriber (macOS 26).
///
/// The model is an OS asset managed by AssetInventory, shared with the system,
/// so it costs the app no download size. It is the same recognizer the phone
/// remote will use, which keeps desktop and phone transcripts comparable.
@available(macOS 26.0, *)
actor AppleSpeechEngine: SpeechEngine {
    nonisolated let name = "apple-speechtranscriber"
    private let locale: Locale

    init(localeIdentifier: String) {
        self.locale = Locale(identifier: localeIdentifier)
    }

    private func makeTranscriber() -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                          attributeOptions: [.audioTimeRange])
    }

    func prepare(allowDownload: Bool) async throws {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw SpeechError.unavailable("Apple speech does not support \(locale.identifier).")
        }
        let installed = await SpeechTranscriber.installedLocales
        if installed.contains(where: { $0.identifier(.bcp47) == supported.identifier(.bcp47) }) { return }
        guard allowDownload else {
            throw SpeechError.unavailable("The Apple speech model for \(supported.identifier) is not installed. "
                                          + "Run `speech-helper download --engine apple` once.")
        }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber()]) {
            try await request.downloadAndInstall()
        }
    }

    func transcribe(file: URL) async throws -> Transcript {
        let start = ContinuousClock.now
        let transcriber = makeTranscriber()
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let audio = try AVAudioFile(forReading: file)
        let seconds = Double(audio.length) / audio.processingFormat.sampleRate
        let collector = Task {
            var text = AttributedString()
            for try await result in transcriber.results where result.isFinal {
                text += result.text
            }
            return text
        }
        if let last = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        let attributed = try await collector.value
        var words: [WordTiming] = []
        for run in attributed.runs {
            guard let range = run.audioTimeRange else { continue }
            let word = String(attributed[run.range].characters).trimmingCharacters(in: .whitespaces)
            if word.isEmpty { continue }
            words.append(WordTiming(word: word, start: range.start.seconds, end: range.end.seconds))
        }
        let text = String(attributed.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        return Transcript(engine: name, text: text, words: words, audioSeconds: seconds,
                          transcribeMs: elapsedMs(since: start))
    }
}
