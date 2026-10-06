import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { ciContext, clip, isFinished, isStale, nextRow, scrollWindow, upsertBy } from '../hooks/lib'
import type { Pr } from '../types'

const PR_URL = 'https://github.com/acme/rocket/pull/482'
const OTHER_URL = 'https://github.com/acme/engine/pull/9'
const JOB_URL = 'https://github.com/acme/rocket/actions/runs/77/job/2'

const prJson = (url = PR_URL, conclusion = 'FAILURE') =>
  JSON.stringify({
    number: Number(url.split('/').pop()),
    title: url === PR_URL ? 'feat: warp drive' : 'fix: engine mounts',
    url,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    headRefName: 'warp-drive',
    author: { login: url === PR_URL ? 'me' : 'someone' },
    statusCheckRollup: [
      { __typename: 'CheckRun', workflowName: 'ci', name: 'test', status: 'COMPLETED', conclusion, detailsUrl: JOB_URL },
      { __typename: 'CheckRun', workflowName: 'ci', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  })

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const pane = {
  plugin: 'gh-pulse',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'gh-pulse',
  props: { title: 'gh-pulse', isFocused: true, bodyColumns: 90, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
} as const

/** A gh that knows a failing PR, its log and who you are, and records every call. */
function fakeGh(ran: string[][], conclusion = 'FAILURE') {
  return async (_$: unknown, e: { argv: readonly unknown[] }) => {
    const argv = e.argv.map(String)
    ran.push(argv)
    if (argv[1] === 'run' && argv.includes('--log-failed')) return ok('ci\ttest\t2026-10-02T10:00:01.0000000Z expected 1, got 2\n')
    if (argv[1] === 'api' && argv[2] === 'user') return ok('me\n')
    if (argv[1] === 'pr' && argv[2] === 'view') return ok(prJson(argv[3]?.startsWith('https') ? argv[3] : PR_URL, conclusion))
    if (argv[1] === 'pr' && argv[2] === 'list') return ok('[]')
    if (argv[1] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/rocket' }))
    return ok('')
  }
}

test('prompt context is sent when failing or changed, skipped otherwise', async ($, on) => {
  const pr = JSON.parse(prJson()) as Record<string, unknown>
  expect(ciContext([], [])).toBeUndefined()
  const tracked = {
    url: PR_URL, number: 482, repo: 'acme/rocket', title: String(pr.title), branch: 'warp-drive', state: 'OPEN',
    isDraft: false, review: '', mergeable: 'MERGEABLE',
    checks: [{ name: 'test', workflow: 'ci', state: 'fail' }, { name: 'lint', workflow: 'ci', state: 'pending' }],
  } as Pr
  const text = ciContext([tracked], [])!
  expect(text).toContain('PR #482')
  expect(text).toContain('FAILING')
  expect(text).toContain('failing: ci / test')
  expect(text).toContain('1 running')

  const seen: (readonly string[] | undefined)[] = []
  let conclusion = 'FAILURE'
  const ran: string[][] = []
  on('process.run', async (s, e) => fakeGh(ran, conclusion)(s, e))
  on('prompt.submit', async (_$, e) => (seen.push(e.context), { text: e.text, context: e.context }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  await $.prompt.submit({ text: 'why is my PR red?' } as never)
  expect(seen.at(-1)?.[0]).toContain('failing: ci / test')

  // Failing: said again on the next prompt.
  await $.prompt.submit({ text: 'and now?' } as never)
  expect(seen.at(-1)?.[0]).toContain('FAILING')

  // Green: said once, then not repeated while nothing changes.
  conclusion = 'SUCCESS'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  await $.prompt.submit({ text: 'ok?' } as never)
  expect(seen.at(-1)?.[0]).toContain('PASSING')
  await $.prompt.submit({ text: 'thanks' } as never)
  expect(seen.at(-1)).toBeUndefined()
})

test('failing log shows in the detail; y copies it, e reruns', async ($, on) => {
  const ran: string[][] = []
  const copied: string[] = []
  on('process.run', fakeGh(ran))
  on('ui.copy', async (_$, e) => (copied.push(e.text), { value: { isCopied: true as const } }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` }) // selecting fetches the log
  expect(ran.some(argv => argv.join(' ') === 'gh run view --job 2 --log-failed -R acme/rocket')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /LOG · ci \/ test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'expected 1, got 2' })).toBeDefined()

  await ui.press({ key: 'copy' })
  expect(copied).toEqual(['expected 1, got 2'])

  await ui.press({ key: 'rerun' })
  expect(ran.some(argv => argv.join(' ') === 'gh run rerun 77 --failed -R acme/rocket')).toBe(true)
  await ui.unmount()
})

test('a reviews with Claude only on PRs you did not open', async ($, on) => {
  const filled: string[] = []
  on('process.run', fakeGh([]))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('prompt.fill', async (_$, e) => (filled.push(e.text), { isFilled: true }))

  await $.command.run({ command: 'pulse', args: '' } as never)
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' }) // learns who you are
  await ui.press({ key: `item:pr:${PR_URL}` })
  expect(await ui.find({ type: 'Button', key: 'ask' })).toBeUndefined() // yours

  await $.command.run({ command: 'pulse-pr', args: OTHER_URL } as never)
  await ui.press({ key: `item:pr:${OTHER_URL}` })
  await ui.press({ key: 'ask' })
  expect(filled[0]).toContain(`Review PR #9 "fix: engine mounts" (${OTHER_URL})`)
  await ui.unmount()
})

test('git push tracks the PR for the branch', async ($, on) => {
  const ran: string[][] = []
  on('process.run', fakeGh(ran))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'To github.com:acme/rocket.git\n' }) as never)

  await $.tool.call({ tool: 'Bash', command: 'git push -u origin warp-drive', description: 'Push' })
  expect(ran.some(argv => argv.slice(0, 4).join(' ') === 'gh pr view --json')).toBe(true)
  const ui = await $.ui.mount(pane)
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  await ui.unmount()
})

test('tracked PRs persist across sessions', async ($, on) => {
  const saved: unknown[] = []
  on('process.run', fakeGh([]))
  on('store.set', async (_$, e) => (saved.push(e.value), { value: undefined }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  expect(saved.at(-1)).toEqual({ prs: [PR_URL], releases: [] })
  await $.command.run({ command: 'pulse-clear', args: '' } as never)
  expect(saved.at(-1)).toEqual({ prs: [], releases: [] })
})

test('nextRow steps through rows and stops at the ends', () => {
  const rows = ['item:a', 'item:b', 'add:c']
  expect(nextRow(rows, 'item:a', 1)).toBe('item:b')
  expect(nextRow(rows, 'add:c', -1)).toBe('item:b')
  expect(nextRow(rows, 'add:c', 1)).toBeUndefined() // scroll on to what's below
  expect(nextRow(rows, 'item:a', -1)).toBeUndefined() // scroll up to the actions and the detail
  expect(nextRow(rows, 'refresh', 1)).toBe('item:a') // from the actions, down into the list
  expect(nextRow(rows, 'refresh', -1)).toBeUndefined()
})

test('z undoes remove and clear', async ($, on) => {
  on('process.run', fakeGh([]))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` })
  await ui.press({ key: 'remove' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeUndefined()
  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'undo' })).toBeUndefined()

  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Button', key: 'undo', text: /1 tracked item/ })).toBeDefined()
  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  await ui.unmount()
})

test('arrows and jumps move the cursor; enter pins a row in the detail', async ($, on) => {
  on('process.run', fakeGh([]))
  on('ui.focus', async () => ({}) as never)
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  await $.command.run({ command: 'pulse-pr', args: OTHER_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` }) // enter pins #482
  expect(await ui.find({ type: 'Link', text: '#482' })).toBeDefined()

  // Moving the cursor to #9 (as an arrow key does) leaves #482 pinned.
  await $.ui.focus({ component: 'Pane', requestId: 'gh-pulse', plugin: 'gh-pulse', element: `item:pr:${OTHER_URL}`, origin: { kind: 'person' } } as never)
  expect(await ui.find({ type: 'Link', text: '#482' })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: '#9' })).toBeUndefined()

  // x removes the highlighted row, not the pinned one.
  await ui.press({ key: 'remove' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${OTHER_URL}` })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: '#482' })).toBeDefined()
  await ui.unmount()
})

test('busy label shows while an action runs', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => (release = resolve))
  const gh = fakeGh([])
  on('process.run', async (s, e) => {
    if (e.argv.map(String).includes('rerun')) await held
    return gh(s, e)
  })
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` })
  const pressing = ui.press({ key: 'rerun' })
  expect(await ui.find({ type: 'Text', text: /Rerunning the failed jobs/ })).toBeDefined()
  release()
  await pressing
  expect(await ui.find({ type: 'Text', text: /Rerunning the failed jobs/ })).toBeUndefined()
  await ui.unmount()
})

test('h toggles the key list', async ($, on) => {
  on('process.run', fakeGh([]))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  expect(await ui.find({ type: 'Text', text: 'rerun failed jobs' })).toBeUndefined()
  await ui.press({ key: 'keys' })
  expect(await ui.find({ type: 'Text', text: 'rerun failed jobs' })).toBeDefined()
  await ui.press({ key: 'keys' })
  expect(await ui.find({ type: 'Text', text: 'rerun failed jobs' })).toBeUndefined()
  await ui.unmount()
})

test('scrollWindow moves only as far as it must; clip ends in an ellipsis', () => {
  expect(scrollWindow(0, 2, 10, 5)).toBe(0)
  expect(scrollWindow(0, 5, 10, 5)).toBe(1)
  expect(scrollWindow(4, 2, 10, 5)).toBe(2)
  expect(scrollWindow(8, -1, 10, 5)).toBe(5) // clamped when the list shrinks
  expect(scrollWindow(3, 0, 2, 5)).toBe(0)
  expect(clip('feat: rollback ui', 8)).toBe('feat:...')
  expect(clip('abcdef', 2)).toBe('ab')
  expect(clip('short', 8)).toBe('short')
})

test('long lists show a fixed window and say how many are hidden', async ($, on) => {
  const gh = fakeGh([])
  const mine = Array.from({ length: 7 }, (_, i) => ({
    number: 100 + i, title: `feat: change number ${i} with a long title that will not fit on one narrow line`, url: `https://github.com/acme/rocket/pull/${100 + i}`, isDraft: false, statusCheckRollup: [],
  }))
  on('process.run', async (s, e) => (e.argv.map(String)[2] === 'list' ? ok(JSON.stringify(mine)) : gh(s, e)))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'pulse', args: '' } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' })
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('add:'))).toHaveLength(3)
  expect(await ui.find({ type: 'Button', key: 'section:mine', text: /YOUR OPEN PRS · 7  ↓4$/ })).toBeDefined()
  await ui.unmount()
})

