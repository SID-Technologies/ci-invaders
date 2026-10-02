import type { Check, CheckState, Job, Pr, Release, Run } from '../types'

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

function safeUrl(url?: string): string | undefined {
  return url && /^https:\/\/[\x21-\x7e]+$/.test(url) && !url.includes('@') ? url : undefined
}

export function parseChecks(rollup: unknown): Check[] {
  if (!Array.isArray(rollup)) return []
  return (rollup as RawCheck[]).map(raw => {
    const isContext = raw.__typename === 'StatusContext'
    const name = isContext
      ? raw.context ?? 'status'
      : [raw.workflowName, raw.name].filter(Boolean).join(' / ') || 'check'
    const state = isContext ? checkState(raw.state) : checkState(raw.status, raw.conclusion)
    return { name, state, url: safeUrl(isContext ? raw.targetUrl : raw.detailsUrl) }
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
  }
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
}

export function parseRuns(json: string): Run[] {
  const list = JSON.parse(json) as RawRun[]
  return list.map(raw => ({
    id: Number(raw.databaseId ?? 0),
    name: raw.workflowName ?? raw.name ?? 'workflow',
    title: raw.displayTitle ?? '',
    url: safeUrl(raw.url) ?? '',
    state: checkState(raw.status, raw.conclusion),
    branch: raw.headBranch ?? '',
    jobs: [],
  }))
}

export function parseJobs(json: string): Job[] {
  const raw = JSON.parse(json) as { jobs?: RawCheck[] }
  return (raw.jobs ?? []).map(job => ({
    name: job.name ?? 'job',
    state: checkState(job.status, job.conclusion),
    url: safeUrl((job as { url?: string }).url),
  }))
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

export function isLive(prs: readonly Pr[], releases: readonly Release[]): boolean {
  return (
    prs.some(pr => prState(pr) === 'pending') ||
    releases.some(r => releaseState(r) === 'pending')
  )
}

// ── Flair ───────────────────────────────────────────────────────────────

export const MOON = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'] as const

export function moon(frame: number): string {
  return MOON[((frame % MOON.length) + MOON.length) % MOON.length] ?? '🌑'
}

export function icon(state: CheckState | 'merged' | 'closed', frame = 0): string {
  switch (state) {
    case 'pass':
      return '✅'
    case 'fail':
      return '❌'
    case 'skip':
      return '⏭️'
    case 'merged':
      return '🟣'
    case 'closed':
      return '⚫'
    default:
      return moon(frame)
  }
}

/** ▕████░░░░▏ with the done share filled; failures shown as ▓. */
export function bar(t: Tally, width = 12): string {
  if (t.total === 0) return `▕${'░'.repeat(width)}▏`
  const done = Math.round(((t.pass + t.skip) / t.total) * width)
  const bad = Math.min(width - done, Math.round((t.fail / t.total) * width))
  return `▕${'█'.repeat(done)}${'▓'.repeat(bad)}${'░'.repeat(width - done - bad)}▏`
}

/**
 * The launch track: 🌍 · · 🚀 · · 🌕 with the rocket placed by progress.
 * Lands on the moon with confetti, or blows up where it failed.
 */
export function launchTrack(t: Tally, state: CheckState, frame = 0, width = 10): string {
  if (state === 'pass') return `🌍${'·'.repeat(width)}🌕🚀🎉`
  const share = t.total === 0 ? 0 : (t.pass + t.skip + t.fail) / t.total
  const at = Math.min(width - 1, Math.floor(share * width))
  const ship = state === 'fail' ? '💥' : frame % 2 === 0 ? '🚀' : '🔥'
  return `🌍${'·'.repeat(at)}${ship}${'·'.repeat(width - 1 - at)}🌕`
}

export function reviewLabel(review: string): string {
  switch (review) {
    case 'APPROVED':
      return '👍 approved'
    case 'CHANGES_REQUESTED':
      return '✋ changes requested'
    case 'REVIEW_REQUIRED':
      return '👀 review required'
    default:
      return '👀 no review yet'
  }
}

export function mergeLabel(pr: Pr): string {
  if (pr.isDraft) return '📝 draft'
  switch (pr.mergeable) {
    case 'MERGEABLE':
      return '🧩 mergeable'
    case 'CONFLICTING':
      return '⚔️ conflicts'
    default:
      return '🤔 mergeability unknown'
  }
}

const CHEERS = [
  'ship it 🛳️',
  'all systems go 🛰️',
  'green across the board 🥦',
  'chef’s kiss 🤌',
  'no notes 📭',
] as const

export function cheer(seed: number): string {
  return CHEERS[Math.abs(seed) % CHEERS.length] ?? CHEERS[0]
}

/** The status line: one glance at everything tracked. */
export function statusLine(prs: readonly Pr[], releases: readonly Release[], frame: number): string | undefined {
  const parts: string[] = []
  for (const pr of prs.slice(-2)) {
    const t = tally(pr.checks)
    parts.push(`PR #${pr.number} ${icon(prState(pr), frame)} ${t.pass}/${t.total}`)
  }
  for (const r of releases.slice(-1)) {
    const jobs = r.runs.flatMap(run => run.jobs)
    const t = tally(jobs.length > 0 ? jobs : r.runs)
    parts.push(`🚀 ${r.label} ${icon(releaseState(r), frame)} ${t.pass}/${t.total}`)
  }
  return parts.length === 0 ? undefined : `🛰️ ${parts.join(' · ')}`
}

// ── Transitions worth a toast ───────────────────────────────────────────

export function prToast(before: Pr | undefined, after: Pr): string | undefined {
  const was = before ? prState(before) : undefined
  const now = prState(after)
  if (was === now || after.error) return undefined
  const tag = `PR #${after.number}`
  if (now === 'merged') return `🟣 ${tag} merged. Pop the 🍾`
  if (now === 'closed') return `⚫ ${tag} was closed`
  if (now === 'pass' && was !== undefined) return `🎉 ${tag} is green: ${cheer(after.number)}`
  if (now === 'fail') {
    const failed = after.checks.filter(c => c.state === 'fail').map(c => c.name)
    return `💥 ${tag}: ${failed.slice(0, 2).join(', ')}${failed.length > 2 ? ` +${failed.length - 2}` : ''} failed`
  }
  return undefined
}

export function releaseToast(before: Release | undefined, after: Release): string | undefined {
  const was = before ? releaseState(before) : undefined
  const now = releaseState(after)
  if (was === now || after.error || after.runs.length === 0) return undefined
  if (now === 'pass' && was !== undefined) return `🚀🌕 ${after.label} landed. Release is live 🎉`
  if (now === 'fail') return `🔥 ${after.label}: launch scrubbed. A pipeline failed`
  return undefined
}
