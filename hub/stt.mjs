// Local speech-to-text with whisper.cpp's whisper-server, kept warm between requests.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wrap raw 16 kHz mono s16le PCM in a WAV header. */
export function pcmToWav(pcm, sampleRate = 16000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS level of s16le PCM, 0..1, used to skip silent recordings. */
export function pcmLevel(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

// Whisper hallucinates these on silence or noise.
const HALLUCINATIONS = [/^\[?(blank_audio|silence|music|inaudible)\]?$/i, /^(thank you\.?|thanks for watching!?|you)$/i];
// Sound-effect captions whisper invents around speech: "*phone rings*", "[music]", "(laughs)".
const SOUND_TAG = /\s*(\*[^*]{1,40}\*|\[[^\]]{1,40}\]|\([^)]{1,40}\))\s*/g;

export function cleanTranscript(raw) {
  let text = String(raw || "").replace(/\s+/g, " ").trim();
  text = text.replace(SOUND_TAG, " ").replace(/\s+/g, " ").trim();
  if (HALLUCINATIONS.some((re) => re.test(text))) return "";
  return text;
}

export class Transcriber {
  constructor({ port, model, log = () => {} }) {
    this.port = port;
    this.model = model;
    this.log = log;
    this.proc = null;
    this.ready = null;
  }

  get available() {
    return existsSync(this.model);
  }

  async ensure() {
    if (this.ready) return this.ready;
    if (!this.available) throw new Error(`speech model not found at ${this.model}; run: glancecode setup-voice`);
    this.ready = (async () => {
      if (await this.ping()) return; // already running (for example, a previous hub)
      this.proc = spawn("whisper-server", ["-m", this.model, "--host", "127.0.0.1", "--port", String(this.port), "-l", "en", "-nt", "-t", "6"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.proc.stderr.on("data", () => {});
      this.proc.on("exit", (code) => {
        this.log(`whisper-server exited (${code})`);
        this.proc = null;
        this.ready = null;
      });
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        if (await this.ping()) return;
        await sleep(300);
      }
      throw new Error("whisper-server did not start within 60s");
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async ping() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(800) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * @param {Buffer} pcm 16 kHz mono s16le
   * @param {string} vocabulary words to bias toward
   */
  async transcribe(pcm, vocabulary = "") {
    if (pcm.length < 16000 * 2 * 0.3) return { text: "", reason: "too short" };
    if (pcmLevel(pcm) < 0.0015) return { text: "", reason: "silent" }; // about -56 dBFS; whisper gets the quiet cases
    await this.ensure();
    const form = new FormData();
    form.append("file", new Blob([pcmToWav(pcm)], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (vocabulary) form.append("prompt", vocabulary);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`whisper-server ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return { text: cleanTranscript(body.text), ms: Date.now() - started };
  }

  stop() {
    this.proc?.kill();
  }
}
