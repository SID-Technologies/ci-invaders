# 🛰️ gh-pulse

A Claude Code mod that watches your PR signals and GitHub Actions release pipelines, with links to everything, right inside the session.

## What you get

- **Auto-tracking.** When Claude runs `gh pr create`, `gh release create`, or `gh workflow run <wf>`, gh-pulse starts watching the result. No extra steps.
- **Status line.** `🛰️ PR #482 🌓 5/7 · 🚀 v1.4.0 ✅ 6/6` with a moon-phase spinner while anything is in flight.
- **Band above the prompt.** One line per tracked PR/release with clickable `PR #482` and `pipeline` links, a progress bar, and a rocket launch track: `🌍··🚀···🌕`.
- **Board (pane).** The full picture:
  - PRs: review decision, mergeability, draft state, a check bar, and every check (failures first) linking to its logs.
  - Releases: a launch track, each workflow run linked, a per-run job bar, and links to any job that isn't green.
- **Toasts on transitions.** `🎉 PR #482 is green: ship it 🛳️`, `💥 PR #482: ci / test failed`, `🟣 merged. Pop the 🍾`, `🚀🌕 v1.4.0 landed`, `🔥 launch scrubbed`.

## Commands

| Command | Does |
| --- | --- |
| `/pulse` | Open the board (and un-hide the band) |
| `/pulse-pr [number\|url]` | Track a PR; blank = PR for the current branch |
| `/pulse-release [tag\|workflow.yml]` | Track release pipelines: a tag's runs, the latest run of a workflow, or (blank) the latest GitHub release |
| `/pulse-clear` | Stop tracking everything |

Polls every 15s via `gh`. Merged/closed PRs and finished releases stop polling.

## Install

Requires the `gh` CLI, authenticated (`gh auth status`), and a Claude Code build with mods (function hooks). Built and tested against Claude Code 2.1.287.

Pick one:

```sh
# Auto-load in every session (folder is watched; edits hot-reload)
mkdir -p ~/.claude/skills && cp -r gh-pulse ~/.claude/skills/gh-pulse

# Or just for one session
claude --plugin-dir /path/to/gh-pulse
```

## Develop

```sh
claude plugin validate ./gh-pulse
claude plugin test ./gh-pulse
```

## Layout

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             points at register.tsx
hooks/register.tsx           hooks: commands, Bash auto-tracking, polling, band + pane UI
hooks/lib.ts                 pure logic: gh JSON parsing, tallies, flair, toasts
types/index.d.ts             $.state contract
tests/gh-pulse.test.tsx      parsing, flair, toasts, and an end-to-end PR → pane test
```

## Tweak

- Poll interval, spinner speed, caps: constants at the top of `hooks/register.tsx`.
- Cheers, icons, launch track: `hooks/lib.ts`.
