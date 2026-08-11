#!/usr/bin/env node
/*
  eleven-sound-in-cc dispatcher

  Single entry point wrapping the ElevenLabs Sound Effects API
  (POST /v1/sound-generation). Each handler is atomic — build request,
  POST, decode audio bytes, write file. No intelligence; routing and
  duration/loop decisions live in skills/create/SKILL.md (read by the
  Claude Code agent).

  API facts this file encodes (verified against the ElevenLabs API reference):
    - endpoint:        POST https://api.elevenlabs.io/v1/sound-generation
    - auth header:     xi-api-key
    - body:            text (required), duration_seconds (0.5–30, null = auto),
                       prompt_influence (0–1, default 0.3),
                       loop (bool, eleven_text_to_sound_v2 only),
                       model_id (only eleven_text_to_sound_v2)
    - query:           output_format — pcm_44100 needs Pro+, mp3_44100_192 needs
                       Creator+; mp3_44100_128 available on all tiers.
    - PCM responses are raw 16-bit little-endian samples (no header). For
      sound-generation they are STEREO interleaved — this dispatcher wraps
      them into a canonical 44-byte RIFF/WAVE header as 2-channel audio.
*/

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, basename, extname, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- Config file ---------------------------------------------------------

function configDir() {
  if (process.env.ELEVEN_SOUND_CONFIG_DIR) return process.env.ELEVEN_SOUND_CONFIG_DIR;
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "eleven-sound-in-cc");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "eleven-sound-in-cc");
}

function configFile() { return join(configDir(), "config.json"); }

function readConfigFile() {
  const f = configFile();
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return null; }
}

function writeConfigFile(obj) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const f = configFile();
  writeFileSync(f, JSON.stringify(obj, null, 2));
  if (platform() !== "win32") {
    try { chmodSync(f, 0o600); } catch { /* best effort */ }
  }
}

function maskKey(key) {
  if (!key) return "(none)";
  const tail = key.slice(-4);
  const head = key.slice(0, 3);
  const middleLen = Math.max(8, key.length - 7);
  return `${head}${"*".repeat(middleLen)}${tail}`;
}

