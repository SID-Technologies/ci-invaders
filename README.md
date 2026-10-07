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

Three lists sit at the top at a fixed height and scroll, so the open item below them always starts in the same place: the pull requests you're tracking, the Actions runs you're tracking, and your open PRs in this repo, ready to track.

| Key | Does |
| --- | --- |
| `↑` `↓` | Move through the lists |
| `1` `2` `3` | Jump to Pull requests, Actions or Your open PRs, back to where you were |
| `enter` | Pin a tracked row in the detail, or track one of your PRs |
| `f` | Fix it: failing checks and logs into the prompt |
| `e` | Rerun failed jobs |
| `l` / `y` | Next failing log / copy the log shown |
| `a` | Ask Claude to review a tracked PR you didn't open |
| `o` | Open on GitHub |
| `x` | Remove the highlighted row |
| `d` | Clear finished: merged or closed PRs and releases that passed |
| `c` / `z` | Clear everything / undo any removal for 10s |
| `m` | Lists and detail, lists only, detail only |
| `r` | Refresh |
| `h` | Show all keys |

The pinned item stays in the detail while you move around the lists. Merged and closed PRs drop off by themselves 10 minutes after they end.

Buttons only appear when they apply. gh-pulse polls every 15 seconds; your open PRs every minute; CI history every 5 minutes. Finished releases are rechecked every minute so a re-run shows up.

## Commands

| Command | Does |
| --- | --- |
| `/pulse [link]` | Open the board. With a pasted PR or Actions link, track it first |
| `/pulse-pr [number\|url\|owner/repo#n]` | Track a PR; blank for the current branch's PR |
| `/pulse-release [owner/repo] [tag\|workflow.yml\|run id]` | Track a tag's runs, a workflow's latest run, one run, or (blank) the latest release. Add `owner/repo` (or `-R owner/repo`) for another repo, or paste a GitHub Actions run, workflow or release URL |
| `/pulse-clear` | Stop tracking everything |

Any repo you can see with `gh` works, wherever Claude is running:

```
/pulse-release acme/infra deploy.yml
/pulse-release https://github.com/acme/infra/actions/runs/123456789
/pulse-release acme/infra            # latest release, or latest run if it has none
```

Paste any GitHub link into any of the three commands and it goes to the right list: a PR link (including `/checks` or `/files` pages) is tracked as a PR, an Actions run, workflow or release link as an Action. PRs in other repos track by URL: `/pulse-pr https://github.com/acme/infra/pull/42`. When Claude runs `gh workflow run` or `gh release create` with `-R`, that repo is followed too.

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

## Releasing

Run the Release workflow by hand: **Actions > Release > Run workflow**, or `gh workflow run release.yml`. It works out the next version from the PR titles merged since the last tag (`feat: …` bumps minor, `fix: …` and anything else bump patch, `feat!: …` or `BREAKING CHANGE` bumps major), commits it to `.claude-plugin/plugin.json`, tags `gh-pulse--v<version>` and publishes a GitHub release. Choose a bump when you run it to override that: `gh workflow run release.yml -f bump=minor`.

## License

[MIT](LICENSE)
