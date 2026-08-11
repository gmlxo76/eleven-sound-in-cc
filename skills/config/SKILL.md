---
description: Manage ElevenLabs API key for eleven-sound — save, show, or clear
argument-hint: '[<api-key> | clear]'
allowed-tools: Bash(node:*)
---

# Config (eleven-sound)

Manage the ElevenLabs API key used by every `create` call.

## Three forms

Parse `$ARGUMENTS`:

- **Empty** → call `config-show`.
- **Single token equal to `clear`** (case-insensitive) → call `config-clear`.
- **Anything else** (typically a key like `sk_...` or a 32-hex `xi-api-key`) → call `config-set` with it.

```bash
# Show current state (masked):
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" config-show

# Save a key:
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" config-set "$ARGUMENTS"

# Clear the saved key:
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" config-clear
```

Show the dispatcher stdout verbatim. The dispatcher masks the key automatically, so it is safe to surface.

## Where is the key stored?

- Windows: `%APPDATA%\eleven-sound-in-cc\config.json`
- macOS / Linux: `$XDG_CONFIG_HOME/eleven-sound-in-cc/config.json` or `~/.config/eleven-sound-in-cc/config.json`
- File permissions: `0600` on POSIX.

## Priority

`ELEVENLABS_API_KEY` environment variable always wins over the config file. Use the env var for CI / automation; use `config-set` for interactive sessions.

## Where to get a key

elevenlabs.io → Profile (bottom-left) → API Keys → Create. Sound Effects generation works on the free tier (MP3 output); PCM/WAV output at 44.1 kHz needs Pro+ — the plugin falls back automatically.

## Common follow-up

After `config-set`, suggest the user run `/eleven-sound:status` to confirm `Ready: yes` and see the account tier + remaining credits.
