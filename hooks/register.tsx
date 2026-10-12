import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Action, WorktreeStatus } from '../types'

type RunOptions = { cwd?: string; env?: Record<string, string> }

class GitError extends Error {}

const run = async ($: EngineInterface, args: string[], options: RunOptions = {}) =>
  $.process.run(['git', ...args], { ...options, timeoutMs: 120_000 })

const git = async ($: EngineInterface, args: string[], options: RunOptions = {}) => {
  const result = await run($, args, options)
  if (result.exitCode !== 0) {
    const reason = (result.stderr || result.stdout).trim().split('\n')[0] ?? ''
    throw new GitError(`git ${args[0]} failed: ${reason}`)
  }
  return result.stdout.trim()
}

const optional = async ($: EngineInterface, args: string[], options: RunOptions = {}) => {
  const result = await run($, args, options)
  return result.exitCode === 0 ? result.stdout.trim() : null
}

const countLines = (text: string) => (text === '' ? 0 : text.split('\n').length)

const folder = (path: string) => path.split('/').pop() ?? path

type Origin = { branch: string | null; head: string }
type Synced = { head: string; tree: string; origin: Origin | null }

const storeKey = (mainRoot: string) => `synced:${mainRoot}`

const readSynced = async ($: EngineInterface, mainRoot: string) =>
  ((await $.store.get(storeKey(mainRoot))) ?? null) as Synced | null

const describeOrigin = (origin: Origin) => origin.branch ?? origin.head.slice(0, 8)

const readStatus = async ($: EngineInterface): Promise<WorktreeStatus> => {
  const root = await optional($, ['rev-parse', '--show-toplevel'])
  if (root === null) {
    return { kind: 'none' }
  }

  const branch = (await optional($, ['branch', '--show-current'])) || 'detached'
  const gitDir = await git($, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDir = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir === commonDir) {
    return { kind: 'main', root, branch }
  }

  const list = await git($, ['worktree', 'list', '--porcelain'])
  const mainRoot = list.split('\n')[0]?.replace(/^worktree /, '') ?? ''
  const mainBranch =
    (await optional($, ['branch', '--show-current'], { cwd: mainRoot })) || 'detached'
  const base =
    (await optional($, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])) ??
    ((await optional($, ['rev-parse', '--verify', '-q', 'main'])) ? 'main' : null)
  const ahead =
    base === null ? null : Number(await optional($, ['rev-list', '--count', `${base}..HEAD`]))
  const changed = countLines(await git($, ['status', '--porcelain']))
  const syncBranch = `test/${branch === 'detached' ? folder(root) : branch}`
  const origin = (await readSynced($, mainRoot))?.origin ?? null
  const restoreTo = origin !== null && mainBranch === syncBranch ? describeOrigin(origin) : null

  return {
    kind: 'worktree',
    root,
    branch,
    mainRoot,
    mainBranch,
    syncBranch,
    ahead: Number.isNaN(ahead) ? null : ahead,
    base,
    changed,
    restoreTo,
  }
}

