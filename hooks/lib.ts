import type { Check, CheckState, Job, OpenPr, Pr, Release, ReviewRequest, Reviewer, Run, Setup } from '../types'

// ── gh JSON → our shapes ────────────────────────────────────────────────

type RawCheck = {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  startedAt?: string
  completedAt?: string
}

const FAIL = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
])
const SKIP = new Set(['SKIPPED', 'NEUTRAL'])

/** One verdict from a CheckRun's status/conclusion or a StatusContext's state. */
export function checkState(status?: string, conclusion?: string): CheckState {
  const s = (status ?? '').toUpperCase()
  const c = (conclusion ?? '').toUpperCase()
  if (c === 'SUCCESS') return 'pass'
  if (FAIL.has(c)) return 'fail'
  if (SKIP.has(c)) return 'skip'
  if (s === 'SUCCESS') return 'pass'
  if (s === 'FAILURE' || s === 'ERROR') return 'fail'
  return 'pending'
}

/** Wall time between two timestamps, if both are real and in order. */
export function elapsed(from?: string, to?: string): number | undefined {
  const start = Date.parse(from ?? '')
  const end = Date.parse(to ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return end - start
}

function safeUrl(url?: string): string | undefined {
  return url && /^https:\/\/[\x21-\x7e]+$/.test(url) && !url.includes('@') ? url : undefined
}

export function parseChecks(rollup: unknown): Check[] {
  if (!Array.isArray(rollup)) return []
  return (rollup as RawCheck[]).map(raw => {
    if (raw.__typename === 'StatusContext') {
      return { name: raw.context ?? 'status', state: checkState(raw.state), url: safeUrl(raw.targetUrl) }
    }
    const state = checkState(raw.status, raw.conclusion)
    return {
      name: raw.name || 'check',
      state,
      url: safeUrl(raw.detailsUrl),
      workflow: raw.workflowName || undefined,
      durationMs: state === 'pending' ? undefined : elapsed(raw.startedAt, raw.completedAt),
    }
  })
}

export function repoOf(url: string): string {
  const m = /github\.com\/([^/]+\/[^/]+)\//.exec(url)
  return m?.[1] ?? ''
}

export function parsePr(json: string): Pr {
  const raw = JSON.parse(json) as Record<string, unknown>
  const url = String(raw.url ?? '')
  return {
    url,
    number: Number(raw.number ?? 0),
    repo: repoOf(url),
    title: String(raw.title ?? ''),
    branch: String(raw.headRefName ?? ''),
    state: (String(raw.state ?? 'OPEN') as Pr['state']),
    isDraft: raw.isDraft === true,
    review: String(raw.reviewDecision ?? ''),
    mergeable: String(raw.mergeable ?? 'UNKNOWN'),
    checks: parseChecks(raw.statusCheckRollup),
    base: raw.baseRefName ? String(raw.baseRefName) : undefined,
    reviews: parseReviewers(raw.latestReviews, raw.reviewRequests),
  }
}

export function parseOpenPrs(json: string): OpenPr[] {
  const list = JSON.parse(json) as Record<string, unknown>[]
  return list.map(raw => ({
    url: String(raw.url ?? ''),
    number: Number(raw.number ?? 0),
    title: String(raw.title ?? ''),
    isDraft: raw.isDraft === true,
    checks: parseChecks(raw.statusCheckRollup),
  }))
}

type RawRun = {
  databaseId?: number
  name?: string
  workflowName?: string
  displayTitle?: string
  url?: string
  status?: string
  conclusion?: string
  headBranch?: string
  startedAt?: string
  updatedAt?: string
  attempt?: number
}

export function parseRuns(json: string): Run[] {
  const list = JSON.parse(json) as RawRun[]
  return list.map(raw => {
    const state = checkState(raw.status, raw.conclusion)
    return {
      id: Number(raw.databaseId ?? 0),
      name: raw.workflowName ?? raw.name ?? 'workflow',
      title: raw.displayTitle ?? '',
      url: safeUrl(raw.url) ?? '',
      state,
      branch: raw.headBranch ?? '',
      attempt: Number(raw.attempt ?? 1),
      durationMs: state === 'pending' ? undefined : elapsed(raw.startedAt, raw.updatedAt),
      jobs: [],
    }
  })
}

export function parseJobs(json: string): Job[] {
  const raw = JSON.parse(json) as { jobs?: RawCheck[] }
  return (raw.jobs ?? []).map(job => {
    const state = checkState(job.status, job.conclusion)
    return {
      name: job.name ?? 'job',
      state,
      url: safeUrl((job as { url?: string }).url),
      durationMs: state === 'pending' ? undefined : elapsed(job.startedAt, job.completedAt),
    }
  })
}

// ── Finding things in Bash output ───────────────────────────────────────

export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/
export const RELEASE_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/tag\/([^\s"'<>]+)/

export function isPrCreate(command: string): boolean {
  return /\bgh\s+pr\s+create\b/.test(command)
}

export function isReleaseCreate(command: string): boolean {
  return /\bgh\s+release\s+create\b/.test(command)
}

const VALUE_FLAGS = new Set(['-r', '--ref', '-f', '--raw-field', '-F', '--field', '-R', '--repo'])

/** The workflow named in `gh workflow run <wf>`, if that's what ran. */
export function workflowRun(command: string): string | undefined {
  const m = /\bgh\s+workflow\s+run\s+(.*)$/.exec(command.split(/&&|;|\|/)[0] ?? '')
  const tokens = (m?.[1] ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (token.startsWith('-')) {
      if (VALUE_FLAGS.has(token)) i++
      continue
    }
    return token.replace(/^['"]|['"]$/g, '')
  }
  return undefined
}

// ── Tallies ─────────────────────────────────────────────────────────────

export type Tally = { pass: number; fail: number; pending: number; skip: number; total: number }

export function tally(items: readonly { state: CheckState }[]): Tally {
  const t: Tally = { pass: 0, fail: 0, pending: 0, skip: 0, total: items.length }
  for (const item of items) t[item.state] += 1
  return t
}

/** The verdict of a group: any failure fails, any pending pends, else pass. */
export function overall(items: readonly { state: CheckState }[]): CheckState {
  const t = tally(items)
  if (t.fail > 0) return 'fail'
  if (t.pending > 0) return 'pending'
  if (t.pass > 0) return 'pass'
  return t.skip > 0 ? 'skip' : 'pending'
}

export function releaseState(release: Release): CheckState {
  return release.runs.length === 0 ? 'pending' : overall(release.runs)
}

export function prState(pr: Pr): CheckState | 'merged' | 'closed' {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  return pr.checks.length === 0 ? 'pending' : overall(pr.checks)
}

/**
 * Still moving: something has yet to finish. Not the same as the verdict being
 * 'pending' — one failure decides the verdict while the rest keep running.
 */
export function isRunning(items: readonly { state: CheckState }[]): boolean {
  return items.some(item => item.state === 'pending')
}

export function isPrRunning(pr: Pr): boolean {
  return pr.state === 'OPEN' && (pr.checks.length === 0 || isRunning(pr.checks))
}

export function isReleaseRunning(release: Release): boolean {
  return release.runs.length === 0 || isRunning(release.runs) || isRunning(release.runs.flatMap(run => run.jobs))
}

export function isLive(prs: readonly Pr[], releases: readonly Release[]): boolean {
  return prs.some(isPrRunning) || releases.some(isReleaseRunning)
}

// ── Look ────────────────────────────────────────────────────────────────

export type Shown = CheckState | 'merged' | 'closed'

/** Braille dots chasing round a cell, for anything in flight. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * One cell filling, a dot at a time: the left column bottom-up, then the
 * right, from the empty track (⣀) to full (⣿).
 */
export const FILL = ['⣀', '⣄', '⣆', '⣇', '⣧', '⣷', '⣿'] as const
const STEPS_PER_CELL = FILL.length - 1
/** How often the board animates: the loader moves one dot a frame. */
export const FRAME_MS = 50
/** Frames per spinner step: keeps the spinner at its usual 100ms. */
export const SPINNER_EVERY = 2
/** Frames the bar holds full before it empties and starts again: ~0.4s. */
export const HOLD_FRAMES = 8

function at<T>(list: readonly T[], n: number): T {
  return list[((n % list.length) + list.length) % list.length] as T
}

export function glyph(state: Shown, frame = 0): string {
  switch (state) {
    case 'pass':
      return '✓'
    case 'fail':
      return '✕'
    case 'skip':
      return '–'
    case 'merged':
      return '●'
    case 'closed':
      return '○'
    default:
      return at(SPINNER, Math.floor(frame / SPINNER_EVERY))
  }
}

/** Color carries state and nothing else. */
export function tone(state: Shown): string {
  switch (state) {
    case 'pass':
      return 'green'
    case 'fail':
      return 'red'
    case 'pending':
      return 'yellow'
    case 'merged':
      return 'magenta'
    default:
      return 'gray'
  }
}

export function verdict(state: Shown): string {
  switch (state) {
    case 'pass':
      return 'Passing'
    case 'fail':
      return 'Failing'
    case 'skip':
      return 'Skipped'
    case 'merged':
      return 'Merged'
    case 'closed':
      return 'Closed'
    default:
      return 'Running'
  }
}

/** "5 passed · 1 failed · 3 running · 1 skipped", zero counts left out. */
export function summary(t: Tally): string {
  const parts = [
    t.pass && `${t.pass} passed`,
    t.fail && `${t.fail} failed`,
    t.pending && `${t.pending} running`,
    t.skip && `${t.skip} skipped`,
  ].filter(Boolean)
  return parts.length === 0 ? 'no checks yet' : parts.join(' · ')
}

/** The non-passing part of a summary, for the one-line band. */
export function trouble(t: Tally): string {
  const parts = [t.fail && `${t.fail} failed`, t.pending && `${t.pending} running`].filter(Boolean)
  return parts.length === 0 ? (t.total > 0 ? 'all passed' : 'no checks yet') : parts.join(' · ')
}

export type Segment = { state: CheckState; width: number }

const BAR_ORDER: readonly CheckState[] = ['pass', 'fail', 'pending', 'skip']

/**
 * A bar `width` cells wide split by state, largest-remainder rounded so the
 * cells always add up; any state present keeps at least one cell.
 */
export function segments(t: Tally, width: number): Segment[] {
  if (t.total === 0) return [{ state: 'skip', width }]
  const present = BAR_ORDER.filter(state => t[state] > 0)
  const floor = Math.min(1, Math.floor(width / present.length))
  const spare = width - floor * present.length
  const exact = present.map(state => (t[state] / t.total) * spare)
  const cells = exact.map(Math.floor)
  let left = spare - cells.reduce((a, b) => a + b, 0)
  const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  for (const { i } of byRemainder) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }
  return present.map((state, i) => ({ state, width: (cells[i] ?? 0) + floor }))
}

/**
 * A segment drawn in braille. Finished states are solid; a running one is a
 * loader, filling one dot a frame (left column bottom-up, then the right),
 * holding, then starting over.
 */
export function cells(seg: Segment, frame = 0): string {
  if (seg.state === 'pass' || seg.state === 'fail') return '⣿'.repeat(seg.width)
  if (seg.state === 'skip') return '⣀'.repeat(seg.width)
  const total = seg.width * STEPS_PER_CELL
  // One dot a frame, every step shown: a steady ~3 cells a second at any width.
  const cycle = total + HOLD_FRAMES
  const filled = Math.min(total, ((frame % cycle) + cycle) % cycle)
  let out = ''
  for (let i = 0; i < seg.width; i++) {
    out += FILL[Math.max(0, Math.min(STEPS_PER_CELL, filled - i * STEPS_PER_CELL))]
  }
  return out
}

/** 4s · 38s · 1m 02s · 1h 03m */
export function duration(ms?: number): string {
  if (ms === undefined) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Failures first, then running, passed, skipped. */
export function byUrgency<T extends { state: CheckState }>(items: readonly T[]): T[] {
  const rank: Record<CheckState, number> = { fail: 0, pending: 1, pass: 2, skip: 3 }
  return [...items].sort((a, b) => rank[a.state] - rank[b.state])
}

export function reviewLabel(review: string): { text: string; state: Shown } {
  switch (review) {
    case 'APPROVED':
      return { text: 'approved', state: 'pass' }
    case 'CHANGES_REQUESTED':
      return { text: 'changes requested', state: 'fail' }
    case 'REVIEW_REQUIRED':
      return { text: 'required', state: 'pending' }
    default:
      return { text: 'none yet', state: 'skip' }
  }
}

export function mergeLabel(pr: Pr): { text: string; state: Shown } {
  if (pr.isDraft) return { text: 'draft', state: 'skip' }
  switch (pr.mergeable) {
    case 'MERGEABLE':
      return { text: 'clean', state: 'pass' }
    case 'CONFLICTING':
      return { text: 'conflicts', state: 'fail' }
    default:
      return { text: 'checking', state: 'skip' }
  }
}

/** A release's jobs (or its runs, before their jobs are known), each with a key that survives a re-run's new attempt as a new key. */
export function releaseInvaders(release: Release): { key: string; state: CheckState }[] {
  const jobs = release.runs.flatMap(run => run.jobs.map(job => ({ key: `${run.id}:${run.attempt ?? 1}:${job.name}`, state: job.state })))
  return jobs.length > 0 ? jobs : release.runs.map(run => ({ key: `${run.id}:${run.attempt ?? 1}`, state: run.state }))
}

export function releaseItems(release: Release): readonly { state: CheckState }[] {
  const jobs = release.runs.flatMap(run => run.jobs)
  return jobs.length > 0 ? jobs : release.runs
}

/** The status line: ✕ #130 5/10 · ◐ v1.4.0 4/6 */
export function statusLine(prs: readonly Pr[], releases: readonly Release[], frame: number): string | undefined {
  const parts: string[] = []
  for (const pr of prs.slice(-2)) {
    const t = tally(pr.checks)
    parts.push(`${glyph(prState(pr), frame)} #${pr.number} ${t.pass}/${t.total}`)
  }
  for (const r of releases.slice(-1)) {
    const t = tally(releaseItems(r))
    parts.push(`${glyph(releaseState(r), frame)} ${r.label} ${t.pass}/${t.total}`)
  }
  return parts.length === 0 ? undefined : parts.join('  ·  ')
}

// ── Transitions worth a toast ───────────────────────────────────────────

export function prToast(before: Pr | undefined, after: Pr): string | undefined {
  const was = before ? prState(before) : undefined
  const now = prState(after)
  if (was === now || after.error) return undefined
  const tag = `PR #${after.number}`
  if (now === 'merged') return `${tag} · merged`
  if (now === 'closed') return `${tag} · closed`
  if (now === 'pass' && was !== undefined) return `${tag} · all checks passed`
  if (now === 'fail') {
    const failed = after.checks.filter(c => c.state === 'fail').map(c => c.name)
    return `${tag} · ${failed.slice(0, 2).join(', ')}${failed.length > 2 ? ` +${failed.length - 2}` : ''} failed`
  }
  return undefined
}

export function releaseToast(before: Release | undefined, after: Release): string | undefined {
  const was = before ? releaseState(before) : undefined
  const now = releaseState(after)
  if (was === now || after.error || after.runs.length === 0) return undefined
  if (now === 'pass' && was !== undefined) return `${after.label} · released`
  if (now === 'fail') {
    const failed = after.runs.filter(run => run.state === 'fail').map(run => run.name)
    return `${after.label} · ${failed.slice(0, 2).join(', ') || 'a pipeline'} failed`
  }
  return undefined
}

// ── Setup: gh installed and logged in ───────────────────────────────────

export const GH_DOWNLOAD = 'https://cli.github.com'

export function installCommand(os: Setup['os']): string | undefined {
  switch (os) {
    case 'mac':
      return 'brew install gh'
    case 'windows':
      return 'winget install --id GitHub.cli'
    default:
      return undefined // Linux has a package per distro: the download page says which
  }
}

/** What to tell the person, or nothing once gh is ready (or not yet checked). */
export function setupAdvice(setup: Setup): { title: string; steps: string[] } | undefined {
  if (setup.gh === 'missing') {
    const install = installCommand(setup.os)
    return {
      title: 'gh-pulse needs the GitHub CLI',
      steps: [
        install ? `Install it: ${install}  (or ${GH_DOWNLOAD})` : `Install it: ${GH_DOWNLOAD}`,
        'Then sign in: gh auth login',
      ],
    }
  }
  if (setup.gh === 'signed-out') {
    return {
      title: 'gh-pulse needs you signed in to GitHub',
      steps: ['Run in a terminal: gh auth login', 'gh-pulse picks it up by itself within 15s'],
    }
  }
  return undefined
}

export function setupText(setup: Setup): string | undefined {
  const advice = setupAdvice(setup)
  return advice && `${advice.title}.\n${advice.steps.map(step => `  ${step}`).join('\n')}`
}

// ── Check URLs, logs and the fix-it prompt ──────────────────────────────

/** The Actions run and job a check links to; undefined for status contexts and other CI. */
export function parseActionsUrl(url?: string): { runId: string; jobId?: string } | undefined {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url ?? '')
  return m?.[1] ? { runId: m[1], jobId: m[2] } : undefined
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/

/**
 * `gh run view --log-failed` lines are `job<TAB>step<TAB>timestamp text`: keep
 * the text, drop colour codes and the runner's group markers, keep the tail.
 */
export function cleanLog(raw: string, keep = 80): string[] {
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    const parts = line.split('\t')
    let text = (parts.length >= 3 ? parts.slice(2).join('\t') : line).replace(ANSI, '').replace(STAMP, '')
    text = text.replace(/^##\[(group|endgroup)\]/, '').trimEnd()
    if (text.startsWith('##[')) text = text.replace(/^##\[\w+\]/, '')
    if (text.trim() === '') continue
    lines.push(text)
  }
  return lines.slice(-keep)
}

export type Failure = { name: string; workflow?: string; url?: string; log?: string[] }

/** The prompt `f` puts in the box: what failed, where, and the end of each log. */
export function fixPrompt(pr: Pr, failures: readonly Failure[]): string {
  const parts = [
    `CI is failing on PR #${pr.number} "${pr.title}" (${pr.repo}, branch \`${pr.branch}\`).`,
    '',
  ]
  for (const f of failures) {
    parts.push(`Failing check: ${f.workflow ? `${f.workflow} / ` : ''}${f.name}${f.url ? ` (${f.url})` : ''}`)
    if (f.log && f.log.length > 0) {
      parts.push('```', ...f.log.slice(-60), '```')
    } else {
      parts.push('(no log available from GitHub Actions for this check)')
    }
    parts.push('')
  }
  parts.push(`Find the cause and fix it on branch \`${pr.branch}\`.`)
  return parts.join('\n')
}

// ── Transitions: what just happened, for toasts, sounds and celebrations ─

export type Transition = 'green' | 'failed' | 'merged' | 'closed' | 'released' | 'scrubbed'

export function prTransition(before: Pr | undefined, after: Pr): Transition | undefined {
  if (!before || after.error) return undefined
  const was = prState(before)
  const now = prState(after)
  if (was === now) return undefined
  if (now === 'merged') return 'merged'
  if (now === 'closed') return 'closed'
  if (now === 'pass') return 'green'
  if (now === 'fail') return 'failed'
  return undefined
}

export function releaseTransition(before: Release | undefined, after: Release): Transition | undefined {
  if (!before || after.error || after.runs.length === 0) return undefined
  const was = releaseState(before)
  const now = releaseState(after)
  if (was === now) return undefined
  if (now === 'pass') return 'released'
  if (now === 'fail') return 'scrubbed'
  return undefined
}

// ── Settings ────────────────────────────────────────────────────────────

export type Settings = {
  claudeContext: boolean
  confetti: boolean
  invaders: boolean
  avatars: boolean
  heatmap: boolean
  sounds: boolean
  speech: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  claudeContext: true,
  confetti: true,
  invaders: true,
  avatars: true,
  heatmap: true,
  sounds: false,
  speech: false,
}

/** The manifest's userConfig values as register() receives them, defaults for anything missing. */
export function readSettings(options: Readonly<Record<string, unknown>> | undefined): Settings {
  const out = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(out) as (keyof Settings)[]) {
    const value = options?.[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}

// ── Review requests ─────────────────────────────────────────────────────

export function parseReviewRequests(json: string): ReviewRequest[] {
  const list = JSON.parse(json) as Record<string, unknown>[]
  return list.map(raw => {
    const repo = raw.repository as { nameWithOwner?: string; name?: string } | undefined
    const url = String(raw.url ?? '')
    return {
      url,
      number: Number(raw.number ?? 0),
      title: String(raw.title ?? ''),
      repo: repo?.nameWithOwner ?? repoOf(url),
    }
  })
}

export function reviewPrompt(request: { url: string; number: number; title: string }): string {
  return `Review PR #${request.number} "${request.title}" (${request.url}). Use gh to read the diff and any discussion, then give me a concise review: real problems first, then suggestions.`
}

// ── What Claude is told about your CI ───────────────────────────────────

const CONTEXT_LIMIT = 600

/** One line per tracked item, for the model: what is failing, what is running. */
export function ciContext(prs: readonly Pr[], releases: readonly Release[]): string | undefined {
  const lines: string[] = []
  for (const pr of [...prs].reverse()) {
    const state = prState(pr)
    const t = tally(pr.checks)
    const failing = pr.checks.filter(c => c.state === 'fail').map(c => (c.workflow ? `${c.workflow} / ${c.name}` : c.name))
    const parts = [`PR #${pr.number} "${pr.title}" (${pr.repo}, branch ${pr.branch}): ${verdict(state).toUpperCase()}`]
    if (failing.length > 0) parts.push(`failing: ${failing.join(', ')}`)
    if (t.pending > 0) parts.push(`${t.pending} running`)
    if (state !== 'merged' && state !== 'closed') parts.push(`${t.pass}/${t.total} passed`, `review ${reviewLabel(pr.review).text}`)
    lines.push(parts.join('; '))
  }
  for (const r of [...releases].reverse()) {
    const t = tally(releaseItems(r))
    const failed = r.runs.filter(run => run.state === 'fail').map(run => run.name)
    lines.push(
      `Release ${r.label}: ${verdict(releaseState(r)).toUpperCase()}; ${t.pass}/${t.total} done${failed.length > 0 ? `; failed: ${failed.join(', ')}` : ''}`,
    )
  }
  if (lines.length === 0) return undefined
  let text = `gh-pulse (live CI status of what the user is tracking):\n${lines.map(line => `- ${line}`).join('\n')}`
  if (text.length > CONTEXT_LIMIT) text = `${text.slice(0, CONTEXT_LIMIT - 1)}…`
  return text
}

// ── Reviewers ───────────────────────────────────────────────────────────

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'])

/** Latest review per person, then anyone still asked, each once. Teams are left out. */
export function parseReviewers(latest: unknown, requested: unknown): Reviewer[] | undefined {
  if (!Array.isArray(latest) && !Array.isArray(requested)) return undefined
  const out: Reviewer[] = []
  const seen = new Set<string>()
  for (const raw of (Array.isArray(latest) ? latest : []) as { author?: { login?: string }; state?: string }[]) {
    const login = raw.author?.login
    const state = String(raw.state ?? '')
    if (!login || seen.has(login) || !REVIEW_STATES.has(state)) continue
    seen.add(login)
    out.push({ login, state: state as Reviewer['state'] })
  }
  for (const raw of (Array.isArray(requested) ? requested : []) as { login?: string }[]) {
    if (!raw.login || seen.has(raw.login)) continue
    seen.add(raw.login)
    out.push({ login: raw.login, state: 'REQUESTED' })
  }
  return out
}

export function reviewerGlyph(state: Reviewer['state']): { glyph: string; color: string } {
  switch (state) {
    case 'APPROVED':
      return { glyph: '✓', color: 'green' }
    case 'CHANGES_REQUESTED':
      return { glyph: '✕', color: 'red' }
    case 'COMMENTED':
      return { glyph: '…', color: 'gray' }
    default:
      return { glyph: '○', color: 'yellow' }
  }
}

/** A GitHub login safe to put in an avatar URL. */
export function isPlainLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
}

// ── CI history ──────────────────────────────────────────────────────────

export function parseHistory(json: string): CheckState[] {
  const list = JSON.parse(json) as { status?: string; conclusion?: string }[]
  return list.map(raw => checkState(raw.status, raw.conclusion))
}

/** Flaky: passes and fails interleave (three or more flips between them). */
export function isFlaky(results: readonly CheckState[]): boolean {
  const decided = results.filter(r => r === 'pass' || r === 'fail')
  let flips = 0
  for (let i = 1; i < decided.length; i++) if (decided[i] !== decided[i - 1]) flips += 1
  return flips >= 3
}

// ── Saying it out loud ──────────────────────────────────────────────────

export function spoken(label: string, happened: Transition): string {
  switch (happened) {
    case 'green':
      return `${label} is green`
    case 'failed':
      return `${label} failed`
    case 'merged':
      return `${label} merged`
    case 'closed':
      return `${label} was closed`
    case 'released':
      return `${label} released`
    default:
      return `${label} release failed`
  }
}

export const SOUND_FOR: Record<Transition, string | undefined> = {
  green: 'assets/sounds/green.wav',
  failed: 'assets/sounds/failed.wav',
  merged: 'assets/sounds/merged.wav',
  closed: undefined,
  released: 'assets/sounds/released.wav',
  scrubbed: 'assets/sounds/failed.wav',
}