export function resolveKey() {
  const env = (process.env.ELEVENLABS_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
  if (env) return { key: env, source: "env" };
  const cfg = readConfigFile();
  if (cfg && cfg.elevenlabs_api_key) return { key: cfg.elevenlabs_api_key.trim(), source: "config-file" };
  return { key: null, source: "none" };
}

async function cmdConfigShow() {
  const { key, source } = resolveKey();
  process.stdout.write(`source: ${source}\nkey: ${maskKey(key)}\n`);
  process.exitCode = 0;
}

async function cmdConfigSet(args) {
  const key = (args[0] || "").trim();
  if (!key) {
    process.stderr.write("Usage: config-set <api-key>\n");
    process.exitCode = 2;
    return;
  }
  writeConfigFile({ elevenlabs_api_key: key, saved_at: new Date().toISOString() });
  process.stdout.write(`saved\nkey: ${maskKey(key)}\nfile: ${configFile()}\n`);
  process.exitCode = 0;
}

async function cmdConfigClear() {
  const f = configFile();
  if (existsSync(f)) rmSync(f);
  process.stdout.write(`cleared\nfile: ${f}\n`);
  process.exitCode = 0;
}

// ---- status ---------------------------------------------------------------

function pluginVersion() {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

async function cmdStatus() {
  const { key, source } = resolveKey();
  const lines = [
    `Node:           ${process.version} / ${process.platform} ${process.arch}`,
    `Plugin:         eleven-sound-in-cc@${pluginVersion()}`,
    `API key source: ${source}`,
    `Key (masked):   ${maskKey(key)}`,
    `Ready:          ${key ? "yes" : "no"}`
  ];
  // Live (non-billable) key check: GET /v1/user returns subscription info.
  if (key) {
    try {
      const doFetch = await getFetch();
      const res = await doFetch(`${BASE_URL}/v1/user`, {
        method: "GET",
        headers: { "xi-api-key": key }
      });
      if (res.ok) {
        const u = await res.json();
        const sub = u.subscription || {};
        lines.push(`API check:      OK (key valid)`);
        if (sub.tier) lines.push(`Tier:           ${sub.tier}`);
        if (typeof sub.character_count === "number" && typeof sub.character_limit === "number") {
          lines.push(`Credits:        ${sub.character_count} / ${sub.character_limit} used`);
        }
      } else {
        let hint = "key may be invalid or revoked";
        try {
          const err = await res.json();
          if (err?.detail?.message) hint = err.detail.message;
        } catch { /* keep generic hint */ }
        lines.push(`API check:      FAILED (HTTP ${res.status}) — ${hint}`);
      }
    } catch (e) {
      lines.push(`API check:      skipped (network: ${e.message})`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exitCode = 0;
}

// ---- WAV utilities ---------------------------------------------------------

export class UnsupportedFormatError extends Error {}

/**
 * Wrap raw 16-bit little-endian PCM samples into a canonical 44-byte
 * RIFF/WAVE container. ElevenLabs pcm_* responses are headerless mono s16le.
 */
export function wrapPcmToWav(pcmBuf, sampleRate, numChannels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);              // fmt chunk size
  header.writeUInt16LE(1, 20);               // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
}

/**
 * Trim trailing silence from a canonical PCM 16-bit WAV (mono or stereo).
 * NEVER call this on a seamless-loop file — cutting the tail breaks the loop
 * point. The sfx command skips auto-trim automatically when --loop is set.
 */
export function trimTrailingSilence(buf, opts = {}) {
  const thresholdDb = opts.thresholdDb ?? -60;
  const tailMs = opts.tailMs ?? 50;

  if (buf.length < 44) return buf;

  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new UnsupportedFormatError("not a RIFF/WAVE file");
  }
  if (buf.toString("ascii", 12, 16) !== "fmt ") {
    throw new UnsupportedFormatError("fmt chunk not at offset 12 (non-canonical WAV layout)");
  }
  const audioFormat = buf.readUInt16LE(20);
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (audioFormat !== 1) throw new UnsupportedFormatError(`audio format ${audioFormat} (PCM only)`);
  if (bitsPerSample !== 16) throw new UnsupportedFormatError(`${bitsPerSample}-bit (16-bit only)`);
  if (numChannels !== 1 && numChannels !== 2) {
    throw new UnsupportedFormatError(`${numChannels}-channel (mono/stereo only)`);
  }
  if (buf.toString("ascii", 36, 40) !== "data") {
    throw new UnsupportedFormatError("data chunk not at offset 36");
  }
  const dataSize = buf.readUInt32LE(40);
  const headerLen = 44;
  const audioLen = Math.min(dataSize, buf.length - headerLen);
  const bytesPerFrame = 2 * numChannels;
  const totalFrames = Math.floor(audioLen / bytesPerFrame);

  if (totalFrames === 0) return buf;

  const thresholdSample = Math.max(1, Math.round(32768 * Math.pow(10, thresholdDb / 20)));

  // Scan backwards for the last frame whose loudest channel is above threshold
  let lastSignificant = -1;
  for (let i = totalFrames - 1; i >= 0; i--) {
    let frameMax = 0;
    for (let c = 0; c < numChannels; c++) {
      const s = Math.abs(buf.readInt16LE(headerLen + i * bytesPerFrame + c * 2));
      if (s > frameMax) frameMax = s;
    }
    if (frameMax >= thresholdSample) {
      lastSignificant = i;
      break;
    }
  }

  const tailFrames = Math.round((tailMs * sampleRate) / 1000);
  const minFrames = Math.round((100 * sampleRate) / 1000); // 100ms minimum
  let keepFrames;

  if (lastSignificant === -1) {
    keepFrames = Math.min(minFrames, totalFrames);
  } else {
    keepFrames = Math.min(totalFrames, lastSignificant + 1 + tailFrames);
  }

  if (keepFrames === totalFrames) return buf;

  const newDataSize = keepFrames * bytesPerFrame;
  const newHeader = Buffer.from(buf.slice(0, headerLen));
  newHeader.writeUInt32LE(36 + newDataSize, 4);
  newHeader.writeUInt32LE(newDataSize, 40);
  const newAudio = buf.slice(headerLen, headerLen + newDataSize);
  return Buffer.concat([newHeader, newAudio]);
}

function applyAutoTrim(paths, flags) {
  if (flags["no-trim-silence"]) return;
  const thresholdDb = parseFloat(flags["silence-threshold-db"] || "-60");
  const tailMs = parseInt(flags["silence-tail-ms"] || "50", 10);
  for (const path of paths) {
    if (extname(path).toLowerCase() !== ".wav") continue;
    let buf;
    try { buf = readFileSync(path); } catch { continue; }
    let trimmed;
    try {
      trimmed = trimTrailingSilence(buf, { thresholdDb, tailMs });
    } catch (e) {
      if (e instanceof UnsupportedFormatError) {
        process.stderr.write(`trim-silence skipped for ${path}: ${e.message}\n`);
      }
      continue;
    }
    if (trimmed.length !== buf.length) {
      writeFileSync(path, trimmed);
      process.stdout.write(`TRIMMED: ${path} (${buf.length} → ${trimmed.length} bytes)\n`);
    }
  }
}

// ---- Output filename resolution --------------------------------------------

function defaultOutputPath(index = 0, ext = ".wav") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(".", "eleven-sounds", `${ts}-${index + 1}${ext}`);
}

export function resolveOutputPath(p, ctx) {
  if (!p) return defaultOutputPath((ctx && ctx.index) || 0, (ctx && ctx.ext) || ".wav");
  if (!existsSync(p)) return p;
  const dir = dirname(p);
  const ext = extname(p);
  const stem = basename(p, ext);
  for (let v = 2; v < 1000; v++) {
    const cand = join(dir, `${stem}-v${v}${ext}`);
    if (!existsSync(cand)) return cand;
  }
  throw new Error("too many filename collisions");
}

export function resolveOutputPathSeries(base, count, ext = ".wav") {
  if (count <= 1) {
    return [resolveOutputPath(base, { ext })];
  }
  if (!base) {
    const paths = [];
    for (let i = 0; i < count; i++) paths.push(defaultOutputPath(i, ext));
    return paths;
  }
  const dir = dirname(base);
  const baseExt = extname(base) || ext;
  const stem = basename(base, baseExt);
  return Array.from({ length: count }, (_, i) =>
    resolveOutputPath(join(dir, `${stem}_${i + 1}${baseExt}`))
  );
}

function swapExt(p, newExt) {
  const dir = dirname(p);
  const stem = basename(p, extname(p));
  return resolveOutputPath(join(dir, `${stem}${newExt}`));
}

// ---- Arg / flag parsing -----------------------------------------------------

export function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** duration_seconds must be 0.5–30 (API-enforced range) or absent (auto). */
export function validateDuration(raw) {
  if (raw === undefined || raw === null || raw === true) return null;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) throw new Error(`--duration "${raw}" is not a number`);
  if (v < 0.5 || v > 30) throw new Error(`--duration ${v} out of range (0.5–30 seconds)`);
  return v;
}

export function validateInfluence(raw) {
  if (raw === undefined || raw === null || raw === true) return 0.3;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`--influence "${raw}" out of range (0–1)`);
  return v;
}