test('d clears merged PRs and finished releases; merged PRs also age out', async ($, on) => {
  const gh = fakeGh([])
  on('process.run', async (s, e) => {
    const argv = e.argv.map(String)
    if (argv[1] === 'pr' && argv[2] === 'view' && argv[3] === OTHER_URL) {
      return ok(JSON.stringify({ ...JSON.parse(prJson(OTHER_URL)), state: 'MERGED', mergedAt: '2026-10-04T10:00:00Z' }))
    }
    return gh(s, e)
  })
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  await $.command.run({ command: 'pulse-pr', args: OTHER_URL } as never)
  const ui = await $.ui.mount(pane)
  expect(await ui.find({ type: 'Button', key: 'clear-finished', text: /\(1\)/ })).toBeDefined()
  await ui.press({ key: 'clear-finished' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${OTHER_URL}` })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  await ui.press({ key: 'undo' })
  expect(await ui.find({ type: 'Button', key: `item:pr:${OTHER_URL}` })).toBeDefined()
  await ui.unmount()

  const merged = { state: 'MERGED', endedAt: '2026-10-04T10:00:00Z', checks: [] } as never
  expect(isFinished(merged)).toBe(true)
  expect(isStale(merged, Date.parse('2026-10-04T10:05:00Z'), 10 * 60_000)).toBe(false)
  expect(isStale(merged, Date.parse('2026-10-04T10:11:00Z'), 10 * 60_000)).toBe(true)
  expect(isStale({ state: 'OPEN', checks: [] } as never, Date.now(), 0)).toBe(false)
})

test('upsertBy updates in place, so polling never reorders the lists', () => {
  const list = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }]
  expect(upsertBy(list, { id: 1, v: 'A' }, one => one.id === 1, 5).map(one => one.v)).toEqual(['A', 'b', 'c'])
  expect(upsertBy(list, { id: 4, v: 'd' }, one => one.id === 4, 3).map(one => one.id)).toEqual([2, 3, 4])
})
