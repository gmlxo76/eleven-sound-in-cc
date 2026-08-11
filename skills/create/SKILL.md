---
description: Generate game SFX via ElevenLabs Sound Effects API — you decide duration (0.5–30s or auto), looping, prompt-influence, and variation count from the sound type, then write a realism-anchored English prompt
argument-hint: '<natural language: what sound, for what, where to save>'
allowed-tools: Bash(node:*)
---

# Create (eleven-sound)

The single user-facing command for SFX generation. The user describes a sound in any language; **you** (the Claude Code agent) decide the API parameters — duration, loop, influence, count — from the *type* of sound, write a proper English prompt, and call the dispatcher.

## Step 1 — Parse `$ARGUMENTS`

1. If `$ARGUMENTS` begins with `[Image #N]`, strip it and warn: *"eleven-sound generates audio from text only."*
2. Extract from the natural language:
   - **What sound** (the subject — becomes the English prompt, see §3)
   - **Explicit duration** (`3초`, `3s`, `3 seconds`) → `--duration 3`
   - **Explicit loop cue** (`루프`, `반복`, `끊김 없이`, `loop`, `seamless`, `ambience`) → `--loop`
   - **Variation count** (`3개`, `3가지`, `3 variations`) → `--count 3`
   - **Output path** (`~에 저장`, `save to X`, a `.wav`/`.mp3` path) → `--output PATH`
   - **Fidelity cue** (`정확히 이대로`, `프롬프트 그대로`, `exactly`) → `--influence 0.7`

## Step 2 — Decide duration + loop when NOT explicit (the core judgment)

The API accepts `duration_seconds` 0.5–30 (omit = model picks a natural length) and native seamless `loop`. Decide from the sound's *role in the game*:

| Sound type | Duration | Loop | Reasoning |
|---|---|---|---|
| UI click / beep / pickup | 0.5–1.0 | no | one-shot, tight |
| Single gunshot / melee swing / whoosh / impact / footstep | **omit** (auto) or 1.0–1.5 | no | model picks natural attack+tail |
| Reload / mechanical action (bolt, pump, latch) | 1.0–2.0 | no | multi-stage but finite |
| Explosion / shell impact (with debris tail) | 2.0–3.0 | no | needs decay room |
| Skill charge-up / channeling / beam / aura hold | 2.0–4.0 | **yes** | held for unknown time in-game → seamless loop |
| Alarm / siren / warning pulse | 2.0–4.0 | **yes** | repeats until dismissed |
| Ambience (rain, wind, room tone, crowd, machinery hum) | 10–20 | **yes** | long bed, loops in-engine |
| Stinger / jingle / result fanfare | 2.0–4.0 | no | musical one-shot |
| Voice-like grunt / monster vocal | **omit** (auto) | no | natural phrasing |

Rules of thumb:
- **When unsure for a one-shot: omit `--duration`** — the model picks a natural length, and auto-trim cleans the tail.
- **Anything the game holds for an indeterminate time = `--loop`.** Loops need *steady-state* sound: describe a continuous texture ("continuous", "steady", "sustained") and avoid distinct attack/impact words, or the loop point will be audible.
- Loop + duration: give loops an explicit duration (2–4s for effects, 10–20s for ambience) so the file size fits its use.
- Announce your decision in one line before dispatching, e.g. *"차징 유지음이니 3초 시머리스 루프로 생성합니다."*

## Step 3 — Write the English prompt (hard-learned rules)

The `text` body param is the prompt. These rules come from real failures (retro/8-bit drift, silent outputs):

1. **One short, concrete English sentence.** Long meta-sentences produce silence or mush.
2. **Realism anchor first**: name the physical source — "a steel katana blade", "a 60mm mortar tube", "heavy rain on a tin roof". Unanchored prompts drift retro/synthetic.
3. **NO onomatopoeia in quotes** ("whoosh!", "쾅"), **NO game jargon** (crit, buff, skill, HP), **NO negations** ("no music", "without voices") — all three cause drift or silence.
4. Duration and looping go in **flags, not prose** — never write "3 seconds long" or "seamlessly looping" inside the prompt.
5. Describe character with 1–2 adjectives max: "sharp metallic", "deep sub-bass", "wet organic".

Good: `A sharp steel katana slash cutting through air, quick metallic ring`
Bad: `An epic 3-second looping sword skill sound effect with no music, "shing!"`

## Step 4 — Build the dispatcher call

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" sfx <english prompt> [flags]
```

| Flag | Meaning |
|---|---|
| `--output PATH` | target file. Omit → `./eleven-sounds/<UTC>-<n>.wav`. Collisions auto-version `-v2`. |
| `--duration S` | 0.5–30. Omit = model auto-length. |
| `--loop` | native seamless loop (v2 model). |
| `--influence F` | prompt_influence 0–1, default 0.3. 0.6–0.8 when user wants literal adherence. |
| `--count N` | N independent generations saved `_1.._N` — use for "3가지 뽑아줘" / hit-variation sets. |
| `--format wav` | (default) requests PCM, wraps to WAV. Tier fallback: `pcm_44100` → `pcm_24000` → `mp3_44100_128` (saved `.mp3` + notice). `--format mp3` for direct MP3. |

Each success prints `SAVED: <abs path> (format=..., ...)`. Surface those lines and any `TRIMMED:`/`NOTE:` lines to the user.

## Step 5 — Auto post-processing

- **One-shots**: trailing silence is auto-trimmed (-60 dBFS threshold, 50 ms tail buffer). Opt out with `--no-trim-silence` (`원본 그대로`, `raw`). Tune: `--silence-threshold-db -50` (더 잘라) / `-70` (덜 잘라), `--silence-tail-ms 200` (리버브 살려).
- **Loops**: auto-trim is **skipped by the dispatcher** — trimming would break the seamless loop point. Don't "fix" this.

## Edge cases

| Situation | Do |
|---|---|
| No key | Dispatcher exits 1. Say: *"Run `/eleven-sound:config <key>` first."* |
| 401 | Exit 2 — key invalid/revoked; suggest re-entering. |
| 422 on duration | Exit 4 — you passed out-of-range duration; fix to 0.5–30. |
| 429 / 5xx | Dispatcher already retried once; exit 5. Wait and retry, or reduce `--count`. |
| Tier rejects PCM | Dispatcher falls back automatically and prints a NOTE — just surface it. |
| User asks for music / voice lines | This endpoint is SFX-only. Suggest ElevenLabs Music/TTS separately. |
| Batch request (여러 사운드 목록) | One `sfx` call per sound, sequentially; each gets its own decided duration/loop. |

## Cost note

Every generation (each `--count` unit) bills credits against the ElevenLabs quota; explicit `duration_seconds` bills proportionally to length. For long ambience loops (10–20s), confirm quota with `/eleven-sound:status` if the user is worried.

## Unity note

WAV (PCM) drops straight into `Assets/`. For loop clips, the file loops cleanly as-is — set the AudioSource to Loop; don't re-trim in an editor. MP3 fallback imports fine but decodes on load; prefer WAV for short SFX.
