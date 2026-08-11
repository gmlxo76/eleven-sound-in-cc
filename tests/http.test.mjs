import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dispatcher = join(here, "..", "scripts", "eleven-sound.mjs");

function runSfx(args, fixture, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eleven-test-"));
  const fixturePath = join(dir, "fixture.mjs");
  writeFileSync(fixturePath, fixture);
  const res = spawnSync(process.execPath, [dispatcher, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ELEVENLABS_API_KEY: "test-key-123456789",
      ELEVEN_TEST_FIXTURE: fixturePath,
      ...env
    }
  });
  return { ...res, dir };
}

// A fixture that asserts request shape and returns 1s of silent PCM 44.1k.
const okPcmFixture = `
export async function fixtureFetch(url, init) {
  const u = new URL(url);
  const body = JSON.parse(init.body);
  if (u.pathname !== "/v1/sound-generation") return { ok: false, status: 404, text: async () => "not found" };
  if (init.headers["xi-api-key"] !== "test-key-123456789") return { ok: false, status: 401, text: async () => "bad key" };
  if (body.model_id !== "eleven_text_to_sound_v2") return { ok: false, status: 422, text: async () => "bad model" };
  const fmt = u.searchParams.get("output_format");
  if (!fmt.startsWith("pcm_")) return { ok: false, status: 422, text: async () => "expected pcm" };
  const rate = parseInt(fmt.split("_")[1], 10);
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(rate * 2) };
}
`;

test("sfx: happy path — PCM wrapped to WAV, SAVED printed, body fields correct", () => {
  const r = runSfx(["sfx", "heavy", "rain", "--duration", "3", "--loop", "--output", "rain.wav"], okPcmFixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SAVED: .*rain\.wav \(format=pcm_44100, loop, 3s\)/);
  assert.match(r.stdout, /loop output — auto-trim skipped/);
  const wav = readFileSync(join(r.dir, "rain.wav"));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 44100);
});

test("sfx: tier fallback pcm_44100 → pcm_24000", () => {
  const fixture = `
export async function fixtureFetch(url, init) {
  const u = new URL(url);
  const fmt = u.searchParams.get("output_format");
  if (fmt === "pcm_44100") return { ok: false, status: 403, text: async () => "output_format not available on your tier" };
  if (fmt === "pcm_24000") return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(24000 * 2) };
  return { ok: false, status: 422, text: async () => "unexpected " + fmt };
}
`;
  const r = runSfx(["sfx", "wind", "--output", "wind.wav"], fixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pcm_44100 rejected \(tier\)/);
  const wav = readFileSync(join(r.dir, "wind.wav"));
  assert.equal(wav.readUInt32LE(24), 24000);
});

test("sfx: full fallback to mp3 saves .mp3 with notice", () => {
  const fixture = `
export async function fixtureFetch(url, init) {
  const u = new URL(url);
  const fmt = u.searchParams.get("output_format");
  if (fmt.startsWith("pcm_")) return { ok: false, status: 403, text: async () => "upgrade your subscription" };
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1000) };
}
`;
  const r = runSfx(["sfx", "beep", "--output", "beep.wav"], fixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SAVED: .*beep\.mp3/);
  assert.match(r.stderr, /saved as MP3 instead/);
  assert.ok(existsSync(join(r.dir, "beep.mp3")));
});

test("sfx: 401 exits 2 with hint", () => {
  const fixture = `
export async function fixtureFetch() {
  return { ok: false, status: 401, text: async () => "invalid api key" };
}
`;
  const r = runSfx(["sfx", "beep"], fixture);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Key rejected/);
});

test("sfx: out-of-range duration exits 4 before any HTTP", () => {
  const fixture = `export async function fixtureFetch() { throw new Error("must not be called"); }`;
  const r = runSfx(["sfx", "beep", "--duration", "45"], fixture);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /out of range/);
});

test("sfx: --count 3 saves _1.._3", () => {
  const r = runSfx(["sfx", "slash", "--count", "3", "--output", "hit.wav"], okPcmFixture);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(r.dir).filter(f => f.endsWith(".wav")).sort();
  assert.deepEqual(files, ["hit_1.wav", "hit_2.wav", "hit_3.wav"]);
});

test("sfx: no key exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "eleven-test-"));
  const res = spawnSync(process.execPath, [dispatcher, "sfx", "beep"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ELEVENLABS_API_KEY: "", ELEVEN_SOUND_CONFIG_DIR: join(dir, "no-config") }
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no API key/);
});
