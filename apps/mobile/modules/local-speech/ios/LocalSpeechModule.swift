import AVFoundation
import ExpoModulesCore
import Speech

public final class LocalSpeechModule: Module {
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var generation = 0
  private var sessionActive = false

  public func definition() -> ModuleDefinition {
    Name("InklotLocalSpeech")
    Events("result", "ended")
    AsyncFunction("authorize") { () async -> Bool in
      let speech = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
      }
      guard speech == .authorized else { return false }
      return await withCheckedContinuation { continuation in
        AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
      }
    }
    AsyncFunction("start") { () async throws in
      // setCategory and setActive can block for seconds while CoreAudio starts. On the main thread that
      // deadlocked the first dictation ("Initialize: RPC timeout"), so the session is activated off it.
      // Stop any earlier take first: its deactivation is queued ahead of this activation on the same queue.
      await MainActor.run { self.reset() }
      try await self.activateSession()
      try await MainActor.run {
        self.sessionActive = true
        do { try self.start() } catch { self.reset(); throw error }
      }
    }
    Function("finish") {
      DispatchQueue.main.async { self.finish() }
    }
    Function("cancel") {
      DispatchQueue.main.async { self.reset() }
    }
    OnDestroy { DispatchQueue.main.async { self.reset() } }
  }

  private func start() throws {
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable,
          recognizer.supportsOnDeviceRecognition else {
      throw NSError(domain: "Inklot", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "On-device speech is unavailable for this iPhone’s language."
      ])
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    let engine = AVAudioEngine()
    self.engine = engine
    self.request = request
    let node = engine.inputNode
    let format = node.outputFormat(forBus: 0)
    guard format.sampleRate > 0 && format.channelCount > 0 else {
      reset()
      throw NSError(domain: "Inklot", code: 2, userInfo: [NSLocalizedDescriptionKey: "No microphone available."])
    }
    node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
    do { try engine.start() } catch { reset(); throw error }
    let id = generation
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, id == self.generation else { return }
        if let result { self.sendEvent("result", ["text": result.bestTranscription.formattedString]) }
        if result?.isFinal == true || error != nil {
          self.sendEvent("ended", ["error": error?.localizedDescription ?? ""])
          self.reset()
        }
      }
    }
  }

  private let audio = DispatchQueue(label: "com.mindinmotion.inklot.speech-session")

  private func activateSession() async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      audio.async {
        do {
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.record, mode: .measurement)
          try session.setActive(true)
          continuation.resume()
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  private func finish() {
    if let engine, engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio()
  }

  private func reset() {
    generation += 1
    finish()
    task?.cancel()
    if sessionActive {
      sessionActive = false
      audio.async { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
    task = nil
    request = nil
    engine = nil
  }
}
