import type { RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import {
  bar,
  checkState,
  launchTrack,
  overall,
  parseChecks,
  prToast,
  statusLine,
  tally,
  workflowRun,
} from '../hooks/lib'
import type { Pr } from '../types'

const PR_URL = 'https://github.com/acme/rocket/pull/482'

const ROLLUP = [
  { __typename: 'CheckRun', workflowName: 'ci', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/rocket/actions/runs/1/job/1' },
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
  expect(checks[0]?.name).toBe('ci / lint')
  expect(checks[3]?.name).toBe('codecov')
  expect(overall(checks)).toBe('fail')
  expect(tally(checks)).toEqual({ pass: 2, fail: 1, pending: 1, skip: 0, total: 4 })
})

test('flair: bars and the launch track', async () => {
  expect(bar({ pass: 2, fail: 1, pending: 1, skip: 0, total: 4 }, 8)).toBe('▕████▓▓░░▏')
  expect(launchTrack({ pass: 0, fail: 0, pending: 4, skip: 0, total: 4 }, 'pending', 0, 4)).toBe('🌍🚀···🌕')
  expect(launchTrack({ pass: 4, fail: 0, pending: 0, skip: 0, total: 4 }, 'pass', 0, 4)).toContain('🎉')
  expect(launchTrack({ pass: 1, fail: 1, pending: 2, skip: 0, total: 4 }, 'fail', 0, 4)).toBe('🌍··💥·🌕')
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
  expect(prToast(pending, green)).toContain('is green')
  expect(prToast(pending, red)).toContain('test failed')
  expect(prToast(green, green)).toBeUndefined()
  expect(prToast(green, { ...green, state: 'MERGED' })).toContain('merged')
  expect(statusLine([red], [], 0)).toBe('🛰️ PR #482 ❌ 0/1')
})

test('a PR Claude opens is tracked and drawn with links', async ($, on) => {
  // Stand in for gh and for the Bash tool.
  on('process.run', async (_$, e) => {
    if (e.argv[1] === 'pr' && e.argv[2] === 'view') {
      return { value: { exitCode: 0, stdout: PR_JSON, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
    expect(await ui.find({ type: 'Link', text: 'PR #482' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'ci / test' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /approved/ })).toBeDefined()
    await ui.unmount()
  }
})