// ---- Fetch loader (test fixture support via env var) -------------------------

async function getFetch() {
  if (process.env.ELEVEN_TEST_FIXTURE) {
    const url = pathToFileURL(process.env.ELEVEN_TEST_FIXTURE).href;
    const mod = await import(url);
    return mod.fixtureFetch;
  }
  return globalThis.fetch;
}

// ---- HTTP -------------------------------------------------------------------

export const BASE_URL = process.env.ELEVEN_BASE_URL || "https://api.elevenlabs.io";

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Sets process.exitCode instead of calling process.exit() — exiting while
// undici keep-alive sockets are still closing crashes Node on Windows
// (uv async.c assertion), which turns successful runs into exit 127.
function exitForHttpError(err) {
  if (!(err instanceof HttpError)) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 99;
    return;
  }
  const map = { 401: 2, 403: 2, 400: 3, 422: 4, 429: 5, 500: 5, 0: 6 };
  const code = map[err.status] ?? 99;
  process.stderr.write(`HTTP ${err.status}: ${err.body}\n`);
  if (err.status === 401 || err.status === 400) {
    process.stderr.write("Key rejected. Real ElevenLabs keys start with 'sk_' and are shown ONCE at creation — the hex ID in the key list is NOT the key. Create/rotate at elevenlabs.io → API Keys, then run config-set.\n");
  }
  process.exitCode = code;
}

