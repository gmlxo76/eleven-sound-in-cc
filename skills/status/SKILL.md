---
description: Diagnostic for eleven-sound-in-cc — Node version, plugin version, API key state, live key check, tier and credit usage
allowed-tools: Bash(node:*)
---

# Status (eleven-sound)

Reports Node version, plugin version, API key resolution source (env / config-file / none), masked key tail, and — when a key is present — a **live, non-billable** key check (`GET /v1/user`) showing the ElevenLabs subscription tier and credit usage.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" status
```

Show the dispatcher stdout to the user verbatim. Interpret for the user:

- `Ready: no` → *"No API key configured. Run `/eleven-sound:config <your-key>` or set `ELEVENLABS_API_KEY`."*
- `API check: FAILED (HTTP 401)` → key was saved but is invalid/revoked; re-issue at elevenlabs.io → API Keys.
- `Credits: X / Y used` → each SFX generation bills credits; explicit durations bill proportionally to length. If X is near Y, warn before large `--count` batches.
- `Tier:` below Pro → WAV requests will fall back to `pcm_24000` or MP3 automatically (the create skill surfaces the NOTE when it happens).
