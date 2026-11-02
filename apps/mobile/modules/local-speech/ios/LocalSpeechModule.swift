import AVFoundation
import ExpoModulesCore
import Speech

public final class LocalSpeechModule: Module {
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var generation = 0

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
    AsyncFunction("start") {
      try self.start()
    }.runOnQueue(.main)
    Function("finish") {
      DispatchQueue.main.async { self.finish() }
    }
    Function("cancel") {
      DispatchQueue.main.async { self.reset() }
    }
    OnDestroy { DispatchQueue.main.async { self.reset() } }
  }

  private func start() throws {
    reset()
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
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement)
    try session.setActive(true)
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
    if engine != nil { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    task = nil
    request = nil
    engine = nil
  }
}
