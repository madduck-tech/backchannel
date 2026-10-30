// Copies every render quantum of its input to the page, unchanged, as float32 (#291).
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // An input with no channel is a quantum the graph had nothing for: zeros, so the recording
    // keeps time rather than silently shortening. The frame lets the page count the context's own
    // gaps (#291: a timer-clocked context lost 150-300 ms in an hour).
    this.port.postMessage({ frame: currentFrame, data: ch ? ch.slice(0) : new Float32Array(128) });
    return true;
  }
}
registerProcessor('tap', Tap);