/** One sound-generation call. Returns raw audio bytes for the given output_format. */
async function callSoundGeneration(body, outputFormat, key, doFetch, retryDelayMs = 5000) {
  const url = `${BASE_URL}/v1/sound-generation?output_format=${encodeURIComponent(outputFormat)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (attempt === 2) throw new HttpError(0, `network: ${e.message}`);
      await sleep(retryDelayMs);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * Tier-related rejection of an output_format (pcm_44100 = Pro+,
 * mp3_44100_192 = Creator+). Detected loosely from status + body text so the
 * fallback chain can degrade instead of failing the whole generation.
 */
function isFormatTierError(err) {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 403) return true;
  if (err.status === 400 || err.status === 422) {
    return /output_format|tier|upgrade|subscription|not available/i.test(err.body || "");
  }
  return false;
}

// WAV request degrades through this chain; each entry = [output_format, kind]
const WAV_FORMAT_CHAIN = [
  ["pcm_44100", "pcm"],   // Pro+ tier
  ["pcm_24000", "pcm"],   // lower tiers
  ["mp3_44100_128", "mp3"] // always available — saved as .mp3 with a notice
];

// ---- sfx (the one generation subcommand) --------------------------------------

async function cmdSfx(argv) {
  const { positional, flags } = parseFlags(argv);
  const text = positional.join(" ").trim();
  if (!text) {
    process.stderr.write("sfx: <text prompt> required\n");
    process.exitCode = 2;
    return;
  }
  const { key } = resolveKey();
  if (!key) {
    process.stderr.write("no API key. Run config-set <key> or set ELEVENLABS_API_KEY.\n");
    process.exitCode = 1;
    return;
  }

  let duration, influence;
  try {
    duration = validateDuration(flags.duration);
    influence = validateInfluence(flags.influence);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 4;
    return;
  }
  const loop = !!flags.loop;
  const count = Math.max(1, Math.min(10, parseInt(flags.count || "1", 10) || 1));
  const format = String(flags.format || "wav").toLowerCase();
  if (format !== "wav" && format !== "mp3") {
    process.stderr.write(`--format ${format} unsupported (wav | mp3)\n`);
    process.exitCode = 4;
    return;
  }

  const body = {
    text,
    model_id: "eleven_text_to_sound_v2",
    prompt_influence: influence
  };
  if (duration !== null) body.duration_seconds = duration;
  if (loop) body.loop = true;

  const doFetch = await getFetch();
  const ext = format === "wav" ? ".wav" : ".mp3";
  const paths = resolveOutputPathSeries(flags.output || null, count, ext);
  const saved = [];

  // Remember which format actually worked so calls 2..N skip the failed rungs.
  let chain = format === "wav"
    ? (flags["output-format"] ? [[String(flags["output-format"]), String(flags["output-format"]).startsWith("pcm") ? "pcm" : "mp3"]] : WAV_FORMAT_CHAIN.slice())
    : [["mp3_44100_128", "mp3"]];

  try {
    for (let i = 0; i < count; i++) {
      let audio = null;
      let used = null;
      for (let f = 0; f < chain.length; f++) {
        const [fmt, kind] = chain[f];
        try {
          audio = await callSoundGeneration(body, fmt, key, doFetch);
          used = [fmt, kind];
          chain = chain.slice(f); // lock in for remaining variations
          break;
        } catch (e) {
          if (isFormatTierError(e) && f < chain.length - 1) {
            process.stderr.write(`output_format ${fmt} rejected (tier) — falling back to ${chain[f + 1][0]}\n`);
            continue;
          }
          throw e;
        }
      }

      const [fmt, kind] = used;
      let outPath = paths[i];
      let bytes = audio;
      if (kind === "pcm") {
        const rate = parseInt(fmt.split("_")[1], 10);
        // sound-generation PCM is STEREO interleaved s16le (verified: requested
        // duration matches at 2ch, and even/odd sample correlation ≈ 0.999).
        // Truncate to whole stereo frames before wrapping.
        const whole = audio.length - (audio.length % 4);
        bytes = wrapPcmToWav(whole === audio.length ? audio : audio.slice(0, whole), rate, 2);
        if (extname(outPath).toLowerCase() !== ".wav") outPath = swapExt(outPath, ".wav");
      } else if (extname(outPath).toLowerCase() !== ".mp3") {
        outPath = swapExt(outPath, ".mp3");
        if (format === "wav") {
          process.stderr.write(`NOTE: tier does not allow PCM — saved as MP3 instead (Unity imports MP3 fine).\n`);
        }
      }

      mkdirSync(dirname(pathResolve(outPath)), { recursive: true });
      writeFileSync(outPath, bytes);
      saved.push(outPath);
      process.stdout.write(`SAVED: ${pathResolve(outPath)} (format=${fmt}${loop ? ", loop" : ""}${duration !== null ? `, ${duration}s` : ", auto-length"})\n`);
    }
  } catch (e) {
    exitForHttpError(e);
    return;
  }

  // Seamless loops must keep their exact length — trimming breaks the loop point.
  if (loop) {
    if (!flags["no-trim-silence"]) {
      process.stdout.write("loop output — auto-trim skipped to preserve the seamless loop point\n");
    }
  } else {
    applyAutoTrim(saved, flags);
  }
  process.exitCode = 0;
}

// ---- trim-silence (explicit one-off) ------------------------------------------

async function cmdTrimSilence(argv) {
  const { positional, flags } = parseFlags(argv);
  const input = positional[0];
  if (!input || !existsSync(input)) {
    process.stderr.write("trim-silence: <input.wav> required (file not found)\n");
    process.exitCode = 2;
    return;
  }
  const thresholdDb = parseFloat(flags["threshold-db"] || "-60");
  const tailMs = parseInt(flags["tail-ms"] || "50", 10);
  const outPath = flags.output ? String(flags.output) : input;

  let buf;
  try { buf = readFileSync(input); }
  catch (e) {
    process.stderr.write(`read failed: ${e.message}\n`);
    process.exitCode = 2;
    return;
  }
  let trimmed;
  try {
    trimmed = trimTrailingSilence(buf, { thresholdDb, tailMs });
  } catch (e) {
    if (e instanceof UnsupportedFormatError) {
      process.stderr.write(`unsupported WAV: ${e.message}\n`);
      process.exitCode = 8;
      return;
    }
    throw e;
  }
  mkdirSync(dirname(pathResolve(outPath)), { recursive: true });
  writeFileSync(outPath, trimmed);
  if (trimmed.length !== buf.length) {
    process.stdout.write(`TRIMMED: ${pathResolve(outPath)} (${buf.length} → ${trimmed.length} bytes)\n`);
  } else {
    process.stdout.write(`NO-OP: nothing to trim (already tight)\n`);
  }
  process.stdout.write(`SAVED: ${pathResolve(outPath)}\n`);
  process.exitCode = 0;
}

// ---- main ----------------------------------------------------------------------

const USAGE = `Usage: eleven-sound.mjs <subcommand> [args...]

Diagnostic:
  status                          Node/plugin versions, key state, live key check
                                  (GET /v1/user — non-billable), tier + credit usage.

Config:
  config-show                     Show current API key state (masked).
  config-set <key>                Save API key to config file.
  config-clear                    Delete config file.

Generation (ElevenLabs POST /v1/sound-generation):
  sfx <text prompt>               [--output PATH] [--duration S] [--loop]
                                  [--influence F] [--count N] [--format wav|mp3]
                                  [--output-format RAW] [--no-trim-silence]
                                  [--silence-threshold-db F] [--silence-tail-ms N]
      --duration S    0.5–30 seconds. Omit → model picks a natural length.
      --loop          seamless loop (eleven_text_to_sound_v2). Auto-trim is
                      skipped for loops — trimming breaks the loop point.
      --influence F   prompt_influence 0–1 (default 0.3). Higher = stricter.
      --count N       N independent generations (variations), saved _1.._N.
      --format wav    request PCM and wrap to WAV (falls back pcm_44100 →
                      pcm_24000 → mp3_44100_128 if the account tier rejects).

Post-processing:
  trim-silence <input.wav>        [--output PATH] [--threshold-db F] [--tail-ms N]

Exit codes:
  0 success, 1 no key, 2 auth/missing-input, 3 bad-request, 4 validation,
  5 server/rate-limit, 6 network, 8 unsupported-wav, 99 unknown.
`;

const handlers = {
  "status": cmdStatus,
  "config-show": cmdConfigShow,
  "config-set": cmdConfigSet,
  "config-clear": cmdConfigClear,
  "sfx": cmdSfx,
  "trim-silence": cmdTrimSilence
};

const isMain = process.argv[1] && pathToFileURL(pathResolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const sub = process.argv[2];
  const handler = handlers[sub];
  if (!handler) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  handler(process.argv.slice(3)).catch(e => {
    process.stderr.write(`${e.stack || e.message}\n`);
    process.exitCode = 99;
  });
}
