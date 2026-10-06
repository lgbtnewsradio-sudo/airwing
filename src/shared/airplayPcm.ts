export interface AirPlayPcmFrame { pcm: Uint8Array; capturedAtMs: number }

/** Continuous stereo 44.1 kHz / 352-sample framing, independent of capture block size. */
export class AirPlayPcmFramer {
  private position = 0;
  private previous = [0, 0];
  private count = 0;
  private output = new Uint8Array(352 * 4);
  private frameTime = 0;
  private rate = 0;
  private nextFrameTime = 0;
  private expectedInputTime = 0;
  private channels = 0;

  reset(): void {
    this.position = 0; this.previous = [0, 0]; this.count = 0; this.rate = 0;
    this.nextFrameTime = 0; this.expectedInputTime = 0; this.channels = 0;
  }

  push(planar: Float32Array, frames: number, channels: number, rate: number, capturedAtMs: number): AirPlayPcmFrame[] {
    if (!Number.isInteger(frames) || !Number.isInteger(channels) || frames < 2 || channels < 1 || !Number.isFinite(capturedAtMs) || !Number.isFinite(rate) || rate < 8000 || planar.length < frames * channels) return [];
    if (rate !== this.rate || channels !== this.channels || Math.abs(capturedAtMs - this.expectedInputTime) > 80) {
      this.reset(); this.rate = rate; this.channels = channels; this.nextFrameTime = capturedAtMs;
    }
    this.expectedInputTime = capturedAtMs + frames * 1000 / rate;
    const result: AirPlayPcmFrame[] = [];
    const view = new DataView(this.output.buffer);
    while (this.position < frames - 1) {
      if (this.count === 0) this.frameTime = this.nextFrameTime;
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      for (let channel = 0; channel < 2; channel++) {
        const source = Math.min(channel, channels - 1);
        const a = index < 0 ? this.previous[channel] : planar[source * frames + index];
        const b = planar[source * frames + index + 1];
        const value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
        view.setInt16(this.count * 4 + channel * 2, Number.isFinite(value) ? Math.round(value * (value < 0 ? 32768 : 32767)) : 0, true);
      }
      this.count++;
      this.position += rate / 44100;
      if (this.count === 352) {
        result.push({ pcm: this.output.slice(), capturedAtMs: this.frameTime });
        this.count = 0;
        this.nextFrameTime += 352 * 1000 / 44100;
      }
    }
    this.position -= frames;
    this.previous = [planar[frames - 1], planar[Math.min(1, channels - 1) * frames + frames - 1]];
    return result;
  }
}
