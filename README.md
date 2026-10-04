# gh-pulse

PR checks and GitHub Actions runs, live inside Claude Code. When CI fails, one key puts the failing log in front of Claude. Release pipelines play out as Space Invaders.

<!--
  DEMO CLIP: put your video or GIF here. GitHub plays an .mp4 dragged into
  this file in the web editor; a GIF works as ![gh-pulse demo](docs/demo.gif).
-->

## Install

Needs Claude Code 2.1.287 or later and the [GitHub CLI](https://cli.github.com), signed in (`gh auth login`).

```sh
claude plugin marketplace add SID-Technologies/gh-pulse
claude plugin install gh-pulse@gh-pulse
```

Or inside a session: `/plugin marketplace add SID-Technologies/gh-pulse`, then pick it from `/plugin`. Run `/pulse` to open the board.

If `gh` is missing or signed out, gh-pulse tells you what to run and starts working within 15 seconds of you fixing it.

## What it does

- **Tracks what Claude starts.** `gh pr create`, `gh release create`, `gh workflow run`, `gh pr ready`, `gh pr checkout`, and pushes to a branch with a PR are picked up automatically. Tracking survives restarts.
- **Shows it everywhere.** A status line entry (`✕ #130 5/10 · ⠹ v1.4.0 4/6`), a line per item above the prompt, and a board with the full picture.
- **Puts failures first.** The open PR shows failing checks and the end of their log before anything else, plus CI history for each workflow on the base branch (flaky ones are flagged) and who has reviewed.
- **Hands failures to Claude.** `f` fills the prompt with the failing checks and their logs. You press Enter.
- **Keeps Claude informed.** While something is tracked, a one-line CI summary goes along with your prompts when it has changed, so "why is my PR red?" works without pasting anything.
- **Makes releases fun to watch.** Each Actions job is an invader. Passing jobs get shot down; a failing one lands on your ship. Jobs waiting on `needs` count from the start. A merge sets off confetti.

## The board

`/pulse` opens it with the keyboard; otherwise use **ctrl+x tab** or click it. **esc** returns to the prompt.

The lists sit at the top at a fixed height and scroll, so the open item below them always starts in the same place: what you're tracking (pull requests, then Actions), your open PRs in this repo, and PRs waiting on your review.

| Key | Does |
| --- | --- |
| `↑` `↓` | Move through the lists |
| `1` `2` `3` | Jump to a list, back to where you were in it |
| `enter` | Pin a tracked row in the detail, or track one of your PRs or review requests |
| `f` | Fix it: failing checks and logs into the prompt |
| `e` | Rerun failed jobs |
| `l` / `y` | Next failing log / copy the log shown |
| `a` | Ask Claude to review a PR you were asked to review |
| `o` | Open on GitHub |
| `x` | Remove the highlighted row |
| `d` | Clear finished: merged or closed PRs and releases that passed |
| `c` / `z` | Clear everything / undo any removal for 10s |
| `m` | Lists and detail, lists only, detail only |
| `r` | Refresh |
| `h` | Show all keys |

The pinned item stays in the detail while you move around the lists. Merged and closed PRs drop off by themselves 10 minutes after they end.

Buttons only appear when they apply. gh-pulse polls every 15 seconds; your PRs and review requests every minute; CI history every 5 minutes. Finished releases are rechecked every minute so a re-run shows up.

## Commands

| Command | Does |
| --- | --- |
| `/pulse` | Open the board |
| `/pulse-pr [number\|url]` | Track a PR; blank for the current branch's PR |
| `/pulse-release [tag\|workflow.yml]` | Track a tag's runs, a workflow's latest run, or (blank) the latest release |
| `/pulse-clear` | Stop tracking everything |

## Settings

Set in `/config`, or under `pluginConfigs.gh-pulse.options` in settings.json.

| Setting | Default | |
| --- | --- | --- |
| `claudeContext` | on | Send the CI summary with your prompts |
| `confetti` | on | Confetti on merge |
| `invaders` | on | Space Invaders for Actions runs |
| `avatars` | on | Reviewer avatars, in terminals that show images (Ghostty, kitty, iTerm2, WezTerm) |
| `heatmap` | on | CI history on the base branch |
| `sounds` | off | A chime on green, a thud on failure (macOS) |
| `speech` | off | Announce changes out loud ("PR 131 is green") |

Pixel art only draws in the terminal.

## Develop

```sh
claude --plugin-dir .       # run a local checkout
claude plugin validate .
claude plugin test .
```

```
hooks/register.tsx   hooks: commands, auto-tracking, polling, the band and the board
hooks/lib.ts         parsing gh output, tallies, glyphs, prompts, settings
hooks/sprites.ts     half-block pixel art: confetti and Space Invaders
types/index.d.ts     the $.state contract
tests/               claude plugin test suites
```

## License

[MIT](LICENSE)
