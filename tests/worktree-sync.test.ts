import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const MAIN = '/repo'
const WORKTREE = '/repo/.claude/worktrees/wt'

const BAND = {
  plugin: 'worktree-sync',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type Repo = { isWorktree: boolean; mainStatus?: string }

const fakeGit = (on: On, repo: Repo, calls: string[]) => {
  mock.clock(on)
  mock.store(on)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  let mainBranch = 'main'
  let syncTip: string | null = null
  on('process.run', async (_$, e) => {
    const [tool, ...args] = e.argv
    const cmd = args.join(' ')
    const inMain = e.init?.cwd === MAIN
    calls.push(`${inMain ? 'main' : 'wt'}: ${tool} ${cmd}`)
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })

    if (tool !== 'git') return out('')
    if (cmd === 'rev-parse --show-toplevel') return out(repo.isWorktree ? WORKTREE : MAIN)
    if (cmd === 'branch --show-current') {
      return out(inMain ? mainBranch : repo.isWorktree ? 'claude/feature' : 'main')
    }
    if (inMain && cmd.startsWith('checkout -q -B ')) {
      mainBranch = args[3] ?? ''
      syncTip = args[4] ?? null
      return out('')
    }
    if (inMain && cmd.startsWith('checkout -q ')) {
      mainBranch = args[2] ?? ''
      return out('')
    }
    if (inMain && cmd.startsWith('branch -q -D')) {
      syncTip = null
      return out('')
    }
    if (inMain && cmd === 'rev-parse --verify -q test/claude/feature') {
      return syncTip === null ? out('', 1) : out(syncTip)
    }
    if (cmd.endsWith('--git-dir')) return out(repo.isWorktree ? '/repo/.git/worktrees/wt' : '/repo/.git')
    if (cmd.endsWith('--git-common-dir')) return out('/repo/.git')
    if (cmd === 'worktree list --porcelain') return out(`worktree ${MAIN}\nHEAD aaa\n\nworktree ${WORKTREE}`)
    if (cmd === 'rev-parse --abbrev-ref origin/HEAD') return out('origin/main')
    if (cmd.startsWith('rev-list --count')) return out('2')
    if (cmd === 'status --porcelain') return out(inMain ? (repo.mainStatus ?? '') : ' M a.ts\n?? b.ts')
    if (cmd === 'rev-parse HEAD') return out(inMain ? 'mainsha' : 'headsha')
    if (cmd === 'write-tree') return out('snaptree')
    if (cmd === 'rev-parse headsha^{tree}') return out('headtree')
    if (cmd.startsWith('rev-parse --verify')) return out('', 1)
    if (cmd === 'diff --quiet') return out('', 1)
    return out('')
  })
}

test('a worktree session shows the branch and the sync button', async ($, on) => {
  fakeGit(on, { isWorktree: true }, [])
  await $.session.start({ cwd: WORKTREE, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /claude\/feature/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 commits · 2 uncommitted/ })).toBeDefined()
    expect(await ui.find({ key: 'sync' })).toBeDefined()
    await ui.unmount()
  }
})

test('a main-checkout session shows no band', async ($, on) => {
  fakeGit(on, { isWorktree: false }, [])
  await $.session.start({ cwd: MAIN, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  expect(await ui.find({ key: 'sync' })).toBeUndefined()
})

test('pressing the button checks out the worktree state in the main checkout', async ($, on) => {
  const calls: string[] = []
  fakeGit(on, { isWorktree: true }, calls)
  await $.session.start({ cwd: WORKTREE, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'sync' })

  expect(calls).toContain('main: git checkout -q -B test/claude/feature headsha')
  expect(calls).toContain('main: git read-tree -u -m HEAD snaptree')
})

test('a dirty main checkout is left alone', async ($, on) => {
  const calls: string[] = []
  fakeGit(on, { isWorktree: true, mainStatus: ' M mine.ts' }, calls)
  await $.session.start({ cwd: WORKTREE, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'sync' })

  expect(calls.some(call => call.includes('checkout'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /uncommitted changes of yours/ })).toBeDefined()
})

test('after a sync, the back button returns the main checkout to its branch', async ($, on) => {
  const calls: string[] = []
  fakeGit(on, { isWorktree: true }, calls)
  await $.session.start({ cwd: WORKTREE, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'restore' })).toBeUndefined()

  await ui.press({ key: 'sync' })
  expect((await ui.find({ key: 'restore' }))?.text).toBe('↩ Back to main')

  await ui.press({ key: 'restore' })
  expect(calls).toContain('main: git checkout -q main')
  expect(calls).toContain('main: git branch -q -D test/claude/feature')
  expect(await ui.find({ key: 'restore' })).toBeUndefined()
})
