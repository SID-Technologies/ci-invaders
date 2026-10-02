export type CheckState = 'pass' | 'fail' | 'pending' | 'skip'

export type Check = { name: string; state: CheckState; url?: string }

export type Pr = {
  url: string
  number: number
  repo: string
  title: string
  branch: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  review: string
  mergeable: string
  checks: Check[]
  error?: string
}

export type Job = { name: string; state: CheckState; url?: string }

export type Run = {
  id: number
  name: string
  title: string
  url: string
  state: CheckState
  branch: string
  jobs: Job[]
}

export type Release = {
  key: string
  label: string
  workflow?: string
  tag?: string
  url?: string
  runs: Run[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'gh-pulse': {
      prs: Pr[]
      releases: Release[]
      frame: number
      isBandHidden: boolean
    }
  }
}
