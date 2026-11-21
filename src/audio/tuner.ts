/** Microphone pitch detection (normalised autocorrelation, parabolic peak). */

export interface PitchReading {
  freq: number;
  clarity: number; // 0..1
}

export class Tuner {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private data = new Float32Array(2048);

  async start() {
    // getUserMedia needs a secure context: localhost or HTTPS (Cloudflare tunnel is fine).
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
  }

  read(): PitchReading | null {
    if (!this.analyser || !this.ctx) return null;
    this.analyser.getFloatTimeDomainData(this.data);
    return detectPitch(this.data, this.ctx.sampleRate);
  }
}

export function detectPitch(buf: Float32Array, sr: number): PitchReading | null {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return null;

  const minLag = Math.floor(sr / 1200);
  const maxLag = Math.min(Math.floor(sr / 60), n >> 1);
  const W = n - maxLag;
  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0, m = 0;
    for (let i = 0; i < W; i++) {
      acf += buf[i] * buf[i + lag];
      m += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
    }
    nsdf[lag] = m > 0 ? (2 * acf) / m : 0;
  }
  // First peak above 0.9 * global max (avoids octave errors).
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) globalMax = Math.max(globalMax, nsdf[lag]);
  if (globalMax < 0.5) return null;
  let best = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (nsdf[lag] >= 0.9 * globalMax && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      best = lag;
      break;
    }
  }
  if (best < 0) return null;
  const a = nsdf[best - 1], b = nsdf[best], c = nsdf[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { freq: sr / (best + shift), clarity: b };
}
