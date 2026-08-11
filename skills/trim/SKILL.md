---
description: Trim trailing silence from a WAV file (mono or stereo PCM-16) — auto-runs after every non-loop /eleven-sound:create call; use this for explicit one-off trimming
argument-hint: '<input.wav> [output.wav]'
allowed-tools: Bash(node:*)
---

# Trim (eleven-sound)

Removes trailing silence from a PCM 16-bit WAV (mono or stereo) using a conservative -60 dBFS threshold, preserving a 50 ms tail buffer so natural reverb decay survives.

**Note:** this runs automatically after every non-loop `/eleven-sound:create` generation. This command exists for **explicit one-off trimming** of external WAVs.

**NEVER trim a seamless-loop file** — cutting the tail breaks the loop point. If the user asks to trim a file generated with `--loop`, warn them first and only proceed on explicit confirmation.

## Parse `$ARGUMENTS`

1. First existing `.wav` path → **input**.
2. Second `.wav` path (existing or not) → **output** (omit = in-place).
3. Other tokens → tuning:

| User intent | Flag |
|---|---|
| `더 잘라` / `aggressive` | `--threshold-db -50` (or -40) |
| `덜 잘라` / `보수적` / `gentle` | `--threshold-db -70` |
| `리버브 살려` / `tail 200ms` | `--tail-ms 200` |
| `타이트하게` / `tighter` | `--tail-ms 20` |

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/eleven-sound.mjs" trim-silence <input.wav> [--output PATH] [--threshold-db F] [--tail-ms N]
```

Outputs `TRIMMED: <path> (old → new bytes)` or `NO-OP` plus `SAVED: <path>`. Exit 8 = unsupported WAV layout (compressed / >16-bit / >2ch) — tell the user to convert to PCM-16 first.
