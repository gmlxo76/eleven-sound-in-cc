# Changelog

## 0.1.0 — 2026-08-11

Initial release.

- `sfx` dispatcher subcommand wrapping ElevenLabs `POST /v1/sound-generation` (model `eleven_text_to_sound_v2`): `--duration` (0.5–30 s, omit = auto), `--loop` (native seamless loop), `--influence` (prompt_influence 0–1), `--count` (N independent variations `_1.._N`), `--format wav|mp3`.
- WAV pipeline: requests PCM, wraps headerless mono s16le into a canonical RIFF header; tier fallback `pcm_44100` → `pcm_24000` → `mp3_44100_128` with user-visible notices, locked in after the first successful rung.
- Auto-trim of trailing silence (-60 dBFS / 50 ms tail) for non-loop outputs; **skipped for loops** to preserve the seamless loop point. `trim-silence` subcommand for one-off trims (mono + stereo PCM-16).
- `status` with live non-billable key check (`GET /v1/user`): tier + credit usage.
- `config-set/show/clear` — key at `%APPDATA%\eleven-sound-in-cc\config.json` (or XDG), `ELEVENLABS_API_KEY` env override.
- Skills: `create` (duration/loop decision table per sound type + English prompting rules), `config`, `status`, `trim`.
- Tests: pure-function suite + spawned-dispatcher HTTP suite via `ELEVEN_TEST_FIXTURE` fixture fetch (no network).
