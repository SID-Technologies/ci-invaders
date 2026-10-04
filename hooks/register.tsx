import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Celebration, History, Logs, OpenPrs, Pr, Release, ReviewRequests, Run, Setup, Undo } from '../types'
import {
  FRAME_MS,
  PR_URL,
  RELEASE_URL,
  SOUND_FOR,
  SPINNER_EVERY,
  byUrgency,
  cells,
  ciContext,
  cleanLog,
  clip,
  duration,
  fixPrompt,
  glyph,
  isFlaky,
  isLive,
  isPlainLogin,
  isPrCreate,
  isReleaseCreate,
  isReleaseRunning,
  mergeLabel,
  nextRow,
  overall,
  parseActionsUrl,
  parseHistory,
  parseJobs,
  parseOpenPrs,
  parsePr,
  parseReviewRequests,
  parseRuns,
  plannedJobs,
  prState,
  prToast,
  prTransition,
  readSettings,
  releaseInvaders,
  releaseItems,
  releaseState,
  releaseToast,
  releaseTransition,
  reviewLabel,
  reviewPrompt,
  reviewerGlyph,
  scrollWindow,
  segments,
  setupAdvice,
  setupText,
  spoken,
  statusLine,
  summary,
  tally,
  tone,
  trouble,
  verdict,
  withWaitingJobs,
  workflowRun,
} from './lib'
import type { Failure, PlannedJob, Settings, Shown, Tally, Transition } from './lib'
import {
  CONFETTI_FRAMES,
  HIT_FRAMES,
  LOSS_FRAMES,
  VICTORY_FRAMES,
  type Ship,
  confettiFrame,
  invadersFrame,
  newShip,
  placeInvaders,
  toCells,
} from './sprites'

type $ = EngineInterface

const PANE = 'gh-pulse'
const TITLE = 'gh-pulse'
const STORE_KEY = 'tracked'

const POLL_MS = 15_000
const OPEN_PRS_EVERY = 4 // polls between refreshes of your PRs and review requests
const RESEAT_MS = 80 // long enough for the board to redraw
const UNDO_MS = 10_000
const HISTORY_TTL_MS = 5 * 60_000

const MAX_PRS = 5
const MAX_RELEASES = 3
const MAX_OPEN_PRS = 15
const MAX_CHECKS = 8
const MAX_JOBS = 5
const HISTORY_RUNS = 20
const LOG_PREVIEW = 15

const BAND_BAR = 10
const WORKFLOW_COLUMN = 16
const TIME_COLUMN = 8

const PR_FIELDS =
  'number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,baseRefName,latestReviews,reviewRequests'
const OPEN_PR_FIELDS = 'number,title,url,isDraft,statusCheckRollup'
const RUN_FIELDS = 'databaseId,name,workflowName,displayTitle,url,status,conclusion,headBranch,startedAt,updatedAt,attempt'

// Board elements are keyed by prefix: tracked rows, your PRs, review requests, section headings.
const ITEM = 'item:'
const ADD = 'add:'
const REVIEW = 'review:'
const SECTION = 'section:'

const prKey = (pr: Pr) => `pr:${pr.url}`
const releaseKey = (r: Release) => `release:${r.key}`

const CELEBRATION_FRAMES: Record<Celebration['kind'], number> = {
  merged: CONFETTI_FRAMES,
  released: 40,
  scrubbed: LOSS_FRAMES + 4,
}

type Layout = 'both' | 'list' | 'detail'
const NEXT_LAYOUT = { both: 'list', list: 'detail', detail: 'both' } as const
const LAYOUT_LABEL = { both: 'List and detail', list: 'List only', detail: 'Detail only' } as const

const prs = atom({ plugin: 'gh-pulse', key: 'prs' } as const, [])
const releases = atom({ plugin: 'gh-pulse', key: 'releases' } as const, [])
const frame = atom({ plugin: 'gh-pulse', key: 'frame' } as const, 0)
const isBandHidden = atom({ plugin: 'gh-pulse', key: 'isBandHidden' } as const, false)
const selected = atom({ plugin: 'gh-pulse', key: 'selected' } as const, '')
const layout = atom({ plugin: 'gh-pulse', key: 'layout' } as const, 'both' as Layout)
const setup = atom({ plugin: 'gh-pulse', key: 'setup' } as const, { gh: 'unknown', os: 'unknown' } as Setup)
const celebration = atom({ plugin: 'gh-pulse', key: 'celebration' } as const, null as Celebration | null)
const undo = atom({ plugin: 'gh-pulse', key: 'undo' } as const, null as Undo | null)
const cursor = atom({ plugin: 'gh-pulse', key: 'cursor' } as const, '')
const busy = atom({ plugin: 'gh-pulse', key: 'busy' } as const, '')
const isKeysShown = atom({ plugin: 'gh-pulse', key: 'isKeysShown' } as const, false)
const logs = atom({ plugin: 'gh-pulse', key: 'logs' } as const, {} as Logs)
const reviewRequests = atom({ plugin: 'gh-pulse', key: 'reviewRequests' } as const, { prs: [] } as ReviewRequests)
const logCheck = atom({ plugin: 'gh-pulse', key: 'logCheck' } as const, '')
const history = atom({ plugin: 'gh-pulse', key: 'history' } as const, {} as Record<string, History>)
const avatars = atom({ plugin: 'gh-pulse', key: 'avatars' } as const, {} as Record<string, string>)
const openPrs = atom({ plugin: 'gh-pulse', key: 'openPrs' } as const, { repo: '', prs: [] } as OpenPrs)

// Module state. Reset when the module reloads; $.state and $.store survive that.
let settings: Settings = readSettings(undefined)
const doneAt = new Map<string, number>() // `${release key}|${job key}` -> frame the job finished
const fleets = new Map<string, ReturnType<typeof placeInvaders>>()
const ships = new Map<string, Ship>()

// ── gh ──────────────────────────────────────────────────────────────────

