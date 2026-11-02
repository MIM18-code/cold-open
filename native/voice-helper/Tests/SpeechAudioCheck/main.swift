import Foundation

// Compiled with Sources/VoiceHelper/SpeechAudio.swift by apps/desktop/test/voice-helper-audio.test.ts.
let rate = 24000
func burst(_ seconds: Double, _ amplitude: Float = 0.3) -> [Float] {
    (0..<Int(seconds * Double(rate))).map { i in
        let t = Double(i) / Double(rate)
        let gate: Float = t.truncatingRemainder(dividingBy: 0.35) < 0.25 ? 1 : 0.0
        return amplitude * gate * Float(sin(2 * Double.pi * 220 * t))
    }
}
func silence(_ seconds: Double) -> [Float] { [Float](repeating: 0, count: Int(seconds * Double(rate))) }
func clip(_ parts: [Float]...) -> SpeechAudio.Clip { SpeechAudio.Clip(samples: parts.flatMap { $0 }, sampleRate: rate) }

var failures = [String]()
func expect(_ name: String, _ got: String?, _ want: String?) {
    if got != want { failures.append("\(name): got \(got ?? "nil"), wanted \(want ?? "nil")") }
}

let digits = "0042 8817 3391"
if SpeechAudio.spokenUnits(digits) < 12 { failures.append("digits are read one at a time") }
expect("long digit string read at normal pace", SpeechAudio.defect(clip(burst(9), silence(0.3)), text: digits), nil)
expect("numbers and abbreviations", SpeechAudio.defect(clip(burst(7), silence(0.3)), text: "Call 1-800-555-0199 about the FBI file."), nil)
expect("a one-word line that runs on", SpeechAudio.defect(clip(burst(12), silence(0.3)), text: "Yeah."), SpeechAudio.tooLong)
expect("runaway speech is still kept as a last resort", SpeechAudio.speechThroughout(clip(burst(12), silence(0.3))) ? "kept" : "dropped", "kept")
expect("a dead gap inside is not kept", SpeechAudio.speechThroughout(clip(burst(4), silence(4), burst(4), silence(0.3))) ? "kept" : "dropped", "dropped")
expect("silence", SpeechAudio.defect(clip(silence(6)), text: "Yeah."), "silent audio")
expect("near silence", SpeechAudio.defect(clip(burst(5, 0.004)), text: "Yeah."), "silent audio")
expect("dead lead-in", SpeechAudio.defect(clip(silence(3), burst(2), silence(0.3)), text: "Yeah, okay then."), "long silence before speech")
expect("dead tail", SpeechAudio.defect(clip(burst(2), silence(3)), text: "Yeah, okay then."), "long silence after speech")
expect("cut off", SpeechAudio.defect(clip(burst(0.25 + 0.35 * 3 + 0.0)), text: "Okay then fine."), "audio cut off mid-sound")
expect("too short", SpeechAudio.defect(clip(burst(0.5), silence(0.3)), text: "one two three four five six seven eight nine ten"), "audio too short for the text")

// A long take that also ends mid-sound is a truncation, not a slow reading.
expect("long and cut off", SpeechAudio.defect(clip(burst(12.1)), text: "Yeah."), "audio cut off mid-sound")
let rambling = clip(burst(30), silence(0.3))
expect("endless repetition is not kept", SpeechAudio.usableOverlong(rambling, text: "Yeah.") ? "kept" : "dropped", "dropped")
expect("slow digits are kept", SpeechAudio.usableOverlong(clip(burst(30), silence(0.3)), text: digits) ? "kept" : "dropped", "kept")

if failures.isEmpty { print("ok") } else { failures.forEach { print("FAIL " + $0) }; exit(1) }
