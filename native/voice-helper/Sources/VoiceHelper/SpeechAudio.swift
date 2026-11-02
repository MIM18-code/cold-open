import Foundation

/// Output checks and loudness normalization shared by every engine the helper runs.
/// Every engine hands back a 16-bit mono PCM WAV, so these work on that one format.
enum SpeechAudio {
    /// Integrated loudness target for every rendered line, and the true-peak ceiling.
    static let targetLUFS = -20.0
    // Internal ceiling sits 1 dB under the -1 dBTP target to cover meter differences and 16-bit rounding.
    static let ceilingDBTP = -2.0
    static let maxBoostDB = 18.0

    struct Clip {
        var samples: [Float]
        var sampleRate: Int
    }

    static func decode(_ wav: Data) -> Clip? {
        let b = [UInt8](wav)
        guard b.count > 44, b[0...3] == [0x52, 0x49, 0x46, 0x46] else { return nil }
        func u16(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 }
        func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
        var offset = 12, rate = 0
        while offset + 8 <= b.count {
            let size = u32(offset + 4)
            if b[offset...offset + 3] == [0x66, 0x6d, 0x74, 0x20], offset + 24 <= b.count {
                guard u16(offset + 8) == 1, u16(offset + 10) == 1, u16(offset + 22) == 16 else { return nil }
                rate = u32(offset + 12)
            } else if b[offset...offset + 3] == [0x64, 0x61, 0x74, 0x61] {
                let end = min(b.count, offset + 8 + size)
                guard rate > 0, end > offset + 8 else { return nil }
                var samples = [Float](); samples.reserveCapacity((end - offset - 8) / 2)
                var i = offset + 8
                while i + 1 < end { samples.append(Float(Int16(truncatingIfNeeded: u16(i))) / 32768); i += 2 }
                return Clip(samples: samples, sampleRate: rate)
            }
            offset += 8 + size + (size & 1)
        }
        return nil
    }

