/**
 * pcm-worklet.js — Captures raw Float32 PCM from the audio graph and posts
 * channel buffers to the main thread. Output is silence (we only tap the signal).
 */
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      // Copy each channel's Float32Array (the underlying buffers are reused)
      const channels = input.map(c => c.slice());
      this.port.postMessage(channels, channels.map(c => c.buffer));
    }
    return true; // keep processor alive
  }
}
registerProcessor('pcm-capture', PCMCapture);