// The worktree's whole state (commits + uncommitted + untracked) as one tree,
// built in a scratch index so the worktree's own index is never touched.
const snapshotTree = async ($: EngineInterface) => {
  const gitDir = await git($, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const scratch = `${gitDir}/worktree-sync-index`
  await $.process.run(['cp', `${gitDir}/index`, scratch])
  const env = { GIT_INDEX_FILE: scratch }
  try {
    await git($, ['add', '-A'], { env })
    return await git($, ['write-tree'], { env })
  } finally {
    await $.process.run(['rm', '-f', scratch])
  }
}

// The main checkout may be overwritten only when it is clean, or when it
// still holds exactly what the previous sync put there.
const discardSync = async ($: EngineInterface, mainRoot: string, previous: Synced | null) => {
  const cwd = mainRoot
  if ((await git($, ['status', '--porcelain'], { cwd })) === '') {
    return
  }

  const isUntouchedSync =
    previous !== null &&
    (await git($, ['write-tree'], { cwd })) === previous.tree &&
    (await run($, ['diff', '--quiet'], { cwd })).exitCode === 0 &&
    (await git($, ['ls-files', '--others', '--exclude-standard'], { cwd })) === ''
  if (!isUntouchedSync) {
    throw new GitError(
      `${folder(mainRoot)} has uncommitted changes of yours — commit, stash or discard them first.`,
    )
  }
  await git($, ['read-tree', '-u', '--reset', 'HEAD'], { cwd })
}

const assertBranchIsOurs = async (
  $: EngineInterface,
  mainRoot: string,
  syncBranch: string,
  head: string,
  previous: Synced | null,
) => {
  const tip = await optional($, ['rev-parse', '--verify', '-q', syncBranch], { cwd: mainRoot })
  if (tip === null || tip === previous?.head) {
    return
  }
  const isAncestor =
    (await run($, ['merge-base', '--is-ancestor', tip, head], { cwd: mainRoot })).exitCode === 0
  if (!isAncestor) {
    throw new GitError(
      `${syncBranch} has commits that are not in the worktree — rename or delete it first.`,
    )
  }
}

const syncToMain = async (
  $: EngineInterface,
  status: Extract<WorktreeStatus, { kind: 'worktree' }>,
) => {
  const { mainRoot, syncBranch } = status
  const cwd = mainRoot
  const previous = await readSynced($, mainRoot)

  const head = await git($, ['rev-parse', 'HEAD'])
  const tree = await snapshotTree($)
  const headTree = await git($, ['rev-parse', `${head}^{tree}`])

  await assertBranchIsOurs($, mainRoot, syncBranch, head, previous)
  await discardSync($, mainRoot, previous)
  // Remember where the checkout was, once: a re-sync keeps the first origin.
  const origin: Origin | null =
    status.mainBranch === syncBranch
      ? (previous?.origin ?? null)
      : {
          branch: (await optional($, ['branch', '--show-current'], { cwd })) || null,
          head: await git($, ['rev-parse', 'HEAD'], { cwd }),
        }
  await git($, ['checkout', '-q', '-B', syncBranch, head], { cwd })
  if (tree !== headTree) {
    await git($, ['read-tree', '-u', '-m', 'HEAD', tree], { cwd })
  }
  await $.store.set(storeKey(mainRoot), { head, tree, origin } satisfies Synced)

  const parts = [
    status.ahead !== null ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'}` : null,
    tree !== headTree ? 'uncommitted changes (staged)' : null,
  ].filter(Boolean)
  return `${folder(mainRoot)} is now on ${syncBranch}${parts.length ? ` with ${parts.join(' + ')}` : ''}.`
}

const restoreMain = async (
  $: EngineInterface,
  status: Extract<WorktreeStatus, { kind: 'worktree' }>,
) => {
  const { mainRoot, syncBranch } = status
  const cwd = mainRoot
  const previous = await readSynced($, mainRoot)
  if (previous?.origin == null) {
    throw new GitError('There is no earlier state of your local checkout to go back to.')
  }
  if ((await optional($, ['branch', '--show-current'], { cwd })) !== syncBranch) {
    await $.store.delete(storeKey(mainRoot))
    throw new GitError(`${folder(mainRoot)} is no longer on ${syncBranch}; left it as it is.`)
  }

  const { origin } = previous
  await discardSync($, mainRoot, previous)
  await git(
    $,
    origin.branch === null
      ? ['checkout', '-q', '--detach', origin.head]
      : ['checkout', '-q', origin.branch],
    { cwd },
  )
  const tip = await optional($, ['rev-parse', '--verify', '-q', syncBranch], { cwd })
  const isOurs = tip === previous.head
  if (isOurs) {
    await git($, ['branch', '-q', '-D', syncBranch], { cwd })
  }
  await $.store.delete(storeKey(mainRoot))

  const kept = isOurs ? '' : ` (kept ${syncBranch}: it has commits of yours)`
  return `${folder(mainRoot)} is back on ${describeOrigin(origin)}${kept}.`
}

const status = atom({ plugin: 'worktree-sync', key: 'status' } as const, null)
const busy = atom({ plugin: 'worktree-sync', key: 'busy' } as const, null)
const last = atom({ plugin: 'worktree-sync', key: 'last' } as const, null)

const REFRESH_MS = 20_000

const refresh = async ($: EngineInterface) => {
  const next = await readStatus($)
  await update($, status, () => next)
  return next
}

const perform = async ($: EngineInterface, action: Action) => {
  if ((await read($, busy)) !== null) {
    return 'A sync is already running.'
  }
  const current = await refresh($)
  if (current.kind !== 'worktree') {
    return 'This session is not working in a worktree.'
  }

  await update($, busy, () => action)
  const now = await $.clock.now()
  try {
    const text =
      action === 'sync' ? await syncToMain($, current) : await restoreMain($, current)
    await update($, last, () => ({ at: now, isOk: true, text }))
    $.ui.toast(text)
    return text
  } catch (error) {
    const text = error instanceof GitError ? error.message : `Failed: ${String(error)}`
    await update($, last, () => ({ at: now, isOk: false, text }))
    $.ui.toast(text)
    return text
  } finally {
    await update($, busy, () => null)
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sync-to-local',
      description: "Bring this worktree's commits and changes into your main checkout",
    })
    await $.command.register({
      name: 'restore-local',
      description: 'Put your main checkout back where it was before /sync-to-local',
    })
    await refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('command.run', { command: 'sync-to-local' }, async $ => ({ text: await perform($, 'sync') }))
  on('command.run', { command: 'restore-local' }, async $ => ({
    text: await perform($, 'restore'),
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    if (e.props.hasSurvey || current?.kind !== 'worktree') {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    const running = await read($, busy)
    const outcome = await read($, last)
    const commits =
      current.ahead === null ? '' : ` · ${current.ahead} commit${current.ahead === 1 ? '' : 's'}`
    const changes = current.changed === 0 ? '' : ` · ${current.changed} uncommitted`

    const target = folder(current.mainRoot)
    const isSynced = current.mainBranch === current.syncBranch
    const syncLabel =
      running === 'sync' ? '⏳ Syncing…' : isSynced ? '↻ Update local' : '⤓ Bring to local'

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isSynced ? 'cyan' : 'green'}
        paddingX={1}
      >
        <Box gap={1}>
          <Text color="green" bold>
            ⎇ Worktree
          </Text>
          <Text wrap="truncate-end">
            {current.branch}
            <Text dimColor>
              {commits}
              {changes}
            </Text>
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {isSynced
            ? `Your local ${target} is on ${current.syncBranch} with these changes`
            : `Your local ${target} is on ${current.mainBranch}`}
        </Text>
        <Box gap={2}>
          <Box key="sync-hover">
            <Button
              key="sync"
              hover={{ color: 'green', underline: true }}
              label={syncLabel}
              onPress={() => void perform($, 'sync')}
            />
          </Box>
          {current.restoreTo !== null && (
            <Box key="restore-hover">
              <Button
                key="restore"
                hover={{ color: 'cyan', underline: true }}
                label={
                  running === 'restore' ? '⏳ Restoring…' : `↩ Back to ${current.restoreTo}`
                }
                onPress={() => void perform($, 'restore')}
              />
            </Box>
          )}
        </Box>
        {outcome !== null && !outcome.isOk && (
          <Text color="red" wrap="truncate-end">
            {outcome.text}
          </Text>
        )}
      </Box>
    )
  })
}