    static func encode(_ clip: Clip) -> Data {
        var out = Data()
        func ascii(_ value: String) { out.append(value.data(using: .ascii)!) }
        func word<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { out.append(contentsOf: $0) } }
        ascii("RIFF"); word(UInt32(36 + clip.samples.count * 2)); ascii("WAVEfmt ")
        word(UInt32(16)); word(UInt16(1)); word(UInt16(1)); word(UInt32(clip.sampleRate)); word(UInt32(clip.sampleRate * 2))
        word(UInt16(2)); word(UInt16(16)); ascii("data"); word(UInt32(clip.samples.count * 2))
        for value in clip.samples { word(Int16((min(1, max(-1, value)) * 32767).rounded())) }
        return out
    }

    // MARK: Loudness (ITU-R BS.1770 K-weighting with 400 ms gated blocks)

    private static func kWeighted(_ x: [Float], rate: Int) -> [Double] {
        let fs = Double(rate)
        func stage(_ input: [Double], _ b: (Double, Double, Double), _ a: (Double, Double)) -> [Double] {
            var out = [Double](repeating: 0, count: input.count)
            var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
            for (n, v) in input.enumerated() {
                let y = b.0 * v + b.1 * x1 + b.2 * x2 - a.0 * y1 - a.1 * y2
                out[n] = y; x2 = x1; x1 = v; y2 = y1; y1 = y
            }
            return out
        }
        var k = tan(Double.pi * 1681.974450955533 / fs)
        let q1 = 0.7071752369554196, vh = pow(10, 3.999843853973347 / 20), vb = pow(vh, 0.4996667741545416)
        var a0 = 1 + k / q1 + k * k
        let shelfB = ((vh + vb * k / q1 + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q1 + k * k) / a0)
        let shelfA = (2 * (k * k - 1) / a0, (1 - k / q1 + k * k) / a0)
        k = tan(Double.pi * 38.13547087602444 / fs)
        let q2 = 0.5003270373238773
        a0 = 1 + k / q2 + k * k
        let highA = (2 * (k * k - 1) / a0, (1 - k / q2 + k * k) / a0)
        return stage(stage(x.map(Double.init), shelfB, shelfA), (1, -2, 1), highA)
    }

    /// Integrated loudness in LUFS, or -inf for silence. Clips shorter than one block use the whole clip.
    static func lufs(_ x: [Float], rate: Int) -> Double {
        let w = kWeighted(x, rate: rate)
        let block = Int(0.4 * Double(rate)), step = Int(0.1 * Double(rate))
        var energies = [Double]()
        if w.count < block { energies = [w.reduce(0) { $0 + $1 * $1 } / Double(max(1, w.count))] }
        else {
            var cumulative = [Double](repeating: 0, count: w.count + 1)
            for (i, v) in w.enumerated() { cumulative[i + 1] = cumulative[i] + v * v }
            var start = 0
            while start + block <= w.count { energies.append((cumulative[start + block] - cumulative[start]) / Double(block)); start += step }
        }
        func level(_ e: Double) -> Double { e > 0 ? -0.691 + 10 * log10(e) : -Double.infinity }
        let absolute = energies.filter { level($0) > -70 }
        guard !absolute.isEmpty else { return -Double.infinity }
        let relativeGate = level(absolute.reduce(0, +) / Double(absolute.count)) - 10
        let gated = absolute.filter { level($0) > relativeGate }
        guard !gated.isEmpty else { return -Double.infinity }
        return level(gated.reduce(0, +) / Double(gated.count))
    }

    /// True peak in dBFS from 4x Catmull-Rom interpolation between samples.
    static func truePeakDB(_ x: [Float]) -> Double {
        guard x.count > 3 else { return 20 * log10(Double(x.map { abs($0) }.max() ?? 0)) }
        var peak: Float = 0
        for v in x { peak = max(peak, abs(v)) }
        for i in 1..<(x.count - 2) {
            let p0 = x[i - 1], p1 = x[i], p2 = x[i + 1], p3 = x[i + 2]
            for t in [Float(0.25), 0.5, 0.75] {
                let t2 = t * t, t3 = t2 * t
                let v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
                peak = max(peak, abs(v))
            }
        }
        return peak > 0 ? 20 * log10(Double(peak)) : -Double.infinity
    }

    /// Scales the clip to the target loudness, reducing the gain when needed to stay under the true-peak ceiling.
    /// Clips that are effectively silent are left alone; the quality check rejects them first.
    static func normalized(_ clip: Clip) -> Clip {
        let loudness = lufs(clip.samples, rate: clip.sampleRate)
        guard loudness.isFinite, loudness > -60 else { return clip }
        var gain = min(maxBoostDB, targetLUFS - loudness)
        let peak = truePeakDB(clip.samples)
        if peak.isFinite { gain = min(gain, ceilingDBTP - peak) }
        let factor = Float(pow(10, gain / 20))
        return Clip(samples: clip.samples.map { $0 * factor }, sampleRate: clip.sampleRate)
    }

    // MARK: Output check

    static let tooLong = "audio too long for the text"

    /// Rough count of spoken words. Digits are read one at a time ("0042 8817" is eight words), and long or
    /// all-capital tokens (codes, abbreviations, numbers with separators) take longer than one word.
    static func spokenUnits(_ text: String) -> Double {
        var units = 0.0
        for token in text.split(whereSeparator: { $0.isWhitespace }) {
            let digits = token.filter { $0.isNumber }.count
            let letters = token.filter { $0.isLetter }.count
            let marks = token.count - digits - letters
            units += max(1, Double(digits) + (Double(letters) / 6).rounded(.up) + Double(marks) / 4)
        }
        return max(1, units)
    }

    /// Frame activity: 20 ms windows within 40 dB of the clip peak.
    private static func activity(_ x: [Float], rate: Int, peak: Float) -> [Bool] {
        let frame = max(1, rate / 50), floorLevel = Double(peak) * 0.01
        var out = [Bool](); out.reserveCapacity(x.count / frame)
        var i = 0
        while i + frame <= x.count {
            var sum = 0.0
            for j in i..<(i + frame) { sum += Double(x[j] * x[j]) }
            out.append((sum / Double(frame)).squareRoot() > floorLevel)
            i += frame
        }
        return out
    }

    /// True when no pause inside the speech lasts over 2 s. A clip that is too long for its text but passes this
    /// is slow or wordy rather than broken, so the caller may keep it.
    static func speechThroughout(_ clip: Clip) -> Bool {
        let peak = clip.samples.reduce(Float(0)) { max($0, abs($1)) }
        guard peak >= 0.01 else { return false }
        var gap = 0, longest = 0, started = false
        for on in activity(clip.samples, rate: clip.sampleRate, peak: peak) {
            if on { started = true; longest = max(longest, gap); gap = 0 } else if started { gap += 1 }
        }
        return Double(longest) * 0.02 <= 2.0
    }

    /// A too-long take worth keeping as a last resort: continuous speech, and not wildly longer than the estimate,
    /// so endless repetition is never returned.
    static func usableOverlong(_ clip: Clip, text: String) -> Bool {
        let seconds = Double(clip.samples.count) / Double(clip.sampleRate)
        return speechThroughout(clip) && seconds <= 2.5 * spokenUnits(text) + 4.5
    }

    /// Returns a reason when the audio cannot be a faithful reading of the text: silence, a long dead lead-in or tail,
    /// an implausible length for the text, or a hard cut in the middle of a sound.
    static func defect(_ clip: Clip, text: String) -> String? {
        let x = clip.samples, rate = clip.sampleRate
        let seconds = Double(x.count) / Double(rate)
        var peak: Float = 0
        for v in x { peak = max(peak, abs(v)) }
        guard peak >= 0.01 else { return "silent audio" }
        let flags = activity(x, rate: rate, peak: peak)
        guard let first = flags.firstIndex(of: true), let last = flags.lastIndex(of: true) else { return "silent audio" }
        let lead = Double(first) * 0.02, tail = Double(flags.count - 1 - last) * 0.02
        if lead > 2.0 { return "long silence before speech" }
        if tail > 2.0 { return "long silence after speech" }
        let words = Double(max(1, text.split(whereSeparator: { $0.isWhitespace }).count))
        if words >= 6, seconds < words / 7 { return "audio too short for the text" }
        // The last 10 ms still loud means the sound was cut off.
        let tailCount = min(x.count, rate / 100)
        var tailSum = 0.0
        for j in (x.count - tailCount)..<x.count { tailSum += Double(x[j] * x[j]) }
        if tailCount > 0, (tailSum / Double(tailCount)).squareRoot() > Double(peak) * 0.1 { return "audio cut off mid-sound" }
        // Duration is judged last: it is the only failure when nothing else is wrong with the take.
        if seconds > spokenUnits(text) + 4.5 { return tooLong }
        return nil
    }
}