async function gh($: $, args: string[]): Promise<string> {
  const ran = await $.process.run(['gh', ...args], { timeoutMs: 20_000 })
  if (ran.exitCode !== 0) {
    const why = ran.stderr.trim().split('\n')[0] ?? ''
    throw new Error(why || `gh ${args[0]} exited ${ran.exitCode}`)
  }
  return ran.stdout
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchPr($: $, ref: string): Promise<Pr> {
  const args = ['pr', 'view', '--json', PR_FIELDS]
  if (ref) args.splice(2, 0, ref)
  return parsePr(await gh($, args))
}

// By run id. A run's workflow file is fixed at its commit, so this never goes stale.
const plans = new Map<number, PlannedJob[]>()

async function planFor($: $, run: Run): Promise<PlannedJob[]> {
  const known = plans.get(run.id)
  if (known) return known
  let planned: PlannedJob[] = []
  try {
    const [path = '', sha = ''] = (
      await gh($, ['api', `repos/{owner}/{repo}/actions/runs/${run.id}`, '--jq', '.path + "\n" + .head_sha'])
    ).trim().split('\n')
    const file = path.split('@')[0] ?? ''
    if (file.startsWith('.github/workflows/') && sha) {
      planned = plannedJobs(
        await gh($, ['api', '-H', 'Accept: application/vnd.github.raw', `repos/{owner}/{repo}/contents/${file}?ref=${sha}`]),
      )
    }
  } catch {
    // Fall back to the jobs GitHub lists.
  }
  plans.set(run.id, planned)
  return planned
}

async function withJobs($: $, run: Run, previous?: Run): Promise<Run> {
  // Finished and not re-run since: the jobs can't have changed.
  const isSameFinish = previous?.state !== 'pending' && previous?.attempt === run.attempt
  if (run.state !== 'pending' && previous && isSameFinish && previous.jobs.length > 0) {
    return { ...run, jobs: previous.jobs }
  }
  try {
    const jobs = parseJobs(await gh($, ['run', 'view', String(run.id), '--json', 'jobs']))
    // GitHub only lists a job once it starts; add the ones still waiting on `needs`.
    return { ...run, jobs: withWaitingJobs(jobs, run.state === 'pending' ? await planFor($, run) : [], run.state === 'pending') }
  } catch {
    return { ...run, jobs: previous?.jobs ?? [] }
  }
}

async function fetchRelease($: $, release: Release): Promise<Release> {
  const args = ['run', 'list', '--json', RUN_FIELDS]
  if (release.workflow) args.push('--workflow', release.workflow, '--limit', '1')
  else if (release.tag) args.push('--branch', release.tag, '--limit', '10')
  else args.push('--limit', '1')

  const found = parseRuns(await gh($, args))
  const runs = await Promise.all(
    found.map(run => withJobs($, run, release.runs.find(old => old.id === run.id))),
  )
  return { ...release, runs, error: undefined }
}

// A tag, a workflow file, or (empty) the latest release.
async function resolveRelease($: $, arg: string): Promise<Release> {
  const trimmed = arg.trim()
  if (/\.ya?ml$/.test(trimmed)) {
    return { key: `wf:${trimmed}`, label: trimmed.replace(/\.ya?ml$/, ''), workflow: trimmed, runs: [] }
  }
  const args = ['release', 'view', '--json', 'tagName,url']
  if (trimmed) args.splice(2, 0, trimmed)
  const raw = JSON.parse(await gh($, args)) as { tagName?: string; url?: string }
  const tag = raw.tagName ?? trimmed
  return { key: `tag:${tag}`, label: tag, tag, url: raw.url, runs: [] }
}

// ── Setup ───────────────────────────────────────────────────────────────

async function tryRun($: $, argv: string[]): Promise<{ exitCode: number; stdout: string } | undefined> {
  try {
    return await $.process.run(argv, { timeoutMs: 10_000 })
  } catch {
    return undefined // not installed
  }
}

async function detectOs($: $): Promise<Setup['os']> {
  const uname = (await tryRun($, ['uname', '-s']))?.stdout.trim()
  if (uname === 'Darwin') return 'mac'
  if (uname === 'Linux') return 'linux'
  return uname === undefined ? 'windows' : 'unknown'
}

async function checkGh($: $): Promise<boolean> {
  const version = await tryRun($, ['gh', '--version'])
  let state: Setup['gh'] = 'ready'
  if (!version || version.exitCode !== 0) state = 'missing'
  else if ((await tryRun($, ['gh', 'auth', 'status']))?.exitCode !== 0) state = 'signed-out'

  const before = await read($, setup)
  const os = before.os === 'unknown' && state === 'missing' ? await detectOs($) : before.os
  if (before.gh !== state || before.os !== os) await update($, setup, () => ({ gh: state, os }))
  if (state === 'ready' && before.gh !== 'ready' && before.gh !== 'unknown') {
    $.ui.toast('gh-pulse is ready: GitHub CLI found and signed in')
  }
  return state === 'ready'
}

async function needsSetup($: $): Promise<string | undefined> {
  if (await checkGh($)) return undefined
  return setupText(await read($, setup))
}

// ── State ───────────────────────────────────────────────────────────────

async function refreshStatus($: $): Promise<void> {
  $.ui.status(statusLine(await read($, prs), await read($, releases), await read($, frame)))
}

async function upsertPr($: $, next: Pr): Promise<void> {
  const before = (await read($, prs)).find(pr => pr.url === next.url)
  await update($, prs, list =>
    [...list.filter(pr => pr.url !== next.url), next].slice(-MAX_PRS),
  )
  const toast = prToast(before, next)
  if (toast) $.ui.toast(toast, { timeoutMs: 6000 })
  const happened = prTransition(before, next)
  if (happened) await onTransition($, prKey(next), happened, `PR ${next.number}`)
  await persistTracking($)
}

function shipFor(key: string): Ship {
  const ship = ships.get(key) ?? newShip()
  ships.set(key, ship)
  return ship
}

async function upsertRelease($: $, next: Release): Promise<void> {
  const before = (await read($, releases)).find(r => r.key === next.key)
  const wasRunning = new Set(before ? releaseInvaders(before).filter(job => job.state === 'pending').map(job => job.key) : [])
  const now = await read($, frame)
  for (const job of releaseInvaders(next)) {
    if (job.state !== 'pending' && wasRunning.has(job.key)) doneAt.set(`${next.key}|${job.key}`, now)
  }
  fleets.set(next.key, placeInvaders(fleets.get(next.key) ?? new Map(), releaseInvaders(next), now))
  await update($, releases, list =>
    [...list.filter(r => r.key !== next.key), next].slice(-MAX_RELEASES),
  )
  const toast = releaseToast(before, next)
  if (toast) $.ui.toast(toast, { timeoutMs: 8000 })
  const happened = releaseTransition(before, next)
  if (happened) await onTransition($, releaseKey(next), happened, next.label)
  await persistTracking($)
}

async function onTransition($: $, key: string, happened: Transition, label: string): Promise<void> {
  const sound = SOUND_FOR[happened]
  if (settings.sounds && sound) void $.audio.play({ asset: sound }).catch(() => undefined)
  if (settings.speech) void $.audio.speak(spoken(label, happened)).catch(() => undefined)
  const kind =
    happened === 'merged' && settings.confetti
      ? 'merged'
      : (happened === 'released' || happened === 'scrubbed') && settings.invaders
        ? happened
        : undefined
  if (!kind) return
  const startFrame = await read($, frame)
  await update($, celebration, () => ({ key, kind, startFrame }))
}

function isCelebrating(party: Celebration | null, now: number): party is Celebration {
  return party !== null && now - party.startFrame < CELEBRATION_FRAMES[party.kind]
}

// ── Fix it ──────────────────────────────────────────────────────────────

async function fetchFailedLog($: $, jobId: string): Promise<string[]> {
  const cached = (await read($, logs))[jobId]
  if (cached) return cached.lines
  const lines = cleanLog(await gh($, ['run', 'view', '--job', jobId, '--log-failed']))
  await update($, logs, all => ({ ...all, [jobId]: { lines, at: Date.now() } }))
  return lines
}

async function fixIt($: $, key: string, surface: string): Promise<void> {
  const pr = (await read($, prs)).find(one => prKey(one) === key)
  if (!pr) return
  const failing = pr.checks.filter(c => c.state === 'fail').slice(0, 3)
  if (failing.length === 0) {
    $.ui.toast(`PR #${pr.number} has nothing failing`)
    return
  }
  const failures: Failure[] = await Promise.all(
    failing.map(async c => {
      const jobId = parseActionsUrl(c.url)?.jobId
      let log: string[] | undefined
      if (jobId) {
        try {
          log = await fetchFailedLog($, jobId)
        } catch {
          log = undefined
        }
      }
      return { name: c.name, workflow: c.workflow, url: c.url, log }
    }),
  )
  const text = fixPrompt(pr, failures)
  const filled = await $.prompt.fill({ text })
  if (filled.isFilled) {
    $.ui.toast('Fix prompt ready: esc to the prompt, then Enter to send', { timeoutMs: 6000 })
    return
  }
  const copied = await $.ui.copy({ text, surface: surface as never })
  $.ui.toast(copied.isCopied ? 'Fix prompt copied: paste it into the prompt' : "Couldn't fill or copy the fix prompt", { timeoutMs: 6000 })
}

async function trackPr($: $, ref: string): Promise<Pr> {
  const pr = await fetchPr($, ref)
  await upsertPr($, pr)
  await refreshStatus($)
  return pr
}

async function trackRelease($: $, release: Release): Promise<Release> {
  let next = release
  try {
    next = await fetchRelease($, release)
  } catch (error) {
    next = { ...release, error: message(error) }
  }
  await upsertRelease($, next)
  await refreshStatus($)
  return next
}

async function refreshOpenPrs($: $): Promise<void> {
  try {
    const known = await read($, openPrs)
    const repo =
      known.repo ||
      (JSON.parse(await gh($, ['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner?: string }).nameWithOwner ||
      ''
    const list = parseOpenPrs(
      await gh($, ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', String(MAX_OPEN_PRS), '--json', OPEN_PR_FIELDS]),
    )
    await update($, openPrs, () => ({ repo, prs: list }))
  } catch (error) {
    await update($, openPrs, old => ({ ...old, error: message(error) }))
  }
}

async function refreshReviewRequests($: $): Promise<void> {
  try {
    const list = parseReviewRequests(
      await gh($, ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '15', '--json', 'number,title,url,repository']),
    )
    await update($, reviewRequests, () => ({ prs: list }))
  } catch (error) {
    await update($, reviewRequests, old => ({ ...old, error: message(error) }))
  }
}

async function refreshLists($: $): Promise<void> {
  await Promise.all([refreshOpenPrs($), refreshReviewRequests($)])
}

let isPolling = false
let polls = 0
let isEverythingDue = false // asked for while a poll was running

// Finished releases are rechecked every few polls, or now with `everything`, to catch re-runs.
async function poll($: $, everything = false): Promise<void> {
  if (everything) isEverythingDue = true
  if (isPolling) return
  isPolling = true
  const isSlowTick = polls++ % OPEN_PRS_EVERY === 0
  const isEverything = isEverythingDue || isSlowTick
  isEverythingDue = false
  try {
    if (!(await checkGh($))) return
    for (const pr of await read($, prs)) {
      if (pr.state !== 'OPEN') continue
      try {
        await upsertPr($, await fetchPr($, pr.url))
      } catch (error) {
        await update($, prs, list =>
          list.map(one => (one.url === pr.url ? { ...one, error: message(error) } : one)),
        )
      }
    }
    for (const release of await read($, releases)) {
      if (!isReleaseRunning(release) && !isEverything) continue
      await trackRelease($, release)
    }
    if (isSlowTick) await refreshLists($)
    await prefetchLog($)
    await refreshStatus($)
  } finally {
    isPolling = false
  }
}

// ── Board navigation ────────────────────────────────────────────────────

let ringMoves = 0 // focus moves by the person; a newer one cancels a pending re-seat
let focusedKey: string | undefined
let rowKeys: readonly string[] = [] // as last drawn, top to bottom
let sectionRows: Record<string, readonly string[]> = {}
const lastInSection = new Map<string, string>()
const windowStarts = new Map<string, number>()
let drawnRows = new Set<string>() // rows inside their list's window
// Rows each list shows, and whether your PRs and review requests sit side by side.
let boardShape = { trackRows: 5, sideRows: 3, isSideBySide: true }

// Where a focusable sits top to bottom: action buttons first, then headings and rows.
function orderOf(key: string): number {
  const at = rowKeys.indexOf(key)
  if (at >= 0) return at
  if (!key.startsWith(SECTION)) return -1
  const first = sectionRows[key.slice(SECTION.length)]?.[0]
  const firstAt = first ? rowKeys.indexOf(first) : -1
  return firstAt >= 0 ? firstAt - 0.5 : rowKeys.length
}

const KEYS: readonly (readonly [string, string])[] = [
  ['↑ ↓', 'move through the list; the row you land on opens'],
  ['1 2 3', 'jump to Tracking, Your open PRs, Waiting on your review'],
  ['pgup pgdn', 'scroll the board'],
  ['enter', 'select a row, or track one of yours'],
  ['f', 'fix it: the failing logs into the prompt'],
  ['e', 'rerun the failed jobs'],
  ['l  y', 'next failing log · copy the log shown'],
  ['a', 'review with Claude'],
  ['o', 'open on GitHub'],
  ['x  c  z', 'remove · clear everything · undo either'],
  ['r', 'refresh now'],
  ['m', 'list and detail, list only, detail only'],
  ['esc', 'back to the prompt'],
]

// Shows `label` in place of the help line until `work` finishes.
async function showWhile<T>($: $, label: string, work: () => Promise<T>): Promise<T> {
  await update($, busy, () => label)
  try {
    return await work()
  } finally {
    await update($, busy, () => '')
  }
}

async function goToRow($: $, key: string): Promise<void> {
  ringMoves += 1
  // Moves the list's window first if the row is scrolled out of it.
  await update($, cursor, () => key)
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
  if (key.startsWith(ITEM)) await openItem($, key.slice(ITEM.length))
  await $.ui.scroll({ in: PANE, to: { key }, block: 'nearest' }).catch(() => undefined)
}

async function jumpToSection($: $, id: string): Promise<void> {
  const rows = sectionRows[id] ?? []
  const remembered = lastInSection.get(id)
  const key = remembered && rows.includes(remembered) ? remembered : rows[0]
  if (key) await goToRow($, key)
  else await $.ui.scroll({ in: PANE, to: { key: `${SECTION}${id}` }, block: 'nearest' }).catch(() => undefined)
}

/**
 * The pane's focus ring is an index into its focusable elements, not a key.
 * Opening an item changes the buttons above the list, so after the redraw the
 * index points at the wrong element. Put focus back on the row once it settles.
 */
async function openItem($: $, key: string): Promise<void> {
  if ((await read($, selected)) === key) return
  await update($, selected, () => key)
  const move = ringMoves
  $.clock.after(RESEAT_MS, () => {
    if (move !== ringMoves) return
    void $.ui.focus({ requestId: PANE, key: `${ITEM}${key}` }).catch(() => undefined)
    void $.ui.scroll({ in: PANE, to: { key: `${ITEM}${key}` }, block: 'nearest' }).catch(() => undefined)
  })
  await prefetchLog($)
}

let removals = 0 // so an older removal's timer can't clear a newer undo

async function keepForUndo($: $, label: string): Promise<void> {
  const kept: Undo = { label, prs: await read($, prs), releases: await read($, releases), selected: await read($, selected) }
  await update($, undo, () => kept)
  const mine = ++removals
  $.clock.after(UNDO_MS, () => {
    if (mine === removals) void update($, undo, () => null)
  })
}

async function undoRemoval($: $): Promise<void> {
  const kept = await read($, undo)
  if (!kept) return
  removals += 1
  await update($, undo, () => null)
  await update($, prs, () => kept.prs)
  await update($, releases, () => kept.releases)
  await update($, selected, () => kept.selected)
  await refreshStatus($)
  await persistTracking($)
  $.ui.toast(`Put back: ${kept.label}`)
}

async function clearAll($: $): Promise<void> {
  const count = (await read($, prs)).length + (await read($, releases)).length
  if (count > 0) await keepForUndo($, `${count} tracked item${count === 1 ? '' : 's'}`)
  await update($, prs, () => [])
  await update($, releases, () => [])
  await update($, selected, () => '')
  $.ui.status(undefined)
  await persistTracking($)
}

// Each list is a heading, its rows and a scroll line; one row of gap between blocks.
function listOnlyRows(): number {
  const { trackRows, sideRows, isSideBySide } = boardShape
  const side = isSideBySide ? sideRows + 2 : 2 * (sideRows + 2) + 1
  return 2 + 1 + (trackRows + 2) + 1 + side
}

async function openBoard($: $) {
  const isSmall = (await read($, layout)) === 'list'
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: isSmall ? listOnlyRows() : undefined })
  void refreshLists($)
  return opened
}

async function cycleLayout($: $): Promise<void> {
  const shown = NEXT_LAYOUT[await read($, layout)]
  await update($, layout, () => shown)
  const isSmall = shown === 'list'
  // Re-opening sets the height, unless the person has resized the pane.
  await $.ui.open({ id: PANE, title: TITLE, rows: isSmall ? listOnlyRows() : undefined })
}

// Through gh, so it works on every OS.
async function openInBrowser($: $, key: string): Promise<void> {
  try {
    const pr = (await read($, prs)).find(one => prKey(one) === key)
    if (pr) {
      await gh($, ['pr', 'view', pr.url, '--web'])
      return
    }
    const release = (await read($, releases)).find(one => releaseKey(one) === key)
    if (release?.tag && release.url) await gh($, ['release', 'view', release.tag, '--web'])
    else if (release?.runs[0]) await gh($, ['run', 'view', String(release.runs[0].id), '--web'])
  } catch (error) {
    $.ui.toast(`Couldn't open it: ${message(error)}`)
  }
}

async function untrack($: $, key: string): Promise<void> {
  const pr = (await read($, prs)).find(one => prKey(one) === key)
  const release = (await read($, releases)).find(one => releaseKey(one) === key)
  await keepForUndo($, pr ? `#${pr.number}` : (release?.label ?? 'the item'))
  await update($, prs, list => list.filter(pr => prKey(pr) !== key))
  await update($, releases, list => list.filter(r => releaseKey(r) !== key))
  await update($, selected, () => '')
  await refreshStatus($)
  await persistTracking($)
}

// ── Persistence ─────────────────────────────────────────────────────────

type Stored = { prs: string[]; releases: Omit<Release, 'runs' | 'error'>[] }
let lastStored = ''

async function persistTracking($: $): Promise<void> {
  const stored: Stored = {
    prs: (await read($, prs)).filter(pr => pr.state === 'OPEN').map(pr => pr.url),
    releases: (await read($, releases)).map(({ runs: _runs, error: _error, ...rest }) => rest),
  }
  const text = JSON.stringify(stored)
  if (text === lastStored) return
  try {
    await $.store.set(STORE_KEY, stored)
    lastStored = text
  } catch {
    // Not fatal; tracking works without it.
  }
}

async function restoreTracking($: $): Promise<void> {
  let stored: Stored | undefined
  try {
    stored = (await $.store.get(STORE_KEY)) as Stored | undefined
  } catch {
    return
  }
  if (!stored) return
  lastStored = JSON.stringify(stored)
  const known = new Set((await read($, prs)).map(pr => pr.url))
  for (const url of stored.prs ?? []) {
    if (known.has(url)) continue
    try {
      const pr = await fetchPr($, url)
      if (pr.state === 'OPEN') await upsertPr($, pr)
    } catch {
      // Deleted or no longer reachable.
    }
  }
  for (const release of stored.releases ?? []) await trackRelease($, { ...release, runs: [] })
  await refreshStatus($)
}

// ── Detail data ─────────────────────────────────────────────────────────

function shownFailure(pr: Pr, chosen: string) {
  const failing = pr.checks.filter(c => c.state === 'fail' && parseActionsUrl(c.url)?.jobId)
  return failing.find(c => chosen === `${prKey(pr)}#${c.url}`) ?? failing[0]
}

// Log, CI history and avatars for the selected PR.
async function prefetchLog($: $): Promise<void> {
  const key = await read($, selected)
  const list = await read($, prs)
  const pr = list.find(one => prKey(one) === key) ?? list.at(-1)
  if (!pr) return
  const check = shownFailure(pr, await read($, logCheck))
  const jobId = parseActionsUrl(check?.url)?.jobId
  await Promise.all([
    jobId ? fetchFailedLog($, jobId).catch(() => undefined) : undefined,
    settings.heatmap ? fetchHistory($, pr) : undefined,
    settings.avatars ? fetchAvatars($, pr) : undefined,
  ])
}

function historyKey(pr: Pr, workflow: string): string {
  return `${pr.repo}|${pr.base ?? ''}|${workflow}`
}

async function fetchHistory($: $, pr: Pr): Promise<void> {
  if (!pr.base) return
  const workflows = [...new Set(pr.checks.map(c => c.workflow).filter((w): w is string => Boolean(w)))]
  const known = await read($, history)
  for (const workflow of workflows.slice(0, 6)) {
    const key = historyKey(pr, workflow)
    if (known[key] && Date.now() - known[key].at < HISTORY_TTL_MS) continue
    try {
      const results = parseHistory(
        await gh($, ['run', 'list', '-R', pr.repo, '--workflow', workflow, '--branch', pr.base, '--limit', String(HISTORY_RUNS), '--json', 'status,conclusion']),
      )
      await update($, history, all => ({ ...all, [key]: { results, at: Date.now() } }))
    } catch {
      await update($, history, all => ({ ...all, [key]: { results: [], at: Date.now() } }))
    }
  }
}

// $.http.fetch only returns text, so curl and base64 fetch the PNG.
async function fetchAvatars($: $, pr: Pr): Promise<void> {
  const have = await read($, avatars)
  for (const reviewer of (pr.reviews ?? []).slice(0, 6)) {
    const login = reviewer.login
    if (login in have) continue
    let png = ''
    if (isPlainLogin(login)) {
      const ran = await tryRun($, ['sh', '-c', 'curl -sfL --max-time 5 "https://github.com/$1.png?size=48" | base64 | tr -d "\\n"', 'sh', login])
      if (ran?.exitCode === 0 && ran.stdout.startsWith('iVBOR')) png = ran.stdout.trim()
    }
    await update($, avatars, all => ({ ...all, [login]: png }))
  }
}

async function nextLog($: $, key: string): Promise<void> {
  const pr = (await read($, prs)).find(one => prKey(one) === key)
  if (!pr) return
  const failing = pr.checks.filter(c => c.state === 'fail' && parseActionsUrl(c.url)?.jobId)
  if (failing.length === 0) return
  const current = shownFailure(pr, await read($, logCheck))
  const next = failing[(failing.indexOf(current ?? failing[0]!) + 1) % failing.length]!
  await update($, logCheck, () => `${key}#${next.url}`)
  await prefetchLog($)
}

async function copyLog($: $, key: string, surface: string): Promise<void> {
  const pr = (await read($, prs)).find(one => prKey(one) === key)
  const jobId = parseActionsUrl(pr && shownFailure(pr, await read($, logCheck))?.url)?.jobId
  const lines = jobId ? (await read($, logs))[jobId]?.lines : undefined
  if (!lines) {
    $.ui.toast('No log loaded yet')
    return
  }
  const copied = await $.ui.copy({ text: lines.join('\n'), surface: surface as never })
  $.ui.toast(copied.isCopied ? `Copied ${lines.length} log lines` : "Couldn't copy the log")
}

// ── Rerun and review ────────────────────────────────────────────────────

async function rerunFailed($: $, key: string): Promise<void> {
  const pr = (await read($, prs)).find(one => prKey(one) === key)
  const release = (await read($, releases)).find(one => releaseKey(one) === key)
  const runIds = new Set<string>()
  for (const c of pr?.checks ?? []) {
    const id = c.state === 'fail' ? parseActionsUrl(c.url)?.runId : undefined
    if (id) runIds.add(id)
  }
  for (const failed of release?.runs ?? []) if (failed.state === 'fail') runIds.add(String(failed.id))
  if (runIds.size === 0) {
    $.ui.toast('Nothing to rerun: no failed GitHub Actions runs')
    return
  }
  let started = 0
  for (const id of runIds) {
    try {
      await gh($, ['run', 'rerun', id, '--failed'])
      started += 1
    } catch (error) {
      $.ui.toast(`Couldn't rerun run ${id}: ${message(error)}`)
    }
  }
  if (started > 0) $.ui.toast(`Rerunning failed jobs in ${started} run${started === 1 ? '' : 's'}`)
  void poll($, true)
}

async function askForReview($: $, url: string): Promise<void> {
  const request = (await read($, reviewRequests)).prs.find(one => one.url === url)
  const pr = (await read($, prs)).find(one => one.url === url)
  const what = request ?? (pr && { url: pr.url, number: pr.number, title: pr.title })
  if (!what) return
  const filled = await $.prompt.fill({ text: reviewPrompt(what) })
  $.ui.toast(filled.isFilled ? 'Review prompt ready: esc to the prompt, then Enter' : "Couldn't fill the prompt box")
}

// ── Hooks ───────────────────────────────────────────────────────────────

const COMMANDS = [
  { name: 'pulse', description: 'gh-pulse: open the PR + release board' },
  { name: 'pulse-pr', description: 'gh-pulse: track a PR (number, URL, or current branch)', argumentHint: '[pr]' },
  {
    name: 'pulse-release',
    description: 'gh-pulse: track release pipelines (tag, workflow .yml, or latest release)',
    argumentHint: '[tag|workflow.yml]',
  },
  { name: 'pulse-clear', description: 'gh-pulse: stop tracking everything' },
] as const

export const register: Register = (on, options) => {
  settings = readSettings(options)
  let pollTimer: Timer | undefined
  let frameTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) await $.command.register({ ...command })

    pollTimer?.cancel()
    frameTimer?.cancel()
    pollTimer = $.clock.every(POLL_MS, () => void poll($))
    // Only tick while something is animating.
    frameTimer = $.clock.every(FRAME_MS, () => {
      void (async () => {
        const party = await read($, celebration)
        const now = await read($, frame)
        const isSettling = [...doneAt.values()].some(at => now - at < Math.max(LOSS_FRAMES, HIT_FRAMES + VICTORY_FRAMES))
        const isBusy = (await read($, busy)) !== ''
        if (!isLive(await read($, prs), await read($, releases)) && !isCelebrating(party, now) && !isSettling && !isBusy) return
        const n = ((await read($, frame)) + 1) % 100_000
        await update($, frame, () => n)
        if (n % SPINNER_EVERY === 0) await refreshStatus($)
      })()
    })
    await refreshStatus($)

    const result = await next(e)
    void (async () => {
      if (await checkGh($)) {
        await restoreTracking($)
        return
      }
      const advice = setupAdvice(await read($, setup))
      if (advice) $.ui.toast(`${advice.title}: ${advice.steps[0]}`, { timeoutMs: 10_000 })
    })()
    return result
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await update($, isBandHidden, () => false)
    void checkGh($)
    const opened = await openBoard($)
    void poll($)
    return { text: opened.isPlaced ? 'Board open.' : 'Board queued: widen the terminal to see it.' }
  })

  on('command.run', { command: 'pulse-pr' }, async ($, e) => {
    const blocked = await needsSetup($)
    if (blocked) return { text: blocked }
    try {
      const pr = await trackPr($, e.args.trim())
      return { text: `Tracking PR #${pr.number}: ${pr.title}\n${pr.url}` }
    } catch (error) {
      return { text: `Couldn't find that PR: ${message(error)}` }
    }
  })

  on('command.run', { command: 'pulse-release' }, async ($, e) => {
    const blocked = await needsSetup($)
    if (blocked) return { text: blocked }
    try {
      const release = await trackRelease($, await resolveRelease($, e.args))
      const runs = release.runs.map(r => `  ${glyph(r.state)} ${r.name}  ${r.url}`).join('\n')
      return {
        text: `Tracking ${release.label}${release.url ? ` (${release.url})` : ''}\n${runs || '  No pipeline runs yet; watching for them.'}`,
      }
    } catch (error) {
      return { text: `Couldn't find that release: ${message(error)}` }
    }
  })

  on('command.run', { command: 'pulse-clear' }, async $ => {
    const hadAny = (await read($, prs)).length + (await read($, releases)).length > 0
    await clearAll($)
    return { text: hadAny ? 'Cleared. Nothing tracked. Press z on the board within 10s to put it back.' : 'Nothing was tracked.' }
  })

  // Track what Claude creates or pushes.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const output = ran.text ?? ''
    try {
      if (isPrCreate(e.command)) {
        const url = PR_URL.exec(output)?.[0]
        if (url) {
          const pr = await trackPr($, url)
          $.ui.toast(`Watching PR #${pr.number} · /pulse for the board`)
        }
      } else if (isReleaseCreate(e.command)) {
        const tag = RELEASE_URL.exec(output)?.[1]
        if (tag) {
          const release = await trackRelease($, await resolveRelease($, decodeURIComponent(tag)))
          $.ui.toast(`Watching ${release.label} pipelines`)
        }
      } else if (/\bgit\s+push\b/.test(e.command)) {
        const pr = await fetchPr($, '')
        if (pr.state === 'OPEN' && !(await read($, prs)).some(one => one.url === pr.url)) {
          await trackPr($, pr.url)
          $.ui.toast(`Watching PR #${pr.number} after your push`)
        }
      } else if (/\bgh\s+pr\s+(ready|checkout)\b/.test(e.command)) {
        const ref = /\bgh\s+pr\s+(?:ready|checkout)\s+([^\s-][^\s]*)/.exec(e.command)?.[1] ?? ''
        const pr = await trackPr($, ref)
        $.ui.toast(`Watching PR #${pr.number}`)
      } else {
        const workflow = workflowRun(e.command)
        if (workflow) {
          const release = await trackRelease($, await resolveRelease($, workflow))
          $.ui.toast(`Watching ${release.label}`)
        }
      }
    } catch {
      // Best effort; never fail the tool call.
    }
    return ran
  })

  // ── Prompt context ──

  let lastContext = ''
  on('prompt.submit', async ($, e, next) => {
    if (!settings.claudeContext) return next(e)
    const block = ciContext(await read($, prs), await read($, releases))
    const isFailing = (await read($, prs)).some(pr => prState(pr) === 'fail')
    if (!block || (block === lastContext && !isFailing)) return next(e)
    lastContext = block
    return next({ ...e, context: [...(e.context ?? []), block] })
  })

  // ── Band ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prList = await read($, prs)
    const releaseList = await read($, releases)
    if (e.props.hasSurvey || (await read($, isBandHidden)) || prList.length + releaseList.length === 0) {
      return next(e)
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const f = await read($, frame)
    const party = await read($, celebration)
    const sparkle = ['✦', '✧', '⋆', '✧'][Math.floor(f / 3) % 4]

    const rows = [
      ...prList.slice(-2).map(pr => ({
        key: pr.url,
        isParty: isCelebrating(party, f) && party.kind === 'merged' && party.key === prKey(pr),
        state: prState(pr) as Shown,
        label: `#${pr.number}`,
        url: pr.url,
        t: tally(pr.checks),
      })),
      ...releaseList.slice(-1).map(r => ({
        key: r.key,
        isParty: isCelebrating(party, f) && party.kind === 'released' && party.key === releaseKey(r),
        state: releaseState(r) as Shown,
        label: r.label,
        url: r.url ?? r.runs[0]?.url,
        t: tally(releaseItems(r)),
      })),
    ]

    const Bar = ({ t, width }: { t: Tally; width: number }) => {
      return (
        <Box>
          {segments(t, width).map((seg, i) => (
            <Text key={`seg-${i}`} color={tone(seg.state)} dimColor={seg.state === 'skip'}>
              {cells(seg, f)}
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <Box key={`band-${row.key}`} justifyContent="space-between">
            <Box gap={2}>
              <Box gap={1}>
                <Text color={tone(row.state)}>{glyph(row.state, f)}</Text>
                {row.url ? <Link href={row.url} label={row.label} /> : <Text>{row.label}</Text>}
              </Box>
              {Bar({ t: row.t, width: BAND_BAR })}
              <Text>
                {row.t.pass}/{row.t.total}
              </Text>
              {row.isParty ? (
                <Text color="magenta" bold>
                  {sparkle} {row.state === 'merged' ? 'merged' : 'released'} {sparkle}
                </Text>
              ) : (
                <Text color={row.t.fail > 0 ? 'red' : undefined} dimColor={row.t.fail === 0}>
                  {trouble(row.t)}
                </Text>
              )}
            </Box>
            {i === 0 && (
              <Box gap={2}>
                <Button
                  key="open"
                  plain
                  dimColor
                  hotkey="b"
                  label="open board"
                  onPress={async () => {
                    // The band has focus here, so the board can't take it.
                    await openBoard($)
                    $.ui.toast('Board open · esc, then ctrl+x tab to use its keys', { timeoutMs: 5000 })
                  }}
                />
                <Button key="hide" plain dimColor hotkey="h" label="hide" onPress={() => update($, isBandHidden, () => true)} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })

  // ── Board ──

  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element ?? ''
    const isPerson = e.origin.kind === 'person'
    if (isPerson) ringMoves += 1
    // The engine only knows the rows on screen. Stepping off the edge of a
    // list's window goes to the hidden row next to it instead of skipping it.
    if (isPerson && focusedKey && rowKeys.includes(focusedKey) && element !== focusedKey) {
      const toward = nextRow(rowKeys, focusedKey, orderOf(element) > orderOf(focusedKey) ? 1 : -1)
      if (toward && !drawnRows.has(toward)) {
        await goToRow($, toward)
        return {}
      }
    }
    const result = await next(e)
    if (!('deny' in result)) {
      focusedKey = e.element
      for (const [id, rows] of Object.entries(sectionRows)) if (rows.includes(element)) lastInSection.set(id, element)
      await update($, cursor, () => element)
    }
    if (isPerson && element.startsWith(ITEM)) await openItem($, element.slice(ITEM.length))
    return result
  })

  // When the board overflows, the engine turns ↑↓ into scrolling. Move the
  // selection instead and scroll it into view; the wheel and page keys still scroll.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || e.pointer || Math.abs(e.by) !== 1) return next(e)
    const first = focusedKey?.startsWith(SECTION) ? sectionRows[focusedKey.slice(SECTION.length)]?.[0] : undefined
    const to = first ? (e.by > 0 ? first : nextRow(rowKeys, first, -1)) : nextRow(rowKeys, focusedKey, e.by)
    if (!to) return next(e)
    await goToRow($, to)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Link, Text } = elements
    // Raster and Image are terminal-only.
    const Raster = 'Raster' in elements ? elements.Raster : undefined
    const Image = 'Image' in elements ? elements.Image : undefined
    const party = await read($, celebration)
    const pastRuns = await read($, history)
    const faces = await read($, avatars)
    const prList = await read($, prs)
    const releaseList = await read($, releases)
    const mine = await read($, openPrs)
    const reviews = await read($, reviewRequests)
    const allLogs = await read($, logs)
    const chosenLog = await read($, logCheck)
    const f = await read($, frame)
    const shown = await read($, layout)
    const kept = await read($, undo)
    const cursorKey = await read($, cursor)
    const doing = await read($, busy)
    const isShowingKeys = await read($, isKeysShown)
    const props = e.props as { bodyColumns?: number; isFocused?: boolean; scroll?: { bodyRows?: number } }
    const columns = Number(props.bodyColumns ?? 80)
    const inner = Math.max(20, columns - 2)
    const barWidth = Math.max(10, Math.min(64, inner))

    const advice = setupAdvice(await read($, setup))
    if (advice) {
      return (
        <Box flexDirection="column" paddingX={1} gap={1}>
          <Text bold color="yellow">
            {advice.title}
          </Text>
          <Box flexDirection="column">
            {advice.steps.map((step, i) => (
              <Box key={`step-${i}`} gap={2}>
                <Text dimColor>{i + 1}</Text>
                <Text>{step}</Text>
              </Box>
            ))}
          </Box>
          <Box gap={2}>
            <Link href="https://cli.github.com" label="cli.github.com" />
            <Button key="recheck" plain dimColor hotkey="r" label="Check again" onPress={() => checkGh($)} />
          </Box>
        </Box>
      )
    }

    const Bar = ({ t, width }: { t: Tally; width: number }) => {
      return (
        <Box flexShrink={0}>
          {segments(t, width).map((seg, i) => (
            <Text key={`seg-${i}`} color={tone(seg.state)} dimColor={seg.state === 'skip'}>
              {cells(seg, f)}
            </Text>
          ))}
        </Box>
      )
    }

    const Verdict = ({ state, t }: { state: Shown; t: Tally }) => (
      <Box gap={1}>
        <Text color={tone(state)}>{glyph(state, f)}</Text>
        <Box width={10}>
          <Text bold color={tone(state)}>
            {verdict(state)}
          </Text>
        </Box>
        <Text dimColor>{summary(t)}</Text>
      </Box>
    )

    const Row = ({ key, state, workflow, name, url, ms, indent = 0, isWaiting = false }: {
      key: string
      state: Shown
      isWaiting?: boolean
      workflow?: string
      name: string
      url?: string
      ms?: number
      indent?: number
    }) => (
      <Box key={key} gap={2} paddingLeft={indent}>
        <Text color={tone(state)}>{glyph(state, f)}</Text>
        {workflow !== undefined && (
          <Box width={WORKFLOW_COLUMN} flexShrink={0}>
            <Text dimColor wrap="truncate-end">
              {workflow}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          {url ? (
            <Link href={url} label={clip(name, inner - indent - 1 - TIME_COLUMN - (workflow === undefined ? 4 : WORKFLOW_COLUMN + 6))} />
          ) : (
            <Text wrap="truncate-end">{name}</Text>
          )}
        </Box>
        <Box width={TIME_COLUMN} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{isWaiting ? 'waiting' : state === 'pending' ? 'running' : duration(ms)}</Text>
        </Box>
      </Box>
    )

    const items = [
      ...[...prList].reverse().map(pr => ({
        key: prKey(pr),
        label: `#${pr.number}`,
        title: pr.title,
        state: prState(pr) as Shown,
        t: tally(pr.checks),
        pr,
      })),
      ...[...releaseList].reverse().map(r => ({
        key: releaseKey(r),
        label: r.label,
        title: r.runs[0]?.title ?? '',
        state: releaseState(r) as Shown,
        t: tally(releaseItems(r)),
        release: r,
      })),
    ]
    const chosen = await read($, selected)
    const openKey = items.some(item => item.key === chosen) ? chosen : (items[0]?.key ?? '')
    const labelWidth = Math.max(4, ...items.map(item => item.label.length), ...mine.prs.map(pr => `#${pr.number}`.length), ...reviews.prs.map(pr => `#${pr.number}`.length))

    const drawPr = (pr: Pr) => {
      const t = tally(pr.checks)
      const state = prState(pr)
      const hasWorkflows = pr.checks.some(c => c.workflow)
      // Failures and their log first, then everything else.
      const failing = pr.checks.filter(c => c.state === 'fail')
      const others = byUrgency(pr.checks.filter(c => c.state !== 'fail'))
      const checkRow = (c: (typeof pr.checks)[number]) =>
        Row({
          key: `${pr.url}#${c.workflow ?? ''}/${c.name}`,
          state: c.state,
          workflow: hasWorkflows ? c.workflow ?? '' : undefined,
          name: c.name,
          url: c.url,
          ms: c.durationMs,
        })
      const review = reviewLabel(pr.review)
      const merge = mergeLabel(pr)
      return (
        <Box key={`detail-${pr.url}`} flexDirection="column" gap={1}>
          {Raster && isCelebrating(party, f) && party.kind === 'merged' && party.key === prKey(pr) && (
            <Raster
              key="confetti"
              {...toCells(confettiFrame(pr.number, f - party.startFrame, Math.min(inner, 120), 12))}
            />
          )}
          <Box flexDirection="column">
            <Box gap={2}>
              <Link href={pr.url} label={`#${pr.number}`} />
              <Box flexShrink={1} minWidth={0} overflow="hidden">
                <Text bold wrap="truncate-end">
                  {pr.title}
                </Text>
              </Box>
            </Box>
            <Text dimColor wrap="truncate-end">
              {pr.repo.split('/')[1] ?? pr.repo} · {pr.branch}
            </Text>
          </Box>

          <Box flexDirection="column">
            {Verdict({ state, t })}
            {Bar({ t, width: barWidth })}
          </Box>

          {failing.length > 0 && (
            <Box flexDirection="column">
              {failing.map(checkRow)}
            </Box>
          )}

          {(() => {
            const check = shownFailure(pr, chosenLog)
            const jobId = parseActionsUrl(check?.url)?.jobId
            if (!check || !jobId) return null
            const lines = allLogs[jobId]?.lines
            return (
              <Box flexDirection="column">
                <Text bold dimColor wrap="truncate-end">
                  LOG · {check.workflow ? `${check.workflow} / ` : ''}{check.name}
                </Text>
                {lines ? (
                  lines.slice(-LOG_PREVIEW).map((line, i) => (
                    <Text key={`log-${i}`} dimColor wrap="truncate-end">
                      {line}
                    </Text>
                  ))
                ) : (
                  <Text dimColor>{glyph('pending', f)} loading the failed step's log…</Text>
                )}
              </Box>
            )
          })()}

          {others.length > 0 && (
            <Box flexDirection="column">
              {others.slice(0, Math.max(0, MAX_CHECKS - failing.length)).map(checkRow)}
              {failing.length + others.length > MAX_CHECKS && (
                <Box paddingLeft={3}>
                  <Text dimColor>{failing.length + others.length - Math.max(MAX_CHECKS, failing.length)} more</Text>
                </Box>
              )}
            </Box>
          )}

          {settings.heatmap && pr.base && (() => {
            const workflows = [...new Set(pr.checks.map(c => c.workflow).filter((w): w is string => Boolean(w)))].slice(0, 6)
            const rows = workflows.map(w => ({ workflow: w, past: pastRuns[historyKey(pr, w)] })).filter(row => row.past && row.past.results.length > 0)
            if (rows.length === 0) return null
            return (
              <Box flexDirection="column">
                <Text bold dimColor>
                  HISTORY ON {pr.base.toUpperCase()}
                </Text>
                {rows.map(row => (
                  <Box key={`history-${row.workflow}`} gap={2}>
                    <Box width={WORKFLOW_COLUMN} flexShrink={0}>
                      <Text dimColor wrap="truncate-end">
                        {row.workflow}
                      </Text>
                    </Box>
                    <Box>
                      {[...row.past!.results].reverse().map((result, i) => (
                        <Text key={`h-${i}`} color={tone(result)} dimColor={result === 'skip'}>
                          ■
                        </Text>
                      ))}
                    </Box>
                    {isFlaky(row.past!.results) && <Text color="yellow">flaky</Text>}
                  </Box>
                ))}
              </Box>
            )
          })()}

          {(pr.reviews?.length ?? 0) > 0 && (
            <Box gap={3} flexWrap="wrap">
              {(pr.reviews ?? []).map(reviewer => {
                const mark = reviewerGlyph(reviewer.state)
                const face = faces[reviewer.login]
                return (
                  <Box key={`reviewer-${reviewer.login}`} gap={1}>
                    {settings.avatars && Image && face ? (
                      <Image key={`avatar-${reviewer.login}`} source={{ png: face }} columns={2} rows={1} alt={reviewer.login.slice(0, 2)} />
                    ) : null}
                    <Text color={mark.color}>{mark.glyph}</Text>
                    <Text dimColor={reviewer.state === 'REQUESTED'}>{reviewer.login}</Text>
                  </Box>
                )
              })}
            </Box>
          )}

          <Box gap={4}>
            <Box gap={2}>
              <Text dimColor>Review</Text>
              <Text color={review.state === 'skip' ? undefined : tone(review.state)}>{review.text}</Text>
            </Box>
            <Box gap={2}>
              <Text dimColor>Merge</Text>
              <Text color={merge.state === 'skip' ? undefined : tone(merge.state)}>{merge.text}</Text>
            </Box>
          </Box>
          {pr.error && <Text color="yellow">{pr.error}</Text>}
        </Box>
      )
    }

    const drawRelease = (r: Release) => {
      const t = tally(releaseItems(r))
      const state = releaseState(r)
      return (
        <Box key={`detail-${r.key}`} flexDirection="column" gap={1}>
          <Box gap={2}>
            {r.url ? <Link href={r.url} label={r.label} /> : <Text bold>{r.label}</Text>}
            <Text dimColor>release</Text>
          </Box>

          {Raster && settings.invaders && (
            <Raster
              key="invaders"
              {...toCells(
                invadersFrame({
                  invaders: releaseInvaders(r).map(job => ({
                    state: job.state,
                    slot: fleets.get(r.key)?.get(job.key)?.slot,
                    seenAt: fleets.get(r.key)?.get(job.key)?.seenAt,
                    doneAt: doneAt.get(`${r.key}|${job.key}`),
                  })),
                  frame: f,
                  width: Math.min(inner, 120),
                  ship: shipFor(r.key),
                }),
              )}
            />
          )}

          <Box flexDirection="column">
            {Verdict({ state, t })}
            {Bar({ t, width: barWidth })}
          </Box>

          {r.runs.length === 0 && !r.error && (
            <Box gap={2}>
              <Text color="yellow">{glyph('pending', f)}</Text>
              <Text dimColor>waiting for pipelines to start</Text>
            </Box>
          )}
          {r.runs.length > 0 && (
            <Box flexDirection="column">
              {r.runs.map(run => (
                <Box key={`run-${run.id}`} flexDirection="column">
                  {Row({ key: `run-row-${run.id}`, state: run.state, name: run.name, url: run.url || undefined, ms: run.durationMs })}
                  {byUrgency(run.jobs.filter(job => job.state !== 'pass'))
                    .slice(0, MAX_JOBS)
                    .map(job =>
                      Row({
                        key: `job-${run.id}-${job.name}`,
                        indent: 3,
                        state: job.state,
                        name: job.name,
                        url: job.url,
                        ms: job.durationMs,
                        isWaiting: job.isWaiting,
                      }),
                    )}
                </Box>
              ))}
            </Box>
          )}
          {r.error && <Text color="yellow">{r.error}</Text>}
        </Box>
      )
    }

    const isTall = (props.scroll?.bodyRows ?? 40) >= 32
    boardShape = { trackRows: isTall ? 5 : 3, sideRows: isTall ? 3 : 2, isSideBySide: inner >= 100 }
    const shortRepo = (repo: string) => repo.split('/')[1] ?? repo

    const ListRow = ({ key, marker, state, repo, repoWidth, label, title, t, isOpen, buttonKey, onPress }: {
      key: string
      marker: string
      state: Shown
      repo: string
      repoWidth: number
      label: string
      title: string
      t?: Tally
      isOpen: boolean
      buttonKey: string
      onPress: () => unknown
    }) => (
      <Box key={key} gap={1} {...(isOpen || cursorKey === buttonKey ? { backgroundColor: 'userMessageBackground' } : {})}>
        <Text color="cyan" dimColor={!isOpen}>
          {marker}
        </Text>
        <Text color={tone(state)}>{glyph(state, f)}</Text>
        {repoWidth > 0 && (
          <Box width={repoWidth} flexShrink={0}>
            <Text dimColor wrap="truncate-end">
              {repo}
            </Text>
          </Box>
        )}
        <Box width={labelWidth} flexShrink={0}>
          <Button key={buttonKey} plain dimColor={!isOpen} label={clip(label, labelWidth)} onPress={onPress} />
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text bold={isOpen} dimColor={!isOpen} wrap="truncate-end">
            {title}
          </Text>
        </Box>
        {t && Bar({ t, width: 6 })}
        {t && (
          <Box width={5} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>
              {t.pass}/{t.total}
            </Text>
          </Box>
        )}
      </Box>
    )

    const tracked = new Set(prList.map(pr => pr.url))
    const trackAndOpen = async (url: string) => {
      await trackPr($, url)
      await update($, selected, () => `pr:${url}`)
    }
    const untracked = mine.prs.filter(pr => !tracked.has(pr.url))
    const toReview = reviews.prs.filter(pr => !tracked.has(pr.url))
    const prItems = items.filter(item => 'pr' in item)
    const actionItems = items.filter(item => 'release' in item)
    const isListShown = shown !== 'detail'
    const sections = {
      tracking: isListShown ? [...prItems, ...actionItems].map(item => `${ITEM}${item.key}`) : [],
      mine: isListShown ? untracked.map(pr => `${ADD}${pr.url}`) : [],
      reviews: isListShown && !reviews.error ? toReview.map(pr => `${REVIEW}${pr.url}`) : [],
    }
    rowKeys = [...sections.tracking, ...sections.mine, ...sections.reviews]
    sectionRows = sections
    drawnRows = new Set()
    type Section = keyof typeof sections
    const active: Section = (Object.keys(sections) as Section[]).find(id => sections[id].includes(cursorKey)) ?? 'tracking'
    const focusIn = (id: Section) =>
      sections[id].includes(cursorKey) ? cursorKey : id === 'tracking' && openKey ? `${ITEM}${openKey}` : ''
    const where = (id: Section) => {
      const keys = sections[id]
      const at = keys.indexOf(focusIn(id))
      return keys.length === 0 ? '' : at === -1 ? ` · ${keys.length}` : ` · ${at + 1} of ${keys.length}`
    }
    const Heading = ({ id, label }: { id: Section; label: string }) => (
      <Button
        key={`${SECTION}${id}`}
        plain
        dimColor={id !== active}
        hotkey={String(Object.keys(sections).indexOf(id) + 1)}
        label={`${label}${where(id)}`}
        onPress={() => jumpToSection($, id)}
      />
    )

    // A fixed-height list: heading, `size` lines scrolled to keep the cursor in
    // view, and a line saying what's above and below.
    type Line = { key: string; draw: () => RenderChildren }
    const ListBlock = ({ id, label, lines, size, empty }: { id: Section; label: string; lines: Line[]; size: number; empty: string }) => {
      const at = lines.findIndex(line => line.key !== '' && line.key === focusIn(id))
      const first = scrollWindow(windowStarts.get(id) ?? 0, at, lines.length, size)
      windowStarts.set(id, first)
      const visible = lines.slice(first, first + size)
      for (const line of visible) if (line.key) drawnRows.add(line.key)
      const above = lines.slice(0, first).filter(line => line.key).length
      const below = lines.slice(first + size).filter(line => line.key).length
      const more = [above > 0 && `↑ ${above} above`, below > 0 && `↓ ${below} below`].filter(Boolean).join(' · ')
      return (
        <Box key={`list-${id}`} flexDirection="column" height={size + 2} flexGrow={1} flexShrink={1} minWidth={0}>
          {Heading({ id, label })}
          <Box flexDirection="column" height={size}>
            {visible.length > 0 ? visible.map(line => line.draw()) : <Text dimColor wrap="truncate-end">{empty}</Text>}
          </Box>
          <Text dimColor wrap="truncate-end">
            {more || ' '}
          </Text>
        </Box>
      )
    }

    const trackedWidth = Math.min(14, Math.max(0, ...prItems.map(item => ('pr' in item ? shortRepo(item.pr.repo).length : 0))))
    const trackedLine = (item: (typeof items)[number]): Line => ({
      key: `${ITEM}${item.key}`,
      draw: () =>
        ListRow({
          key: `row-${item.key}`,
          state: item.state,
          repo: 'pr' in item ? shortRepo(item.pr.repo) : '',
          repoWidth: trackedWidth,
          label: item.label,
          title: item.title,
          t: item.t,
          isOpen: item.key === openKey,
          marker: item.key === openKey ? '▌' : ' ',
          buttonKey: `${ITEM}${item.key}`,
          onPress: () => openItem($, item.key),
        }),
    })
    const trackingLines: Line[] = [
      ...prItems.map(trackedLine),
      ...(prItems.length > 0 && actionItems.length > 0
        ? [{ key: '', draw: () => <Text key="actions-rule" dimColor wrap="truncate">{`Actions ${'─'.repeat(200)}`}</Text> }]
        : []),
      ...actionItems.map(trackedLine),
    ]

    const mineRepo = mine.repo ? shortRepo(mine.repo) : ''
    const mineLines: Line[] = untracked.map(pr => ({
      key: `${ADD}${pr.url}`,
      draw: () =>
        ListRow({
          key: `mine-${pr.url}`,
          state: pr.checks.length === 0 ? 'skip' : overall(pr.checks),
          repo: mineRepo,
          repoWidth: Math.min(14, mineRepo.length),
          label: `#${pr.number}`,
          title: pr.isDraft ? `${pr.title} (draft)` : pr.title,
          t: tally(pr.checks),
          isOpen: false,
          marker: '+',
          buttonKey: `${ADD}${pr.url}`,
          onPress: () => trackAndOpen(pr.url),
        }),
    }))

    const reviewWidth = Math.min(14, Math.max(0, ...toReview.map(pr => shortRepo(pr.repo).length)))
    const reviewLines: Line[] = toReview.map(pr => ({
      key: `${REVIEW}${pr.url}`,
      draw: () =>
        ListRow({
          key: `review-${pr.url}`,
          state: 'skip',
          repo: shortRepo(pr.repo),
          repoWidth: reviewWidth,
          label: `#${pr.number}`,
          title: pr.title,
          isOpen: false,
          marker: '?',
          buttonKey: `${REVIEW}${pr.url}`,
          onPress: () => trackAndOpen(pr.url),
        }),
    }))

    const open = items.find(item => item.key === openKey)
    const detail = open ? ('pr' in open ? drawPr(open.pr) : drawRelease(open.release)) : null
    const openPr = open && 'pr' in open ? open.pr : undefined
    const failingChecks = openPr?.checks.filter(c => c.state === 'fail') ?? []
    const hasFailedRuns = open && 'release' in open && open.release.runs.some(run => run.state === 'fail')

    const trackingBlock = ListBlock({
      id: 'tracking',
      label: 'TRACKING',
      lines: trackingLines,
      size: boardShape.trackRows,
      empty: 'Nothing yet. Pick one of your PRs below, or /pulse-pr and /pulse-release.',
    })
    const mineBlock = ListBlock({
      id: 'mine',
      label: 'YOUR OPEN PRS',
      lines: mineLines,
      size: boardShape.sideRows,
      empty: mine.error ?? (mine.prs.length > 0 ? 'All tracked.' : 'None open.'),
    })
    const reviewBlock = ListBlock({
      id: 'reviews',
      label: 'WAITING ON YOUR REVIEW',
      lines: reviewLines,
      size: boardShape.sideRows,
      empty: reviews.error ?? (reviews.prs.length > 0 ? 'All tracked.' : 'None.'),
    })

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {/* Help on its own line so it never gets truncated. */}
        <Box flexDirection="column">
          <Box gap={3} flexWrap="wrap">
            <Button key="refresh" plain dimColor hotkey="r" label="Refresh" onPress={() => showWhile($, 'Refreshing', () => Promise.all([poll($, true), refreshLists($)]))} />
            <Button
              key="layout"
              plain
              dimColor
              hotkey="m"
              label={LAYOUT_LABEL[NEXT_LAYOUT[shown]]}
              onPress={() => cycleLayout($)}
            />
            {failingChecks.length > 0 && (
              <Button key="fix" plain hotkey="f" label="Fix it" onPress={() => showWhile($, 'Reading the failing logs', () => fixIt($, openKey, e.surface))} />
            )}
            {(failingChecks.length > 0 || hasFailedRuns) && (
              <Button key="rerun" plain dimColor hotkey="e" label="Rerun failed" onPress={() => showWhile($, 'Rerunning the failed jobs', () => rerunFailed($, openKey))} />
            )}
            {failingChecks.length > 1 && (
              <Button key="log" plain dimColor hotkey="l" label="Next log" onPress={() => showWhile($, 'Loading the log', () => nextLog($, openKey))} />
            )}
            {failingChecks.length > 0 && (
              <Button key="copy" plain dimColor hotkey="y" label="Copy log" onPress={() => copyLog($, openKey, e.surface)} />
            )}
            {openPr && reviews.prs.some(one => one.url === openPr.url) && (
              <Button key="ask" plain hotkey="a" label="Review with Claude" onPress={() => askForReview($, openPr.url)} />
            )}
            {openKey && <Button key="open" plain dimColor hotkey="o" label="Open" onPress={() => openInBrowser($, openKey)} />}
            {openKey && <Button key="remove" plain dimColor hotkey="x" label="Remove" onPress={() => untrack($, openKey)} />}
            {items.length > 0 && <Button key="clear" plain dimColor hotkey="c" label="Clear" onPress={() => clearAll($)} />}
            {kept && <Button key="undo" plain hotkey="z" label={`Undo (${kept.label})`} onPress={() => undoRemoval($)} />}
            <Button
              key="keys"
              plain
              dimColor
              hotkey="h"
              label={isShowingKeys ? 'Hide keys' : 'Keys'}
              onPress={() => update($, isKeysShown, shown => !shown)}
            />
          </Box>
          {doing ? (
            <Text color="yellow" wrap="truncate-end">
              {glyph('pending', f)} {doing}…
            </Text>
          ) : (
            <Text dimColor wrap="truncate-end">
              {props.isFocused ? '↑↓ move · 1 2 3 sections · enter select or track · h all keys · esc back to prompt' : 'ctrl+x tab or click to use the keyboard'}
            </Text>
          )}
        </Box>

        {isShowingKeys && (
          <Box key="keys-list" flexDirection="column">
            {KEYS.map(([keys, does]) => (
              <Box key={`key-${keys}`} gap={1}>
                <Box width={10} flexShrink={0}>
                  <Text color="cyan">{keys}</Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {does}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Lists first at fixed heights, so the open item always starts on the same row. */}
        {isListShown && trackingBlock}
        {isListShown &&
          (boardShape.isSideBySide ? (
            <Box key="side-lists" gap={3}>
              {mineBlock}
              {reviewBlock}
            </Box>
          ) : (
            <Box key="side-lists" flexDirection="column" gap={1}>
              {mineBlock}
              {reviewBlock}
            </Box>
          ))}

        {shown !== 'list' && detail}
        {shown === 'detail' && !detail && <Text dimColor>Nothing open. Press m to bring the list back.</Text>}
      </Box>
    )
  })
}
