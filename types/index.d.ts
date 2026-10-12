export type WorktreeStatus =
  | { kind: 'none' }
  | { kind: 'main'; root: string; branch: string }
  | {
      kind: 'worktree'
      root: string
      branch: string
      mainRoot: string
      mainBranch: string
      syncBranch: string
      ahead: number | null
      base: string | null
      changed: number
      /** Where the main checkout was before the sync, while it still holds the sync. */
      restoreTo: string | null
    }

export type SyncOutcome = { at: number; isOk: boolean; text: string }

export type Action = 'sync' | 'restore'

declare module 'claude-code' {
  interface PluginState {
    'worktree-sync': {
      status: WorktreeStatus | null
      busy: Action | null
      last: SyncOutcome | null
    }
  }
}
