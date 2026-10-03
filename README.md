# gh-pulse

A Claude Code mod that watches your PR signals and GitHub Actions release pipelines, with links to everything, right inside the session.

## What you get

- **Auto-tracking.** When Claude runs `gh pr create`, `gh release create`, `gh workflow run <wf>`, `gh pr ready` or `gh pr checkout`, or pushes a branch that has a PR, gh-pulse starts watching it. Tracking is remembered across sessions.
- **Status line.** `✕ #130 5/10  ·  ⠹ v1.4.0 4/6`, with a braille spinner while anything is in flight.
- **Band above the prompt.** One line per tracked PR or release: state, link, a braille loader bar, and what's failing or running. A sparkle when one merges or ships.
- **Board (pane).** The opened item in full, pinned under the actions; what you're tracking, split into pull requests and Actions; your open PRs; and PRs waiting on your review:
  - PRs: verdict, a braille bar split by state, every check with its workflow, logs link and duration; the **failing step's log** right there; **CI history** of each workflow on the base branch (flaky ones flagged); reviewers with their **avatars**.
  - Releases: **space invaders**, one invader per Actions job. Your ship shoots at the running ones, a job that passes blows up, and a failing one turns red, lands and takes the ship out. Each run is linked, along with any job that isn't green.
- **Fix it.** On a red PR, `f` puts the failing checks and the end of their logs in your prompt box, ready for Claude. Enter sends it.
- **Claude knows your CI.** While anything is tracked, a one-line CI summary rides along with your prompts (only when it has something new to say), so "why is my PR red?" just works.
- **Confetti** across the board when a tracked PR merges.
- **Toasts on transitions**, plus optional **sounds** and **spoken announcements**.

Color carries state and nothing else: red failed, amber running, green passed, gray skipped.

## Commands

| Command | Does |
| --- | --- |
| `/pulse` | Open the board (and un-hide the band) |
| `/pulse-pr [number\|url]` | Track a PR; blank = PR for the current branch |
| `/pulse-release [tag\|workflow.yml]` | Track release pipelines: a tag's runs, the latest run of a workflow, or (blank) the latest GitHub release |
| `/pulse-clear` | Stop tracking everything |

### On the board

`/pulse` opens the board with the keyboard; otherwise **ctrl+x tab** or a click, and **esc** hands the keys back to the prompt. Buttons show their key (`f: Fix it`); the ones that don't apply to the selected item are hidden.

| Key | Does |
| --- | --- |
| `↑` `↓` | Move through the list; the row you land on opens and the view follows it. Past either end, or with the wheel or page keys, the board scrolls |
| `1` `2` `3` | Jump to Tracking, Your open PRs, Waiting on your review (back to where you were in it) |
| `enter` / click | Select a tracked row, or track one of your open PRs or review requests |
| `f` | Fix it: the failing checks and their logs into the prompt box |
| `e` | Rerun the failed jobs (`gh run rerun --failed`) |
| `l` | Show the next failing check's log |
| `y` | Copy the log shown |
| `a` | Review with Claude (on a PR you've been asked to review) |
| `o` | Open the selected PR or release on GitHub |
| `x` | Remove the open item |
| `m` | Minimize to just the list, or expand again |
| `r` | Refresh now |
| `c` | Clear everything |
| `z` | Undo the last Remove or Clear (for 10s) |

Polls every 15s via `gh`; your open PRs and review requests every minute; CI history every 5 minutes. Merged/closed PRs stop polling; finished releases are checked once a minute (or on `r` / `e`) so a re-run shows up.

## Settings

In `/config` (or `pluginConfigs.gh-pulse.options` in settings.json):

| Setting | Default | |
| --- | --- | --- |
| `claudeContext` | on | Attach the CI summary to your prompts |
| `confetti` | on | Confetti on merge |
| `invaders` | on | Space invaders for Actions runs |
| `avatars` | on | Reviewer avatars (needs a terminal that shows images, e.g. Ghostty, kitty, iTerm2, WezTerm) |
| `heatmap` | on | CI history on the base branch |
| `sounds` | off | A chime on green, a thud on failure (macOS) |
| `speech` | off | Say transitions out loud ("PR 131 is green") |

Pixel art (invaders, confetti) draws in the terminal; other surfaces leave it out.

## Demo

A 30-second run-through that shows most of it:

1. `/pulse`, then press enter on one of your open PRs. The loader bars fill.
2. A check goes red: the failing log appears under the checks.
3. `f`, esc, Enter: Claude gets the failure and fixes it. Push; it goes green.
4. Merge it on GitHub: confetti.
5. `gh release create v0.1.0`: the invaders march in and get shot down, job by job.

## Install

Requires the [GitHub CLI](https://cli.github.com), signed in, and Claude Code 2.1.287 or later (mods). If `gh` is missing or signed out, gh-pulse says so (a toast at startup, a setup card on the board, and the reply to any `/pulse` command) with the install command for your OS, and starts working by itself within 15s of you fixing it.

```sh
claude plugin marketplace add SID-Technologies/gh-pulse
claude plugin install gh-pulse@gh-pulse
```

Or from inside a session: `/plugin marketplace add SID-Technologies/gh-pulse`, then pick it from `/plugin`.

To try a local checkout for one session:

```sh
claude --plugin-dir /path/to/gh-pulse
```

## Develop

```sh
claude plugin validate ./gh-pulse
claude plugin test ./gh-pulse
```

## Layout

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   makes this repo installable as a marketplace
hooks/hooks.json                  points at register.tsx
hooks/register.tsx                hooks: commands, Bash auto-tracking, polling, band + pane UI
hooks/lib.ts                      pure logic: gh JSON parsing, tallies, look, toasts, prompts, settings
hooks/sprites.ts                  pixel art: half-block encoder, confetti, space invaders
assets/sounds/*.wav               chimes, made by scripts/make-sounds.py
types/index.d.ts                  $.state contract
tests/                            gh-pulse (core), video (fix-it, confetti, invaders),
                                  daily (context, logs, rerun, reviews, push, memory), fun (history, avatars, sound)
```

## Tweak

- Poll interval, spinner speed, caps: constants at the top of `hooks/register.tsx`.
- Glyphs, colors, labels and toast wording: the Look section of `hooks/lib.ts`.
- Sprites, palettes and animations: `hooks/sprites.ts`.
