import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pr, Release, Run } from '../types'
import {
  PR_URL,
  RELEASE_URL,
  bar,
  cheer,
  icon,
  isLive,
  isPrCreate,
  isReleaseCreate,
  launchTrack,
  mergeLabel,
  moon,
  parseJobs,
  parsePr,
  parseRuns,
  prState,
  prToast,
  releaseState,
  releaseToast,
  reviewLabel,
  statusLine,
  tally,
  workflowRun,
} from './lib'

type $ = EngineInterface

const PLUGIN = 'gh-pulse'
const PANE = 'gh-pulse'
const POLL_MS = 15_000
const FRAME_MS = 400
const MAX_PRS = 5
const MAX_RELEASES = 3

const prs = atom({ plugin: 'gh-pulse', key: 'prs' } as const, [])
const releases = atom({ plugin: 'gh-pulse', key: 'releases' } as const, [])
const frame = atom({ plugin: 'gh-pulse', key: 'frame' } as const, 0)
const isBandHidden = atom({ plugin: 'gh-pulse', key: 'isBandHidden' } as const, false)

const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName'
const RUN_FIELDS = 'databaseId,name,workflowName,displayTitle,url,status,conclusion,headBranch'

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

async function withJobs($: $, run: Run, previous?: Run): Promise<Run> {
  // Finished runs keep the jobs we already have; no need to ask again.
  if (run.state !== 'pending' && previous && previous.jobs.length > 0) {
    return { ...run, jobs: previous.jobs }
  }
  try {
    return { ...run, jobs: parseJobs(await gh($, ['run', 'view', String(run.id), '--json', 'jobs'])) }
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

/** A release from a tag, a workflow file, or (neither) the latest GitHub release. */
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
}

async function upsertRelease($: $, next: Release): Promise<void> {
  const before = (await read($, releases)).find(r => r.key === next.key)
  await update($, releases, list =>
    [...list.filter(r => r.key !== next.key), next].slice(-MAX_RELEASES),
  )
  const toast = releaseToast(before, next)
  if (toast) $.ui.toast(toast, { timeoutMs: 8000 })
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

let isPolling = false

async function poll($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    for (const pr of await read($, prs)) {
      if (pr.state !== 'OPEN') continue // merged / closed: nothing left to watch
      try {
        await upsertPr($, await fetchPr($, pr.url))
      } catch (error) {
        await update($, prs, list =>
          list.map(one => (one.url === pr.url ? { ...one, error: message(error) } : one)),
        )
      }
    }
    for (const release of await read($, releases)) {
      // Keep watching until the launch has an outcome (or nothing has started yet).
      if (release.runs.length > 0 && releaseState(release) !== 'pending') continue
      await trackRelease($, release)
    }
    await refreshStatus($)
  } finally {
    isPolling = false
  }
}

async function clearAll($: $): Promise<void> {
  await update($, prs, () => [])
  await update($, releases, () => [])
  $.ui.status(undefined)
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

export const register: Register = on => {
  let pollTimer: Timer | undefined
  let frameTimer: Timer | undefined

  on('session.start', async ($, e, next) => {
    for (const command of COMMANDS) await $.command.register({ ...command })

    pollTimer?.cancel()
    frameTimer?.cancel()
    pollTimer = $.clock.every(POLL_MS, () => void poll($))
    // The moon only turns while something is in flight.
    frameTimer = $.clock.every(FRAME_MS, () => {
      void (async () => {
        if (!isLive(await read($, prs), await read($, releases))) return
        await update($, frame, n => (n + 1) % 1000)
        await refreshStatus($)
      })()
    })
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await update($, isBandHidden, () => false)
    const opened = await $.ui.open({ id: PANE, title: '🛰️ gh-pulse' })
    void poll($)
    return { text: opened.isPlaced ? '🛰️ Board open.' : '🛰️ Board queued: widen the terminal to see it.' }
  })

  on('command.run', { command: 'pulse-pr' }, async ($, e) => {
    try {
      const pr = await trackPr($, e.args.trim())
      return { text: `🛰️ Tracking PR #${pr.number}: ${pr.title}\n${pr.url}` }
    } catch (error) {
      return { text: `🛰️ Couldn't find that PR: ${message(error)}` }
    }
  })

  on('command.run', { command: 'pulse-release' }, async ($, e) => {
    try {
      const release = await trackRelease($, await resolveRelease($, e.args))
      const runs = release.runs.map(r => `  ${icon(r.state)} ${r.name} ${r.url}`).join('\n')
      return {
        text: `🚀 Tracking ${release.label}${release.url ? ` (${release.url})` : ''}\n${runs || '  No pipeline runs yet; watching for them.'}`,
      }
    } catch (error) {
      return { text: `🚀 Couldn't find that release: ${message(error)}` }
    }
  })

  on('command.run', { command: 'pulse-clear' }, async $ => {
    await clearAll($)
    return { text: '🛰️ Cleared. Nothing tracked.' }
  })

  // Auto-track whatever Claude opens: PRs, releases, dispatched workflows.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const output = ran.text ?? ''
    try {
      if (isPrCreate(e.command)) {
        const url = PR_URL.exec(output)?.[0]
        if (url) {
          const pr = await trackPr($, url)
          $.ui.toast(`🛰️ Watching PR #${pr.number}. /pulse for the board`)
        }
      } else if (isReleaseCreate(e.command)) {
        const tag = RELEASE_URL.exec(output)?.[1]
        if (tag) {
          const release = await trackRelease($, await resolveRelease($, decodeURIComponent(tag)))
          $.ui.toast(`🚀 T-minus… watching ${release.label}'s pipelines`)
        }
      } else {
        const workflow = workflowRun(e.command)
        if (workflow) {
          const release = await trackRelease($, await resolveRelease($, workflow))
          $.ui.toast(`🚀 Watching ${release.label}`)
        }
      }
    } catch {
      // Tracking is best effort; never get in the way of the tool call.
    }
    return ran
  })

  // ── The band above the prompt: one line per tracked thing, with links ──

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const prList = await read($, prs)
    const releaseList = await read($, releases)
    if (e.props.hasSurvey || (await read($, isBandHidden)) || prList.length + releaseList.length === 0) {
      return next(e)
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const f = await read($, frame)

    return (
      <Box flexDirection="column">
        {prList.slice(-2).map(pr => {
          const t = tally(pr.checks)
          return (
            <Box key={`band-${pr.url}`} gap={1}>
              <Text>{icon(prState(pr), f)}</Text>
              <Link href={pr.url} label={`PR #${pr.number}`} />
              <Text dimColor>{bar(t, 8)}</Text>
              <Text>
                {t.pass}/{t.total}
              </Text>
              {t.fail > 0 && <Text color="red">{t.fail} failing</Text>}
            </Box>
          )
        })}
        {releaseList.slice(-1).map(r => {
          const jobs = r.runs.flatMap(run => run.jobs)
          const t = tally(jobs.length > 0 ? jobs : r.runs)
          return (
            <Box key={`band-${r.key}`} gap={1}>
              <Text>{launchTrack(t, releaseState(r), f, 6)}</Text>
              {r.url ? <Link href={r.url} label={r.label} /> : <Text>{r.label}</Text>}
              {r.runs[0]?.url && <Link href={r.runs[0].url} label="pipeline" />}
            </Box>
          )
        })}
        <Box gap={1}>
          <Button key="open" plain label="board" onPress={() => void $.ui.open({ id: PANE, title: '🛰️ gh-pulse' })} />
          <Button key="hide" plain label="hide" onPress={() => update($, isBandHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  // ── The board: the full picture ──

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const prList = await read($, prs)
    const releaseList = await read($, releases)
    const f = await read($, frame)

    if (prList.length + releaseList.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>🛰️ Nothing in orbit yet</Text>
          <Text dimColor>/pulse-pr [number|url]  track a PR (blank = current branch)</Text>
          <Text dimColor>/pulse-release [tag|workflow.yml]  track a launch</Text>
          <Text dimColor>PRs and releases Claude creates are picked up automatically.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {[...prList].reverse().map(pr => {
          const t = tally(pr.checks)
          const state = prState(pr)
          const ordered = [
            ...pr.checks.filter(c => c.state === 'fail'),
            ...pr.checks.filter(c => c.state === 'pending'),
            ...pr.checks.filter(c => c.state === 'pass'),
            ...pr.checks.filter(c => c.state === 'skip'),
          ]
          return (
            <Box key={pr.url} flexDirection="column">
              <Box gap={1}>
                <Text>{icon(state, f)}</Text>
                <Link href={pr.url} label={`PR #${pr.number}`} />
                <Text bold wrap="truncate-end">
                  {pr.title}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {pr.repo} · {pr.branch}
              </Text>
              <Text>
                {reviewLabel(pr.review)} · {mergeLabel(pr)}
              </Text>
              <Text>
                {bar(t)} {t.pass}/{t.total} ✅{t.pass} ❌{t.fail} {moon(f)}
                {t.pending} ⏭️{t.skip}
              </Text>
              {ordered.slice(0, 8).map(c => (
                <Box key={`${pr.url}#${c.name}`} gap={1} paddingLeft={2}>
                  <Text>{icon(c.state, f)}</Text>
                  {c.url ? <Link href={c.url} label={c.name} /> : <Text>{c.name}</Text>}
                </Box>
              ))}
              {ordered.length > 8 && <Text dimColor>   …and {ordered.length - 8} more</Text>}
              {state === 'pass' && <Text color="green">🎉 {cheer(pr.number)}</Text>}
              {state === 'merged' && <Text color="magenta">🟣 merged. Nice work</Text>}
              {pr.error && <Text color="yellow">⚠️ {pr.error}</Text>}
            </Box>
          )
        })}

        {[...releaseList].reverse().map(r => {
          const jobs = r.runs.flatMap(run => run.jobs)
          const t = tally(jobs.length > 0 ? jobs : r.runs)
          const state = releaseState(r)
          return (
            <Box key={r.key} flexDirection="column">
              <Box gap={1}>
                <Text>🚀</Text>
                {r.url ? <Link href={r.url} label={`Release ${r.label}`} /> : <Text bold>{r.label}</Text>}
              </Box>
              <Text>{launchTrack(t, state, f)}</Text>
              {r.runs.length === 0 && !r.error && <Text dimColor>{moon(f)} waiting for pipelines to ignite…</Text>}
              {r.runs.map(run => {
                const jt = tally(run.jobs)
                return (
                  <Box key={`run-${run.id}`} flexDirection="column" paddingLeft={2}>
                    <Box gap={1}>
                      <Text>{icon(run.state, f)}</Text>
                      {run.url ? <Link href={run.url} label={run.name} /> : <Text>{run.name}</Text>}
                      <Text dimColor wrap="truncate-end">
                        {run.title}
                      </Text>
                    </Box>
                    {run.jobs.length > 0 && (
                      <Text dimColor>
                        {bar(jt, 10)} {jt.pass}/{jt.total} jobs
                      </Text>
                    )}
                    {run.jobs
                      .filter(job => job.state !== 'pass')
                      .slice(0, 5)
                      .map(job => (
                        <Box key={`job-${run.id}-${job.name}`} gap={1} paddingLeft={2}>
                          <Text>{icon(job.state, f)}</Text>
                          {job.url ? <Link href={job.url} label={job.name} /> : <Text>{job.name}</Text>}
                        </Box>
                      ))}
                  </Box>
                )
              })}
              {r.error && <Text color="yellow">⚠️ {r.error}</Text>}
            </Box>
          )
        })}

        <Box gap={2}>
          <Button key="refresh" label="↻ refresh" onPress={() => poll($)} />
          <Button key="clear" label="clear" onPress={() => clearAll($)} />
        </Box>
      </Box>
    )
  })
}
