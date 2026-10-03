import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import {
  SPINNER,
  isLive,
  cells,
  checkState,
  glyph,
  duration,
  overall,
  parseChecks,
  prToast,
  segments,
  statusLine,
  summary,
  tally,
  workflowRun,
} from '../hooks/lib'
import type { Pr } from '../types'

const PR_URL = 'https://github.com/acme/rocket/pull/482'

const ROLLUP = [
  { __typename: 'CheckRun', workflowName: 'ci', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/rocket/actions/runs/1/job/1', startedAt: '2026-10-02T10:00:00Z', completedAt: '2026-10-02T10:01:02Z' },
  { __typename: 'CheckRun', workflowName: 'ci', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/rocket/actions/runs/1/job/2' },
  { __typename: 'CheckRun', workflowName: 'ci', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
  { __typename: 'StatusContext', context: 'codecov', state: 'SUCCESS', targetUrl: 'https://codecov.io/x' },
]

const PR_JSON = JSON.stringify({
  number: 482,
  title: 'feat: warp drive',
  url: PR_URL,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  headRefName: 'warp-drive',
  statusCheckRollup: ROLLUP,
})

test('check verdicts cover CheckRuns and StatusContexts', async () => {
  expect(checkState('COMPLETED', 'SUCCESS')).toBe('pass')
  expect(checkState('COMPLETED', 'TIMED_OUT')).toBe('fail')
  expect(checkState('COMPLETED', 'SKIPPED')).toBe('skip')
  expect(checkState('QUEUED')).toBe('pending')
  expect(checkState('PENDING')).toBe('pending')
  expect(checkState('ERROR')).toBe('fail')

  const checks = parseChecks(ROLLUP)
  expect(checks.map(c => c.state)).toEqual(['pass', 'fail', 'pending', 'pass'])
  expect(checks[0]?.name).toBe('lint')
  expect(checks[0]?.workflow).toBe('ci')
  expect(checks[0]?.durationMs).toBe(62_000)
  expect(checks[2]?.durationMs).toBeUndefined()
  expect(checks[3]?.name).toBe('codecov')
  expect(overall(checks)).toBe('fail')
  expect(tally(checks)).toEqual({ pass: 2, fail: 1, pending: 1, skip: 0, total: 4 })
})

test('look: segmented bar, durations, summary', async () => {
  const t = { pass: 5, fail: 1, pending: 3, skip: 1, total: 10 }
  for (const width of [3, 10, 57]) {
    const segs = segments(t, width)
    expect(segs.reduce((n, seg) => n + seg.width, 0)).toBe(width)
    if (width >= 4) expect(segs.every(seg => seg.width >= 1)).toBe(true)
  }
  expect(segments(t, 10).map(seg => seg.state)).toEqual(['pass', 'fail', 'pending', 'skip'])
  expect(segments({ pass: 0, fail: 0, pending: 0, skip: 0, total: 0 }, 8)).toEqual([{ state: 'skip', width: 8 }])

  expect(cells({ state: 'pass', width: 3 })).toBe('⣿⣿⣿')
  expect(cells({ state: 'skip', width: 2 })).toBe('⣀⣀')
  // The loader: one dot a frame, left column bottom-up then the right, held, then over.
  const loading = { state: 'pending' as const, width: 2 }
  const steps = Array.from({ length: 13 }, (_, f) => cells(loading, f))
  expect(steps).toEqual([
    '⣀⣀', '⣄⣀', '⣆⣀', '⣇⣀', '⣧⣀', '⣷⣀', '⣿⣀',
    '⣿⣄', '⣿⣆', '⣿⣇', '⣿⣧', '⣿⣷', '⣿⣿',
  ])
  expect(cells(loading, 19)).toBe('⣿⣿') // held
  expect(cells(loading, 20)).toBe('⣀⣀') // and over again
  // Same pace on a wide bar: 12 frames in, 2 cells full.
  expect(cells({ state: 'pending', width: 60 }, 12)).toBe('⣿⣿' + '⣀'.repeat(58))
  expect(new Set(SPINNER.map((_, i) => glyph('pending', i * 2))).size).toBe(SPINNER.length)
  expect(glyph('pending', 1)).toBe(glyph('pending', 0)) // a step every other frame
  expect(glyph('pending', SPINNER.length * 2)).toBe(glyph('pending', 0))

  expect(duration(4_000)).toBe('4s')
  expect(duration(134_000)).toBe('2m 14s')
  expect(duration(3_780_000)).toBe('1h 03m')
  expect(duration(undefined)).toBe('')

  expect(summary(t)).toBe('5 passed · 1 failed · 3 running · 1 skipped')
  expect(summary({ pass: 2, fail: 0, pending: 0, skip: 0, total: 2 })).toBe('2 passed')
})

test('workflow dispatches are recognised', async () => {
  expect(workflowRun('gh workflow run release.yml -f tag=v1')).toBe('release.yml')
  expect(workflowRun('gh workflow run --ref main "deploy.yaml"')).toBe('deploy.yaml')
  expect(workflowRun('gh run list')).toBeUndefined()
  expect(workflowRun('gh workflow run -R acme/rocket ship.yml && echo ok')).toBe('ship.yml')
})

test('toasts fire on the transitions that matter', async () => {
  const pending: Pr = {
    url: PR_URL, number: 482, repo: 'acme/rocket', title: 't', branch: 'b', state: 'OPEN',
    isDraft: false, review: '', mergeable: 'MERGEABLE',
    checks: [{ name: 'test', state: 'pending' }],
  }
  const green: Pr = { ...pending, checks: [{ name: 'test', state: 'pass' }] }
  const red: Pr = { ...pending, checks: [{ name: 'test', state: 'fail' }] }
  expect(prToast(pending, green)).toBe('PR #482 · all checks passed')
  expect(prToast(pending, red)).toBe('PR #482 · test failed')
  expect(prToast(green, green)).toBeUndefined()
  expect(prToast(green, { ...green, state: 'MERGED' })).toContain('merged')
  expect(statusLine([red], [], 0)).toBe('✕ #482 0/1')

  // A failure decides the verdict, but the rest are still running: keep animating.
  const failingWhileRunning: Pr = { ...pending, checks: [{ name: 'lint', state: 'fail' }, { name: 'test', state: 'pending' }] }
  expect(isLive([failingWhileRunning], [])).toBe(true)
  expect(isLive([red], [])).toBe(false)
  expect(isLive([{ ...failingWhileRunning, state: 'CLOSED' }], [])).toBe(false)
  const release = {
    key: 'tag:v1', label: 'v1', runs: [
      { id: 1, name: 'build', title: '', url: '', state: 'fail' as const, branch: 'v1', jobs: [] },
      { id: 2, name: 'publish', title: '', url: '', state: 'pending' as const, branch: 'v1', jobs: [] },
    ],
  }
  expect(isLive([], [release])).toBe(true)
})

test('a PR Claude opens is tracked and drawn with links', async ($, on) => {
  // Stand in for gh and for the Bash tool.
  on('process.run', async (_$, e) => {
    if (e.argv[1] === 'pr' && e.argv[2] === 'view') {
      return { value: { exitCode: 0, stdout: PR_JSON, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === '--version' || e.argv[1] === 'auth') {
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: PR_URL, stderr: '', interrupted: false }, text: `${PR_URL}\n` }) as never)

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill', description: 'Open PR' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'gh-pulse',
      surface,
      component: 'Pane',
      requestId: 'gh-pulse',
      props: { title: 'gh-pulse', isFocused: false, bodyColumns: 80, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
    })
    expect(await ui.find({ type: 'Link', text: '#482' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '#482' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'approved' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Failing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1m 02s' })).toBeDefined()
    await ui.unmount()
  }

  const band = await $.ui.mount({
    plugin: 'gh-pulse',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {} as unknown as RenderPropsOf['AbovePrompt'],
  })
  expect(await band.find({ type: 'Link', text: '#482' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '1 failed · 1 running' })).toBeDefined()
  expect(await band.find({ type: 'Button', text: 'board' })).toBeDefined()
  await band.unmount()
})

test('the board lists what is tracked, your open PRs, and tracks one in a press', async ($, on) => {
  const second = PR_JSON.replace(/482/g, '483').replace('warp drive', 'hyperspace')
  const mineUrl = PR_URL.replace('482', '484')
  const MINE = JSON.stringify([
    { number: 482, title: 'feat: warp drive', url: PR_URL, isDraft: false, statusCheckRollup: ROLLUP },
    { number: 484, title: 'feat: quantum', url: mineUrl, isDraft: true, statusCheckRollup: [] },
  ])
  const reply = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const ran: string[][] = []
  on('process.run', async (_$, e) => {
    ran.push(e.argv.map(String))
    const [, noun, verb, ref = ''] = e.argv.map(String)
    if (noun === 'repo') return reply(JSON.stringify({ nameWithOwner: 'acme/rocket' }))
    if (noun === 'pr' && verb === 'list') return reply(MINE)
    if (ref.endsWith('/483')) return reply(second)
    if (ref.endsWith('/484')) return reply(PR_JSON.replace(/482/g, '484').replace('warp drive', 'quantum'))
    return reply(PR_JSON)
  })
  const opened: { rows?: number }[] = []
  on('ui.open', async (_$, e) => (opened.push({ rows: e.rows }), { value: { isPlaced: true } }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  await $.command.run({ command: 'pulse-pr', args: PR_URL.replace('482', '483') } as never)
  await $.command.run({ command: 'pulse', args: '' } as never)

  const ui = await $.ui.mount({
    plugin: 'gh-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'gh-pulse',
    props: { title: 'gh-pulse', isFocused: true, bodyColumns: 80, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
  })

  // Help sits on its own line; the tracked rows are Buttons ↑↓ walk, newest open.
  expect(await ui.find({ type: 'Text', text: /↑↓ move/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL.replace('482', '483')}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: '#483' })).toBeDefined()

  // Your open PRs: the untracked one only, ready to track.
  expect(await ui.find({ type: 'Button', key: 'section:mine', text: /YOUR OPEN PRS · rocket/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `add:${mineUrl}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `add:${PR_URL}` })).toBeUndefined()

  // Selecting a row shows its detail.
  await ui.press({ key: `item:pr:${PR_URL}` })
  expect(await ui.find({ type: 'Link', text: '#482' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: '#483' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^TRACKING · \d of \d$/ })).toBeDefined() // where you are in the list

  // o opens the selected one in the browser, through gh.
  await ui.press({ key: 'open' })
  expect(ran.at(-1)).toEqual(['gh', 'pr', 'view', PR_URL, '--web'])

  // Tracking one of yours moves it up and opens it.
  await ui.press({ key: `add:${mineUrl}` })
  expect(await ui.find({ type: 'Button', key: `item:pr:${mineUrl}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `add:${mineUrl}` })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: '#484' })).toBeDefined()

  // List only: the list stays, detail and open PRs go; the pane asks for its rows.
  await ui.press({ key: 'layout' })
  expect(await ui.find({ type: 'Link', text: '#484' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'section:mine' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  expect(opened.at(-1)?.rows).toBe(7) // actions, help, TRACKING, "Pull requests", three PRs

  // Detail only: the open item, no lists; then back to both.
  await ui.press({ key: 'layout' })
  expect(await ui.find({ type: 'Link', text: '#484' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeUndefined()
  expect(opened.at(-1)?.rows).toBeUndefined()
  await ui.press({ key: 'layout' })
  expect(await ui.find({ type: 'Button', key: 'section:mine' })).toBeDefined()

  // x removes the open one; it goes back to your open PRs.
  await ui.press({ key: 'remove' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${mineUrl}` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `add:${mineUrl}` })).toBeDefined()
  await ui.unmount()
})

test('without gh, or signed out, it says what to do and waits', async ($, on) => {
  let installed = false
  let signedIn = false
  const reply = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    if (argv[0] === 'uname') return reply(0, 'Darwin\n')
    if (argv[1] === '--version') return installed ? reply(0, 'gh version 2.80.0') : reply(127)
    if (argv[1] === 'auth') return reply(signedIn ? 0 : 1)
    return reply(0, PR_JSON)
  })

  const missing = await $.command.run({ command: 'pulse-pr', args: '482' } as never)
  expect(missing).toMatchObject({ text: expect.stringContaining('brew install gh') })

  const board = async () =>
    $.ui.mount({
      plugin: 'gh-pulse',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'gh-pulse',
      props: { title: 'gh-pulse', isFocused: true, bodyColumns: 80, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
    })
  let ui = await board()
  expect(await ui.find({ type: 'Text', text: 'gh-pulse needs the GitHub CLI' })).toBeDefined()
  await ui.unmount()

  installed = true
  const signedOut = await $.command.run({ command: 'pulse-pr', args: '482' } as never)
  expect(signedOut).toMatchObject({ text: expect.stringContaining('gh auth login') })

  signedIn = true
  ui = await board()
  await ui.press({ key: 'recheck' })
  expect(await ui.find({ type: 'Text', text: /needs/ })).toBeUndefined()
  await ui.unmount()

  const tracked = await $.command.run({ command: 'pulse-pr', args: '482' } as never)
  expect(tracked).toMatchObject({ text: expect.stringContaining('Tracking PR #482') })
})
