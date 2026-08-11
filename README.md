# eleven-sound-in-cc

Claude Code plugin that wraps the **ElevenLabs Sound Effects API** (`POST /v1/sound-generation`) as slash commands with agent-routed dispatch.

The point of this plugin is not the HTTP call — it's the **judgment layer** in `/eleven-sound:create`: the agent decides duration (0.5–30 s or model-auto), whether the sound must be a **seamless loop** (charge-ups, ambience, alarms), prompt influence, and variation count from the *type* of sound you describe, then writes a realism-anchored English prompt that avoids the failure modes that produce retro-sounding or silent output.

## Commands

| Command | What it does |
|---|---|
| `/eleven-sound:create <describe the sound>` | Text → SFX. Agent decides duration/loop/count, prompts in English, saves WAV. |
| `/eleven-sound:config [<key> \| clear]` | Save / show / clear the ElevenLabs API key. |
| `/eleven-sound:status` | Node + plugin versions, key state, live key check, tier, credit usage. |
| `/eleven-sound:trim <file.wav>` | One-off trailing-silence trim (auto-runs after every non-loop create). |

## Install

```
/plugin marketplace add gmlxo76/eleven-sound-in-cc
/plugin install eleven-sound@eleven-sound-in-cc
```

Then set your key (elevenlabs.io → Profile → API Keys):

```
/eleven-sound:config sk_...
/eleven-sound:status
```

## What the dispatcher encodes (API facts)

- `duration_seconds`: 0.5–30, omit → the model picks a natural length.
- `loop: true`: native seamless looping (`eleven_text_to_sound_v2`). Loop outputs are **never auto-trimmed** — trimming breaks the loop point.
- `prompt_influence`: 0–1 (default 0.3); higher = stricter prompt adherence.
- `output_format` tier fallback for WAV requests: `pcm_44100` (Pro+) → `pcm_24000` → `mp3_44100_128` (all tiers, saved as `.mp3` with a notice). PCM responses are headerless mono s16le; the dispatcher wraps them into a canonical RIFF/WAVE header.
- Variations (`--count N`) are N independent generations saved `_1.._N`.
- One-shot outputs get trailing silence auto-trimmed (-60 dBFS, 50 ms tail buffer).

## Prompting rules baked into the create skill

1. One short, concrete English sentence.
2. Realism anchor first ("a steel katana blade", "heavy rain on a tin roof") — unanchored prompts drift retro/synthetic.
3. No onomatopoeia in quotes, no game jargon, no negations — these cause drift or silence.
4. Duration and looping go in flags, never in the prompt text.

## Development

```
npm test                 # node --test tests/*.test.mjs (no network — fixture fetch)
npm run validate:plugin  # claude plugin validate .
```

## License

Apache-2.0
