export type CheckState = 'pass' | 'fail' | 'pending' | 'skip'

export type Check = {
  name: string
  state: CheckState
  url?: string
  /** The Actions workflow the check belongs to; absent for status contexts. */
  workflow?: string
  /** Wall time of a finished check. */
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
  /** The branch it merges into: whose CI history the board shows. */
  base?: string
  /** Who reviewed or was asked to, latest state each. */
  reviews?: Reviewer[]
  error?: string
}

export type Reviewer = { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'REQUESTED' | 'DISMISSED' }

/** One workflow's last runs on a branch, newest first. */
export type History = { results: CheckState[]; at: number }

export type Job = {
  name: string
  state: CheckState
  url?: string
  durationMs?: number
  /** In the workflow but not started by GitHub yet: waiting on the jobs it `needs`. */
  isWaiting?: boolean
}

export type Run = {
  id: number
  name: string
  title: string
  url: string
  state: CheckState
  branch: string
  /** Goes up each time the run is re-run. */
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

/** One of your open PRs in this repo, listed on the board to track in a keypress. */
export type OpenPr = {
  url: string
  number: number
  title: string
  isDraft: boolean
  checks: Check[]
}

export type OpenPrs = { repo: string; prs: OpenPr[]; error?: string }

/** A PR someone asked you to review, from any repo. */
export type ReviewRequest = { url: string; number: number; title: string; repo: string }

export type ReviewRequests = { prs: ReviewRequest[]; error?: string }

/** Whether gh is there to ask: unchecked, ready, not installed, or not logged in. */
export type GhState = 'unknown' | 'ready' | 'missing' | 'signed-out'

export type Setup = { gh: GhState; os: 'mac' | 'linux' | 'windows' | 'unknown' }

/** A burst on the board: confetti on merge, the invaders cleared or the ship lost. */
export type Celebration = { key: string; kind: 'merged' | 'released' | 'scrubbed'; startFrame: number }

/** What Remove or Clear just took off the board, kept for a few seconds so z can put it back. */
export type Undo = { label: string; prs: Pr[]; releases: Release[]; selected: string }

/** Failed-step logs by job id, cleaned, newest lines last. */
export type Logs = Record<string, { lines: string[]; at: number }>

declare module 'claude-code' {
  interface PluginState {
    'gh-pulse': {
      prs: Pr[]
      releases: Release[]
      frame: number
      isBandHidden: boolean
      /** The board item the cursor is on: `pr:<url>` or `release:<key>`. */
      selected: string
      /** What the board shows, as lazygit's screen modes: the list and the open item, just the list, or just the item. */
      layout: 'both' | 'list' | 'detail'
      /** Your open PRs in the session's repo, tracked or not. */
      openPrs: OpenPrs
      /** What gh-pulse needs before it can watch anything. */
      setup: Setup
      celebration: Celebration | null
      undo: Undo | null
      /** The board element holding the keyboard, by key: which section is active, and where in it. */
      cursor: string
      /** What the board is busy doing for the person (`Rerunning failed jobs`), '' when nothing. */
      busy: string
      /** The full key list is open (h). */
      isKeysShown: boolean
      logs: Logs
      reviewRequests: ReviewRequests
      /** Which failing check's log the board shows: `<item key>#<check url>`. */
      logCheck: string
      /** Workflow history by `<repo>|<branch>|<workflow>`. */
      history: Record<string, History>
      /** Reviewer avatars by login: a PNG as base64, or '' when it could not be had. */
      avatars: Record<string, string>
    }
  }
}
