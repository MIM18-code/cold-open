// Runs on the audio thread: collects the microphone's 128-sample blocks into larger chunks and posts them
// to the page. Loaded as a separate file because the page's CSP does not allow blob: or data: scripts.
class DictationTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.pending.push(input.map((channel) => channel.slice()));
      this.count += input[0].length;
      if (this.count >= 2048) {
        const channels = this.pending[0].map((_, c) => {
          const joined = new Float32Array(this.count);
          let at = 0;
          for (const block of this.pending) {
            joined.set(block[c] ?? block[0], at);
            at += block[0].length;
          }
          return joined;
        });
        this.port.postMessage(channels, channels.map((channel) => channel.buffer));
        this.pending = [];
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor("dictation-tap", DictationTap);
