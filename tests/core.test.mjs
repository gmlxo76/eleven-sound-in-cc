import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlags,
  validateDuration,
  validateInfluence,
  wrapPcmToWav,
  trimTrailingSilence,
  resolveOutputPathSeries,
  UnsupportedFormatError
} from "../scripts/eleven-sound.mjs";

// ---- parseFlags ----------------------------------------------------------

test("parseFlags: positional + valued + boolean flags", () => {
  const { positional, flags } = parseFlags(["a", "heavy", "rain", "--duration", "3", "--loop", "--output", "x.wav"]);
  assert.deepEqual(positional, ["a", "heavy", "rain"]);
  assert.equal(flags.duration, "3");
  assert.equal(flags.loop, true);
  assert.equal(flags.output, "x.wav");
});

test("parseFlags: flag at end with no value is boolean", () => {
  const { flags } = parseFlags(["--loop"]);
  assert.equal(flags.loop, true);
});

// ---- validation ----------------------------------------------------------

test("validateDuration: omitted → null (auto)", () => {
  assert.equal(validateDuration(undefined), null);
  assert.equal(validateDuration(true), null);
});

test("validateDuration: accepts API range 0.5–30", () => {
  assert.equal(validateDuration("0.5"), 0.5);
  assert.equal(validateDuration("30"), 30);
  assert.equal(validateDuration("3.25"), 3.25);
});

test("validateDuration: rejects out-of-range and non-numeric", () => {
  assert.throws(() => validateDuration("0.4"));
  assert.throws(() => validateDuration("31"));
  assert.throws(() => validateDuration("abc"));
});

test("validateInfluence: default 0.3, range 0–1", () => {
  assert.equal(validateInfluence(undefined), 0.3);
  assert.equal(validateInfluence("0.7"), 0.7);
  assert.throws(() => validateInfluence("1.5"));
  assert.throws(() => validateInfluence("-0.1"));
});

// ---- wrapPcmToWav ----------------------------------------------------------

test("wrapPcmToWav: canonical 44-byte header, correct fields", () => {
  const pcm = Buffer.alloc(44100 * 2); // 1s mono s16le @44.1k
  const wav = wrapPcmToWav(pcm, 44100, 1);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.readUInt16LE(20), 1);        // PCM
  assert.equal(wav.readUInt16LE(22), 1);        // mono
  assert.equal(wav.readUInt32LE(24), 44100);    // rate
  assert.equal(wav.readUInt32LE(28), 88200);    // byte rate
  assert.equal(wav.readUInt16LE(32), 2);        // block align
  assert.equal(wav.readUInt16LE(34), 16);       // bits
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

// ---- trimTrailingSilence -----------------------------------------------------

function makeWav({ rate = 44100, channels = 1, loudFrames, silentFrames }) {
  const bytesPerFrame = 2 * channels;
  const pcm = Buffer.alloc((loudFrames + silentFrames) * bytesPerFrame);
  for (let i = 0; i < loudFrames; i++) {
    for (let c = 0; c < channels; c++) {
      pcm.writeInt16LE(10000, i * bytesPerFrame + c * 2);
    }
  }
  return wrapPcmToWav(pcm, rate, channels);
}

test("trim: cuts trailing silence on mono, keeps 50ms tail", () => {
  const rate = 44100;
  const wav = makeWav({ rate, loudFrames: rate, silentFrames: rate * 2 }); // 1s loud + 2s silence
  const out = trimTrailingSilence(wav, {});
  const expectFrames = rate + Math.round((50 * rate) / 1000);
  assert.equal(out.readUInt32LE(40), expectFrames * 2);
  assert.equal(out.length, 44 + expectFrames * 2);
});

test("trim: stereo supported, loudest channel wins", () => {
  const rate = 24000;
  const wav = makeWav({ rate, channels: 2, loudFrames: rate, silentFrames: rate });
  const out = trimTrailingSilence(wav, {});
  const expectFrames = rate + Math.round((50 * rate) / 1000);
  assert.equal(out.readUInt32LE(40), expectFrames * 4);
});

test("trim: no-op when already tight", () => {
  const wav = makeWav({ loudFrames: 44100, silentFrames: 0 });
  const out = trimTrailingSilence(wav, {});
  assert.equal(out.length, wav.length);
});

test("trim: rejects non-WAV", () => {
  assert.throws(() => trimTrailingSilence(Buffer.alloc(100, 7), {}), UnsupportedFormatError);
});

// ---- output path series --------------------------------------------------------

test("resolveOutputPathSeries: count>1 with base → _1.._N suffixes", () => {
  const paths = resolveOutputPathSeries("out/SFX_Skill_550_Attack.wav", 3);
  assert.equal(paths.length, 3);
  assert.match(paths[0].replace(/\\/g, "/"), /out\/SFX_Skill_550_Attack_1\.wav$/);
  assert.match(paths[2].replace(/\\/g, "/"), /out\/SFX_Skill_550_Attack_3\.wav$/);
});

test("resolveOutputPathSeries: count=1 keeps exact name", () => {
  const paths = resolveOutputPathSeries("out/one.wav", 1);
  assert.equal(paths.length, 1);
  assert.match(paths[0].replace(/\\/g, "/"), /out\/one\.wav$/);
});

test("resolveOutputPathSeries: no base → default eleven-sounds dir with ext", () => {
  const paths = resolveOutputPathSeries(null, 2, ".mp3");
  assert.equal(paths.length, 2);
  assert.match(paths[0].replace(/\\/g, "/"), /eleven-sounds\/.+-1\.mp3$/);
});
