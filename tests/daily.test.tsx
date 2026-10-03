import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { ciContext, nextRow, parseReviewRequests } from '../hooks/lib'
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

/** A gh that knows one failing PR, its log, your review requests, and records every call. */
function fakeGh(ran: string[][], conclusion = 'FAILURE') {
  return async (_$: unknown, e: { argv: readonly unknown[] }) => {
    const argv = e.argv.map(String)
    ran.push(argv)
    if (argv[1] === 'run' && argv.includes('--log-failed')) return ok('ci\ttest\t2026-10-02T10:00:01.0000000Z expected 1, got 2\n')
    if (argv[1] === 'search') {
      return ok(JSON.stringify([{ number: 9, title: 'fix: engine mounts', url: OTHER_URL, repository: { nameWithOwner: 'acme/engine' } }]))
    }
    if (argv[1] === 'pr' && argv[2] === 'view') return ok(prJson(argv[3]?.startsWith('https') ? argv[3] : PR_URL, conclusion))
    if (argv[1] === 'pr' && argv[2] === 'list') return ok('[]')
    if (argv[1] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/rocket' }))
    return ok('')
  }
}

test('Claude hears what is failing, and nothing when nothing changed', async ($, on) => {
  const pr = JSON.parse(prJson()) as Record<string, unknown>
  expect(parseReviewRequests(JSON.stringify([{ number: 9, title: 't', url: OTHER_URL, repository: { nameWithOwner: 'acme/engine' } }])))
    .toEqual([{ url: OTHER_URL, number: 9, title: 't', repo: 'acme/engine' }])
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

test('the failing log shows under the checks, y copies it, e reruns', async ($, on) => {
  const ran: string[][] = []
  const copied: string[] = []
  on('process.run', fakeGh(ran))
  on('ui.copy', async (_$, e) => (copied.push(e.text), { value: { isCopied: true as const } }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` }) // selecting fetches the log
  expect(ran.some(argv => argv.join(' ') === 'gh run view --job 2 --log-failed')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /LOG · ci \/ test/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'expected 1, got 2' })).toBeDefined()

  await ui.press({ key: 'copy' })
  expect(copied).toEqual(['expected 1, got 2'])

  await ui.press({ key: 'rerun' })
  expect(ran.some(argv => argv.join(' ') === 'gh run rerun 77 --failed')).toBe(true)
  await ui.unmount()
})

test('PRs waiting on your review: listed, tracked in a press, handed to Claude with a', async ($, on) => {
  const ran: string[][] = []
  const filled: string[] = []
  on('process.run', fakeGh(ran))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('prompt.fill', async (_$, e) => (filled.push(e.text), { isFilled: true }))

  await $.command.run({ command: 'pulse', args: '' } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'refresh' }) // the lists load in the background; wait for them
  expect(await ui.find({ type: 'Text', text: 'WAITING ON YOUR REVIEW' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `review:${OTHER_URL}` })).toBeDefined()

  await ui.press({ key: `review:${OTHER_URL}` })
  expect(await ui.find({ type: 'Button', key: `item:pr:${OTHER_URL}` })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `review:${OTHER_URL}` })).toBeUndefined()

  await ui.press({ key: 'ask' })
  expect(filled[0]).toContain(`Review PR #9 "fix: engine mounts" (${OTHER_URL})`)
  await ui.unmount()
})

test('a git push to a branch with a PR starts tracking it', async ($, on) => {
  const ran: string[][] = []
  on('process.run', fakeGh(ran))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'To github.com:acme/rocket.git\n' }) as never)

  await $.tool.call({ tool: 'Bash', command: 'git push -u origin warp-drive', description: 'Push' })
  expect(ran.some(argv => argv.slice(0, 4).join(' ') === 'gh pr view --json')).toBe(true)
  const ui = await $.ui.mount(pane)
  expect(await ui.find({ type: 'Button', key: `item:pr:${PR_URL}` })).toBeDefined()
  await ui.unmount()
})

test('tracked PRs are remembered for the next session', async ($, on) => {
  const saved: unknown[] = []
  on('process.run', fakeGh([]))
  on('store.set', async (_$, e) => (saved.push(e.value), { value: undefined }))

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  expect(saved.at(-1)).toEqual({ prs: [PR_URL], releases: [] })
  await $.command.run({ command: 'pulse-clear', args: '' } as never)
  expect(saved.at(-1)).toEqual({ prs: [], releases: [] })
})

test('arrows walk the rows, and hand back to scrolling past either end', () => {
  const rows = ['item:a', 'item:b', 'add:c']
  expect(nextRow(rows, 'item:a', 1)).toBe('item:b')
  expect(nextRow(rows, 'add:c', -1)).toBe('item:b')
  expect(nextRow(rows, 'add:c', 1)).toBeUndefined() // scroll on to what's below
  expect(nextRow(rows, 'item:a', -1)).toBeUndefined() // scroll up to the actions and the detail
  expect(nextRow(rows, 'refresh', 1)).toBe('item:a') // from the actions, down into the list
  expect(nextRow(rows, 'refresh', -1)).toBeUndefined()
})

test('x and c can be undone with z', async ($, on) => {
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
