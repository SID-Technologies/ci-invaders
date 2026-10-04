export type CheckState = 'pass' | 'fail' | 'pending' | 'skip'

export type Check = {
  name: string
  state: CheckState
  url?: string
  workflow?: string // absent for status contexts
  durationMs?: number
}

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
  base?: string
  author?: string
  endedAt?: string // when it merged or closed
  reviews?: Reviewer[]
  error?: string
}

export type Reviewer = { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'REQUESTED' | 'DISMISSED' }

export type History = { results: CheckState[]; at: number }

export type Job = {
  name: string
  state: CheckState
  url?: string
  durationMs?: number
  isWaiting?: boolean // declared in the workflow, not started yet
}

export type Run = {
  id: number
  name: string
  title: string
  url: string
  state: CheckState
  branch: string
  attempt?: number
  durationMs?: number
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

export type OpenPr = {
  url: string
  number: number
  title: string
  isDraft: boolean
  checks: Check[]
}

export type OpenPrs = { repo: string; prs: OpenPr[]; error?: string }

export type GhState = 'unknown' | 'ready' | 'missing' | 'signed-out'

export type Setup = { gh: GhState; os: 'mac' | 'linux' | 'windows' | 'unknown' }

export type Celebration = { key: string; kind: 'merged' | 'released' | 'scrubbed'; startFrame: number }

// What Remove or Clear took, for z to restore.
export type Undo = { label: string; prs: Pr[]; releases: Release[]; selected: string }

// Failed-step logs by job id.
export type Logs = Record<string, { lines: string[]; at: number }>

declare module 'claude-code' {
  interface PluginState {
    'gh-pulse': {
      prs: Pr[]
      releases: Release[]
      frame: number
      isBandHidden: boolean
      selected: string // `pr:<url>` or `release:<key>`
      layout: 'both' | 'list' | 'detail'
      openPrs: OpenPrs
      setup: Setup
      celebration: Celebration | null
      undo: Undo | null
      cursor: string // key of the focused board element
      busy: string // label shown while an action runs, '' when idle
      isKeysShown: boolean
      logs: Logs
      viewer: string // your GitHub login, '' until known
      logCheck: string // `<item key>#<check url>`
      history: Record<string, History> // by `<repo>|<branch>|<workflow>`
      avatars: Record<string, string> // login -> base64 PNG, '' if unavailable
    }
  }
}
