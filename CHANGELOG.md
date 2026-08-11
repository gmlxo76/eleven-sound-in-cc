# Changelog

## 0.1.2 — 2026-08-11

- `create` skill: **always require an explicit `--duration`** — omitting it makes the model fill ~4 seconds even for a quick melee slash (verified generating katana one-shots), and auto-trim can't rescue tails with steady content above the -60 dBFS gate. Decision table updated with explicit ranges.

## 0.1.1 — 2026-08-11

- Fix: replace every post-fetch `process.exit()` with `process.exitCode` + natural drain — exiting while undici keep-alive sockets were closing crashed Node on Windows (`uv async.c` assertion), turning successful runs into exit 127.
- `status`: surface the API error body's `detail.message` on a failed key check (e.g. the "API key ID used as API key" case) instead of a generic hint.
- `sfx`: 400/401 error hint now explains that real keys start with `sk_` and are shown only once at creation — the hex ID in the key list is not the key.

## 0.1.0 — 2026-08-11

Initial release.

- `sfx` dispatcher subcommand wrapping ElevenLabs `POST /v1/sound-generation` (model `eleven_text_to_sound_v2`): `--duration` (0.5–30 s, omit = auto), `--loop` (native seamless loop), `--influence` (prompt_influence 0–1), `--count` (N independent variations `_1.._N`), `--format wav|mp3`.
- WAV pipeline: requests PCM, wraps headerless mono s16le into a canonical RIFF header; tier fallback `pcm_44100` → `pcm_24000` → `mp3_44100_128` with user-visible notices, locked in after the first successful rung.
- Auto-trim of trailing silence (-60 dBFS / 50 ms tail) for non-loop outputs; **skipped for loops** to preserve the seamless loop point. `trim-silence` subcommand for one-off trims (mono + stereo PCM-16).
- `status` with live non-billable key check (`GET /v1/user`): tier + credit usage.
- `config-set/show/clear` — key at `%APPDATA%\eleven-sound-in-cc\config.json` (or XDG), `ELEVENLABS_API_KEY` env override.
- Skills: `create` (duration/loop decision table per sound type + English prompting rules), `config`, `status`, `trim`.
- Tests: pure-function suite + spawned-dispatcher HTTP suite via `ELEVEN_TEST_FIXTURE` fixture fetch (no network).
