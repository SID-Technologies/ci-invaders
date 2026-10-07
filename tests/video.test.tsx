import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { actionsTarget, cleanLog, fixPrompt, parseActionsUrl, plannedJobs, repoFlag, withWaitingJobs } from '../hooks/lib'
import {
  BOOM_FRAMES,
  CONFETTI_FRAMES,
  FALL_FRAMES,
  HIT_FRAMES,
  VICTORY_FRAMES,
  NONE,
  blank,
  confettiFrame,
  invaderAt,
  invadersFrame,
  newShip,
  placeInvaders,
  set,
  toCells,
} from '../hooks/sprites'
import type { Pr } from '../types'

const PR_URL = 'https://github.com/acme/rocket/pull/482'
const JOB_URL = 'https://github.com/acme/rocket/actions/runs/77/job/2'

const prJson = (state: string, conclusion = 'FAILURE') =>
  JSON.stringify({
    number: 482,
    title: 'feat: warp drive',
    url: PR_URL,
    state,
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefName: 'warp-drive',
    statusCheckRollup: [
      { __typename: 'CheckRun', workflowName: 'ci', name: 'test', status: 'COMPLETED', conclusion, detailsUrl: JOB_URL },
    ],
  })

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const pane = (focused = true) =>
  ({
    plugin: 'gh-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'gh-pulse',
    props: { title: 'gh-pulse', isFocused: focused, bodyColumns: 80, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
  }) as const

// ── Pixels ──────────────────────────────────────────────────────────────

test('toCells packs two pixel rows per cell', async () => {
  const p = blank(2, 2)
  set(p, 0, 0, 0xff0000) // top only
  set(p, 1, 1, 0x00ff00) // bottom only
  const { columns, rows, cells } = toCells(p)
  expect([columns, rows]).toEqual([2, 1])
  const words = new Uint32Array(Uint8Array.from(atob(cells), ch => ch.charCodeAt(0)).buffer)
  expect([...words]).toEqual([0x2580, 0xff0000, NONE, 0x2584, 0x00ff00, NONE])
  expect(toCells(blank(3, 3)).rows).toBe(2) // odd heights round up
})

test('confetti is deterministic and falls back down', async () => {
  const lit = (f: number) => confettiFrame(7, f, 40, 12).data.filter(c => c !== NONE).length
  expect(lit(0)).toBeGreaterThan(0)
  expect(confettiFrame(7, 10, 40, 12)).toEqual(confettiFrame(7, 10, 40, 12))
  expect(confettiFrame(7, 10, 40, 12)).not.toEqual(confettiFrame(8, 10, 40, 12))
  expect(lit(CONFETTI_FRAMES)).toBe(0)
})

test('invaders march, burst, fall, and end on YOU WIN or GAME OVER', async () => {
  const lit = (p: { data: number[] }) => p.data.filter(c => c !== NONE).length
  const running = invadersFrame({ invaders: [{ state: 'pending' }, { state: 'pending' }], frame: 0 })
  expect(invadersFrame({ invaders: [{ state: 'pending' }, { state: 'pending' }], frame: 30 })).not.toEqual(running) // marching, stars falling
  expect(invaderAt(0, 2, 0).x).not.toBe(invaderAt(0, 2, 60).x)
  expect(Math.max(...Array.from({ length: 200 }, (_, f) => invaderAt(0, 6, f, 100).x))).toBeGreaterThan(50) // edge to edge
  expect(invaderAt(6, 8, 0).y).toBeGreaterThan(invaderAt(0, 8, 0).y) // a second row past six

  // Shot down: a burst for a few frames, then gone.
  const hit = (frame: number) => invadersFrame({ invaders: [{ state: 'pass', doneAt: 0 }, { state: 'pending' }], frame })
  expect(lit(hit(2))).toBeGreaterThan(lit(hit(HIT_FRAMES + 1)))

  // Failed: falls, then the ship blows up, then debris.
  const lost = (frame: number) => invadersFrame({ invaders: [{ state: 'fail', doneAt: 0 }], frame })
  expect(lost(FALL_FRAMES + 4)).not.toEqual(lost(FALL_FRAMES + BOOM_FRAMES + 2))
  expect(lost(0)).not.toEqual(lost(FALL_FRAMES))

  // Cleared: YOU WIN with fireworks, then it settles; a failure ends on GAME OVER.
  const won = (frame: number) => invadersFrame({ invaders: [{ state: 'pass', doneAt: 0 }], frame })
  expect(won(HIT_FRAMES + 4)).not.toEqual(won(HIT_FRAMES + 8))
  expect(won(HIT_FRAMES + VICTORY_FRAMES + 1).data.filter(c => c === 0x4ade80).length).toBeGreaterThan(20) // the banner
  expect(lost(FALL_FRAMES + BOOM_FRAMES + 2).data.filter(c => c === 0xf87171).length).toBeGreaterThan(30) // GAME OVER and the landed invader
  expect(toCells(running)).toMatchObject({ columns: 64, rows: 11 })
  expect(toCells(invadersFrame({ invaders: [{ state: 'pending' }], frame: 0, width: 100 })).columns).toBe(100) // as wide as the board
})

test('invaders keep their slots as jobs join; the ship picks random targets', async () => {
  // A planned job GitHub now names takes its place quietly; a matrix job's extra half and a new job fly in.
  const first = placeInvaders(new Map(), [{ key: 'a', state: 'pending' }, { key: 'plan', state: 'pending' }], 0)
  const later = placeInvaders(first, [{ key: 'a', state: 'pending' }, { key: 'm1', state: 'pending' }, { key: 'm2', state: 'pending' }], 30)
  expect(later.get('a')).toMatchObject({ slot: 0 })
  expect(later.get('m1')).toMatchObject({ slot: 1, seenAt: 0 })
  expect(later.get('m2')).toMatchObject({ slot: 2, seenAt: 30 })
  // A re-run's jobs take the old places and fly in again.
  const done = placeInvaders(later, [{ key: 'a', state: 'pass' }, { key: 'm1', state: 'pass' }, { key: 'm2', state: 'pass' }], 40)
  expect(placeInvaders(done, [{ key: 'a#2', state: 'pending' }], 50).get('a#2')).toEqual({ slot: 0, seenAt: 50, isRunning: true })

  // The formation never jumps when a column is added, and the ship fires at more than one invader.
  const ship = newShip()
  const lefts: number[] = []
  let shots = 0
  for (let frame = 0; frame < 200; frame++) {
    const count = frame < 60 ? 2 : 4
    const invaders = Array.from({ length: count }, (_, slot) => ({ state: 'pending' as const, slot, seenAt: slot < 2 ? undefined : 60 }))
    const before = ship.shots.length
    invadersFrame({ invaders, frame, ship })
    if (ship.shots.length > before) shots++
    lefts.push(ship.fx)
  }
  expect(Math.max(...lefts.slice(1).map((x, i) => Math.abs(x - lefts[i]!)))).toBeLessThanOrEqual(1)
  expect(shots).toBeGreaterThan(5)
  expect(ship.seed).toBeGreaterThan(3) // it changed targets more than once
})

// ── Fix it ──────────────────────────────────────────────────────────────

test('parseActionsUrl, cleanLog and fixPrompt', async () => {
  expect(parseActionsUrl(JOB_URL)).toEqual({ runId: '77', jobId: '2' })
  expect(parseActionsUrl('https://codecov.io/x')).toBeUndefined()

  const raw = [
    'ci\ttest\t2026-10-02T10:00:00.1234567Z ##[group]Run npm test',
    'ci\ttest\t2026-10-02T10:00:01.0000000Z \x1b[31mFAIL src/warp.test.ts\x1b[0m',
    'ci\ttest\t2026-10-02T10:00:01.0000000Z ',
    'ci\ttest\t2026-10-02T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
  ].join('\n')
  expect(cleanLog(raw)).toEqual(['Run npm test', 'FAIL src/warp.test.ts', 'Process completed with exit code 1.'])

  const pr = { number: 482, title: 'feat: warp drive', repo: 'acme/rocket', branch: 'warp-drive' } as Pr
  const text = fixPrompt(pr, [
    { name: 'test', workflow: 'ci', url: JOB_URL, log: ['FAIL src/warp.test.ts'] },
    { name: 'codecov', url: 'https://codecov.io/x' },
  ])
  expect(text).toContain('PR #482')
  expect(text).toContain('Failing check: ci / test')
  expect(text).toContain('FAIL src/warp.test.ts')
  expect(text).toContain('no log available')
  expect(text).toContain('branch `warp-drive`')
})

test('f fills the prompt with the failing log', async ($, on) => {
  const filled: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    if (argv[1] === 'run' && argv.includes('--log-failed')) {
      return ok('ci\ttest\t2026-10-02T10:00:01.0000000Z expected 1, got 2\n')
    }
    return ok(argv[1] === 'pr' ? prJson('OPEN') : '')
  })
  on('prompt.fill', async (_$, e) => (filled.push(e.text), { isFilled: true }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Button', key: 'fix' })).toBeDefined()
  await ui.press({ key: 'fix' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('Failing check: ci / test')
  expect(filled[0]).toContain('expected 1, got 2')
  await ui.unmount()
})

// ── Celebrations ────────────────────────────────────────────────────────

test('merge shows confetti', async ($, on) => {
  let state = 'OPEN'
  on('process.run', async (_$, e) => ok(e.argv[1] === 'pr' ? prJson(state, 'SUCCESS') : ''))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Raster', key: 'confetti' })).toBeUndefined()

  state = 'MERGED'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  expect(await ui.find({ type: 'Raster', key: 'confetti' })).toBeDefined()
  await ui.unmount()
})

test('confetti off shows none', { options: { confetti: false } }, async ($, on) => {
  let state = 'OPEN'
  on('process.run', async (_$, e) => ok(e.argv[1] === 'pr' ? prJson(state, 'SUCCESS') : ''))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  state = 'MERGED'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Raster', key: 'confetti' })).toBeUndefined()
  await ui.unmount()
})

test('release detail draws invaders', async ($, on) => {
  const ran: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    ran.push(argv)
    if (argv[1] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/rocket' }))
    if (argv[1] === 'release') return ok(JSON.stringify({ tagName: 'v1.0.0', url: 'https://github.com/acme/rocket/releases/tag/v1.0.0' }))
    if (argv[1] === 'run' && argv[2] === 'list') {
      return ok(JSON.stringify([{ databaseId: 9, workflowName: 'release', displayTitle: 'v1.0.0', url: 'https://github.com/acme/rocket/actions/runs/9', status: 'IN_PROGRESS', conclusion: '', headBranch: 'v1.0.0' }]))
    }
    if (argv[1] === 'run' && argv[2] === 'view') return ok(JSON.stringify({ jobs: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'publish', status: 'IN_PROGRESS' }] }))
    return ok('')
  })
  await $.command.run({ command: 'pulse-release', args: 'v1.0.0' } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Raster', key: 'invaders' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'section:actions', text: /^ACTIONS · 1/ })).toBeDefined() // listed under Actions, not Pull requests
  expect(await ui.find({ type: 'Button', key: 'section:prs', text: /^PULL REQUESTS$/ })).toBeDefined()
  // The release remembers its repo, so it can be followed from any directory.
  expect(ran.some(argv => argv[1] === 'run' && argv[2] === 'list' && argv.join(' ').includes('-R acme/rocket'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'rocket' })).toBeDefined()
  await ui.unmount()
})

test('re-run of a finished release shows as running', async ($, on) => {
  let status = 'COMPLETED'
  let attempt = 1
  const viewed: number[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    if (argv[1] === 'release') return ok(JSON.stringify({ tagName: 'v1.0.0', url: 'https://github.com/acme/rocket/releases/tag/v1.0.0' }))
    if (argv[1] === 'run' && argv[2] === 'list') {
      return ok(JSON.stringify([{ databaseId: 9, workflowName: 'release', displayTitle: 'v1.0.0', url: 'https://github.com/acme/rocket/actions/runs/9', status, conclusion: status === 'COMPLETED' ? 'FAILURE' : '', headBranch: 'v1.0.0', attempt }]))
    }
    if (argv[1] === 'run' && argv[2] === 'view') {
      viewed.push(attempt)
      return ok(JSON.stringify({ jobs: [{ name: 'publish', status, conclusion: status === 'COMPLETED' ? 'FAILURE' : '' }] }))
    }
    return ok('')
  })
  await $.command.run({ command: 'pulse-release', args: 'v1.0.0' } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Button', key: 'rerun' })).toBeDefined() // failed, finished

  // Re-run on GitHub: attempt 2 starts. Refresh looks at finished releases too.
  status = 'IN_PROGRESS'
  attempt = 2
  await ui.press({ key: 'refresh' })
  expect(viewed).toContain(2) // the new attempt's jobs, not the old ones
  expect(await ui.find({ type: 'Button', key: 'rerun' })).toBeUndefined() // nothing failed now
  await ui.unmount()
})

test('waiting jobs are counted before GitHub lists them', async () => {
  const yaml = [
    'name: release',
    'on: push',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: not a job',
    '        run: make',
    '  test:',
    "    name: 'Unit tests'",
    '    needs: build',
    '    strategy:',
    '      matrix: { os: [a, b] }',
    '  # a comment',
    '  publish:',
    '    name: Publish ${{ github.ref_name }}',
    '    needs: [build, test]',
    'env:',
    '  NOT_A_JOB: 1',
  ].join('\n')
  const planned = plannedJobs(yaml)
  expect(planned).toEqual([
    { key: 'build', name: 'build' },
    { key: 'test', name: 'Unit tests' },
    { key: 'publish', name: 'Publish ${{ github.ref_name }}' },
  ])

  // Only build has started: test and publish are still to come.
  const started = [{ name: 'build', state: 'pass' as const }]
  const all = withWaitingJobs(started, planned, true)
  expect(all.map(job => [job.name, job.state, job.isWaiting ?? false])).toEqual([
    ['build', 'pass', false],
    ['Unit tests', 'pending', true],
    ['Publish', 'pending', true],
  ])
  // Matrix and expression names match what GitHub lists once they start.
  const later = [...started, { name: 'Unit tests (a)', state: 'pending' as const }, { name: 'Publish v1.0.0', state: 'pending' as const }]
  expect(withWaitingJobs(later, planned, true)).toHaveLength(3)
  // A finished run never waits on anything.
  expect(withWaitingJobs(started, planned, false)).toHaveLength(1)
})

test('actions targets in other repos', async () => {
  expect(actionsTarget('')).toEqual({ repo: undefined })
  expect(actionsTarget('v1.2.0')).toEqual({ repo: undefined, tag: 'v1.2.0' })
  expect(actionsTarget('acme/other')).toEqual({ repo: 'acme/other' })
  expect(actionsTarget('acme/other deploy.yml')).toEqual({ repo: 'acme/other', workflow: 'deploy.yml' })
  expect(actionsTarget('v2 -R acme/other')).toEqual({ repo: 'acme/other', tag: 'v2' })
  expect(actionsTarget('--repo=acme/other 123456789')).toEqual({ repo: 'acme/other', runId: 123456789 })
  expect(actionsTarget('https://github.com/acme/other/actions/runs/42/job/7')).toEqual({ repo: 'acme/other', runId: 42 })
  expect(actionsTarget('https://github.com/acme/other/actions/workflows/ship.yaml')).toEqual({ repo: 'acme/other', workflow: 'ship.yaml' })
  expect(actionsTarget('https://github.com/acme/other/releases/tag/v1%2B1')).toEqual({ repo: 'acme/other', tag: 'v1+1' })
  expect(actionsTarget('https://github.com/acme/other')).toEqual({ repo: 'acme/other' })
  expect(repoFlag('gh workflow run ship.yml -R acme/other -f x=1')).toBe('acme/other')
  expect(repoFlag('gh release create v1 --repo=acme/other')).toBe('acme/other')
  expect(repoFlag('gh workflow run ship.yml && gh run list -R acme/other')).toBeUndefined()
})

test('tracks a workflow, a run and a repo with no releases elsewhere', async ($, on) => {
  const ran: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    ran.push(argv.join(' '))
    const run = { databaseId: 42, workflowName: 'deploy', displayTitle: 'ship it', url: 'https://github.com/acme/other/actions/runs/42', status: 'IN_PROGRESS', conclusion: '', headBranch: 'main' }
    if (argv[1] === 'release') return { value: { exitCode: 1, stdout: '', stderr: 'release not found', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[1] === 'run' && argv[2] === 'list') return ok(JSON.stringify([run]))
    if (argv[1] === 'run' && argv[2] === 'view' && argv.includes('jobs')) return ok(JSON.stringify({ jobs: [] }))
    if (argv[1] === 'run' && argv[2] === 'view') return ok(JSON.stringify(run))
    return ok('')
  })
  await $.command.run({ command: 'pulse-release', args: 'acme/other deploy.yml' } as never)
  expect(ran).toContain('gh run list --json databaseId,name,workflowName,displayTitle,url,status,conclusion,headBranch,startedAt,updatedAt,attempt -R acme/other --workflow deploy.yml --limit 1')

  await $.command.run({ command: 'pulse-release', args: 'https://github.com/acme/other/actions/runs/42' } as never)
  expect(ran.some(line => line.startsWith('gh run view 42 --json databaseId') && line.endsWith('-R acme/other'))).toBe(true)

  const latest = (await $.command.run({ command: 'pulse-release', args: 'acme/other' } as never)) as { text?: string }
  expect(latest.text).toMatch(/^Tracking latest run/)

  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Button', key: 'section:actions', text: /^ACTIONS · .* of 3/ })).toBeDefined()
  await ui.unmount()
})

test('auto-tracks a workflow Claude runs in another repo', async ($, on) => {
  const ran: string[] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    ran.push(argv.join(' '))
    if (argv[1] === 'run' && argv[2] === 'list') return ok('[]')
    return ok('')
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'gh workflow run ship.yml -R acme/other', description: 'Ship' })
  expect(ran.some(line => line.startsWith('gh run list') && line.includes('-R acme/other --workflow ship.yml'))).toBe(true)
})
