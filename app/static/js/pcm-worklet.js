/**
 * pcm-worklet.js — Captures raw Float32 PCM from the audio graph and posts
 * channel buffers to the main thread. Output is silence (we only tap the signal).
 */
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = e => {
      if (e.data?.type === 'drain') {
        // Echo back so the main thread knows all prior audio-frame messages
        // have been posted and are ahead of this reply in the port queue.
        this.port.postMessage({ type: 'drained' });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const len = input[0].length;
      let mono;
      if (input.length === 1) {
        mono = input[0].slice();
      } else {
        // Mix down to mono — avoids silent-channel stereo from XLR/USB interfaces
        // that deliver signal on only one channel.
        mono = new Float32Array(len);
        for (const ch of input) {
          for (let i = 0; i < len; i++) mono[i] += ch[i];
        }
        const scale = 1 / input.length;
        for (let i = 0; i < len; i++) mono[i] *= scale;
      }
      this.port.postMessage([mono], [mono.buffer]);
    }
    return true; // keep processor alive
  }
}
registerProcessor('pcm-capture', PCMCapture);
