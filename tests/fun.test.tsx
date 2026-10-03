import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { isFlaky, isPlainLogin, parseHistory, parseReviewers, reviewerGlyph, spoken } from '../hooks/lib'
import type { Pr } from '../types'

const PR_URL = 'https://github.com/acme/rocket/pull/482'

const prJson = (state = 'OPEN', conclusion = 'FAILURE') =>
  JSON.stringify({
    number: 482,
    title: 'feat: warp drive',
    url: PR_URL,
    state,
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    headRefName: 'warp-drive',
    baseRefName: 'main',
    latestReviews: [{ author: { login: 'octocat' }, state: 'APPROVED' }],
    reviewRequests: [{ login: 'hubot' }, { name: 'core-team' }],
    statusCheckRollup: [{ __typename: 'CheckRun', workflowName: 'ci', name: 'test', status: 'COMPLETED', conclusion }],
  })

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const pane = {
  plugin: 'gh-pulse',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'gh-pulse',
  props: { title: 'gh-pulse', isFocused: true, bodyColumns: 90, placement: 'dock' } as unknown as RenderPropsOf['Pane'],
} as const

const FLAKY_RUNS = JSON.stringify(
  ['SUCCESS', 'FAILURE', 'SUCCESS', 'FAILURE', 'SUCCESS'].map(conclusion => ({ status: 'COMPLETED', conclusion })),
)

test('reviewers, history, flakiness and what gets said', async () => {
  expect(parseReviewers([{ author: { login: 'octocat' }, state: 'APPROVED' }, { author: { login: 'octocat' }, state: 'COMMENTED' }], [{ login: 'hubot' }, { name: 'team' }]))
    .toEqual([{ login: 'octocat', state: 'APPROVED' }, { login: 'hubot', state: 'REQUESTED' }])
  expect(parseReviewers(undefined, undefined)).toBeUndefined()
  expect(reviewerGlyph('CHANGES_REQUESTED')).toEqual({ glyph: '✕', color: 'red' })

  expect(isPlainLogin('octocat')).toBe(true)
  expect(isPlainLogin('dependabot[bot]')).toBe(false)
  expect(isPlainLogin('a;rm -rf /')).toBe(false)

  const results = parseHistory(FLAKY_RUNS)
  expect(results).toEqual(['pass', 'fail', 'pass', 'fail', 'pass'])
  expect(isFlaky(results)).toBe(true)
  expect(isFlaky(['fail', 'fail', 'pass', 'pass', 'pass'])).toBe(false) // broke once, then fixed
  expect(spoken('PR 482', 'green')).toBe('PR 482 is green')
})

test('history, reviewers and avatars show on the board', async ($, on) => {
  const ran: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = e.argv.map(String)
    ran.push(argv)
    if (argv[0] === 'sh') return ok('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')
    if (argv[1] === 'run' && argv[2] === 'list') return ok(FLAKY_RUNS)
    if (argv[1] === 'pr') return ok(prJson())
    return ok('')
  })

  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` }) // selecting fetches history and avatars

  expect(ran.some(argv => argv.join(' ').includes('run list -R acme/rocket --workflow ci --branch main'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'HISTORY ON MAIN' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'flaky' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'octocat' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hubot' })).toBeDefined()
  expect(await ui.find({ type: 'Image', key: 'avatar-octocat' })).toBeDefined()
  await ui.unmount()
})

test('history stays away when turned off', { options: { heatmap: false } }, async ($, on) => {
  on('process.run', async (_$, e) => ok(e.argv[1] === 'run' ? FLAKY_RUNS : e.argv[1] === 'pr' ? prJson() : ''))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  const ui = await $.ui.mount(pane)
  await ui.press({ key: `item:pr:${PR_URL}` })
  expect(await ui.find({ type: 'Text', text: 'HISTORY ON MAIN' })).toBeUndefined()
  await ui.unmount()
})

test('sounds and speech are off by default', async ($, on) => {
  const heard: string[] = []
  let conclusion = 'FAILURE'
  on('process.run', async (_$, e) => ok(e.argv[1] === 'pr' ? prJson('OPEN', conclusion) : ''))
  on('audio.play', async () => (heard.push('play'), { value: undefined }))
  on('audio.speak', async () => (heard.push('speak'), { value: { synthesizer: 'system' } as never }))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  conclusion = 'SUCCESS'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  expect(heard).toEqual([])
})

test('with sounds and speech on, a green PR chimes and is announced', { options: { sounds: true, speech: true } }, async ($, on) => {
  const heard: string[] = []
  let conclusion = 'FAILURE'
  on('process.run', async (_$, e) => ok(e.argv[1] === 'pr' ? prJson('OPEN', conclusion) : ''))
  on('audio.play', async (_$, e) => (heard.push(`play ${(e.clip as { asset?: string }).asset}`), { value: undefined }))
  on('audio.speak', async (_$, e) => (heard.push(`say ${(e as { text?: string }).text}`), { value: { synthesizer: 'system' } as never }))
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  conclusion = 'SUCCESS'
  await $.command.run({ command: 'pulse-pr', args: PR_URL } as never)
  expect(heard).toContain('play assets/sounds/green.wav')
  expect(heard).toContain('say PR 482 is green')
})
