import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { cleanLog, fixPrompt, parseActionsUrl } from '../hooks/lib'
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

test('pixels pack two rows a cell, transparent where nothing is drawn', async () => {
  const p = blank(2, 2)
  set(p, 0, 0, 0xff0000) // top only
  set(p, 1, 1, 0x00ff00) // bottom only
  const { columns, rows, cells } = toCells(p)
  expect([columns, rows]).toEqual([2, 1])
  const words = new Uint32Array(Uint8Array.from(atob(cells), ch => ch.charCodeAt(0)).buffer)
  expect([...words]).toEqual([0x2580, 0xff0000, NONE, 0x2584, 0x00ff00, NONE])
  expect(toCells(blank(3, 3)).rows).toBe(2) // odd heights round up
})

test('confetti bursts up, falls back, and is the same every time', async () => {
  const lit = (f: number) => confettiFrame(7, f, 40, 12).data.filter(c => c !== NONE).length
  expect(lit(0)).toBeGreaterThan(0)
  expect(confettiFrame(7, 10, 40, 12)).toEqual(confettiFrame(7, 10, 40, 12))
  expect(confettiFrame(7, 10, 40, 12)).not.toEqual(confettiFrame(8, 10, 40, 12))
  expect(lit(CONFETTI_FRAMES)).toBe(0)
})

test('space invaders: running jobs march, passed ones burst, a failure lands and takes the ship', async () => {
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

// ── Fix it ──────────────────────────────────────────────────────────────

test('check URLs, failed logs and the fix prompt', async () => {
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

test('f puts the failing log in the prompt box', async ($, on) => {
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

test('a merge sets off confetti on the board', async ($, on) => {
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

test('confetti stays off when the setting is off', { options: { confetti: false } }, async ($, on) => {
  let state = 'OPEN'
  on('process.run', async (_$, e) => ok(e.argv[1] === 'pr' ? prJson(state, 'SUCCESS') : ''))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  state = 'MERGED'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane())
  expect(await ui.find({ type: 'Raster', key: 'confetti' })).toBeUndefined()
  await ui.unmount()
})

test('a tracked release plays space invaders', async ($, on) => {
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
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
  await ui.unmount()
})

test('a finished release that gets re-run goes back to running', async ($, on) => {
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
