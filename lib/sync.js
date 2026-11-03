// Sync orchestration for dsh-github-sync.
//
// One workflow serves all three operations:
//
//   collect local snapshot -> write it into the clone -> commit
//   check: fetch and compare
//   pull:  fetch, rebase the local snapshot onto the remote, materialize, reconcile bundles
//   push:  fetch is not needed; push and report a non-fast-forward as "pull first"
//
// Committing the local snapshot before rebasing is what gives the pull its merge
// semantics: a file changed on both sides conflicts in git and the pull aborts
// without touching the local profile.

import path from 'node:path'
import {
  ensureDir,
  pathExists,
  removeTree,
  timestampSlug
} from './paths.js'
import {
  branchName,
  classifyGitFailure,
  commitAll,
  createGitRunner,
  gitQuery,
  headSha,
  isGitRepo
} from './git.js'
import {
  applyRepoTree,
  collectLocal,
  computeDrift,
  isLocalSpec,
  readRepoTree,
  SELF_BUNDLE,
  writeRepoTree
} from './snapshot.js'
import { loadConnection, loadState, saveConnection, saveState } from './state.js'
import { parseManifestEntry, readLocalManifest, reconcileBundles } from './plugin-reconcile.js'
import { discoverProfile } from './profile-dir.js'
import { scanEntries } from './secret-scan.js'

const CLONE_TIMEOUT_MS = 180000
const NETWORK_TIMEOUT_MS = 120000
const LOCAL_TIMEOUT_MS = 30000

function ok(data, summary) {
  return { ok: true, data, summary: summary ?? [] }
}

function fail(error, extra) {
  const code = error && error.code ? error.code : 'internal'
  const message = error && error.message ? error.message : String(error)
  return {
    ok: false,
    error: { code, message, detail: error && error.detail ? error.detail : undefined },
    data: extra,
    summary: [message]
  }
}

function parseNameStatus(text) {
  if (!text) return []
  const files = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const status = parts[0].trim()
    const file = parts.length >= 3 ? parts[1].trim() + ' → ' + parts[2].trim() : parts.slice(1).join('\t').trim()
    files.push({ status, path: file })
    if (files.length >= 500) break
  }
  return files
}

function presetList(items) {
  if (!Array.isArray(items)) return []
  return items.map((preset) => ({
    id: typeof preset.id === 'string' ? preset.id : String(preset.id ?? ''),
    name: typeof preset.name === 'string' ? preset.name : undefined,
    description: typeof preset.description === 'string' ? preset.description : undefined,
    order: typeof preset.order === 'number' ? preset.order : undefined
  }))
}

export function createSyncEngine(options = {}) {
  const env = options.env ?? process.env
  const getPluginManager = options.getPluginManager ?? (() => undefined)
  const getAgentPresets = options.getAgentPresets ?? (() => undefined)
  const getLoaderEntries = options.getLoaderEntries ?? (() => [])
  const logger = options.logger ?? (() => {})
  const git = createGitRunner(options.subprocess, { env })

  let versionPromise
  let profilePromise
  let logLines = []

  function record(line) {
    logLines.push(line)
    if (logLines.length > 200) logLines = logLines.slice(logLines.length - 200)
    try {
      logger(line)
    } catch {
      // Logging must never break a sync.
    }
  }

  function drainLog() {
    const lines = logLines
    logLines = []
    return lines
  }

  function gitVersion() {
    if (!versionPromise) {
      versionPromise = git
        .version()
        .then(async (version) => ({ ok: Boolean(version), version, path: await git.resolveGit() }))
        .catch((error) => ({ ok: false, error: error && error.message ? error.message : String(error) }))
    }
    return versionPromise
  }

  function cloneDir(config) {
    return path.join(config.dataDir, 'repo')
  }

  async function profile() {
    if (!profilePromise) {
      profilePromise = discoverProfile({ env, entries: getLoaderEntries }).catch((error) => {
        profilePromise = undefined
        throw error
      })
    }
    return profilePromise
  }

  async function readState() {
    return loadState(env, await profile())
  }

  async function writeState(next) {
    return saveState(env, await profile(), next)
  }

  async function rememberError(failed) {
    try {
      const state = await readState()
      await writeState({
        ...state,
        lastError: {
          at: new Date().toISOString(),
          code: failed && failed.error ? failed.error.code : 'internal',
          message: failed && failed.error ? failed.error.message : String(failed)
        }
      })
    } catch {
      // Remembering the failure must not replace it.
    }
  }

  async function currentConfig() {
    const resolved = await profile()
    const loaded = await loadConnection(env, resolved)
    return { ...loaded, profile: resolved }
  }

  function requireRepo(config) {
    if (!config.repo) {
      const error = new Error('还没有配置 GitHub 仓库地址：请在 Plugins → GitHub 同步 里填写，或运行 /dsh-sync config repo=<url>')
      error.code = 'not-configured'
      throw error
    }
  }

  async function listPresets() {
    const service = getAgentPresets()
    if (!service || typeof service.list !== 'function') return { available: false, items: [] }
    try {
      const items = await service.list()
      return { available: true, items: presetList(items) }
    } catch {
      return { available: false, items: [] }
    }
  }

  async function ensureClone(config, signal) {
    const dir = cloneDir(config)
    if (await isGitRepo(dir)) {
      const current = await git.run(['remote', 'get-url', 'origin'], {
        cwd: dir,
        signal,
        timeoutMs: LOCAL_TIMEOUT_MS
      })
      const url = current.code === 0 ? current.stdout.trim() : ''
      if (url === config.repo) return dir
      // A different repository starts from a clean clone: reusing the old one
      // would push the previous repository's history into the new one.
      record('仓库地址变更，重建本地克隆')
      await removeTree(dir)
    } else if (await pathExists(dir)) {
      await removeTree(dir)
    }
    await ensureDir(path.dirname(dir))
    record('克隆 ' + config.repo)
    const result = await git.run(['clone', config.repo, dir], {
      cwd: path.dirname(dir),
      signal,
      timeoutMs: CLONE_TIMEOUT_MS
    })
    if (result.code !== 0) throw classifyGitFailure(result)
    return dir
  }

  async function commitMessage(config) {
    return 'dsh-sync: snapshot from ' + config.profileName + ' @ ' + new Date().toISOString()
  }

  /**
   * Collect the local snapshot and commit it into the clone. Returns
   * `{snapshot, tree, committed}` or `{blocked, snapshot}` when the secret scan
   * refuses (push only).
   */
  async function stageLocal(config, clone, settings) {
    const snapshot = await collectLocal(config)
    if (settings.scan && !settings.force) {
      const matches = scanEntries(snapshot.entries)
      if (matches.length > 0) return { blocked: matches, snapshot }
    }
    const tree = await writeRepoTree(clone, snapshot, config)
    if (tree.written.length > 0 || tree.removed.length > 0) {
      record('本地快照：写入 ' + tree.written.length + '，移除 ' + tree.removed.length)
    }
    const committed = await commitAll(
      git,
      clone,
      (settings.message && String(settings.message).trim()) || (await commitMessage(config)),
      settings.signal
    )
    return { snapshot, tree, committed }
  }

  async function fetchRemote(config, clone, signal) {
    const result = await git.run(['fetch', 'origin', config.branch], {
      cwd: clone,
      signal,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
    if (result.code === 0) return { empty: false }
    if (/couldn't find remote ref|could not find remote ref|no such remote ref/i.test(result.stderr)) {
      return { empty: true }
    }
    throw classifyGitFailure(result)
  }

  /** ahead/behind of the clone's HEAD compared with FETCH_HEAD. */
  async function compareWithFetched(clone, signal) {
    const fetched = await git.run(['rev-parse', '--verify', 'FETCH_HEAD'], {
      cwd: clone,
      signal,
      timeoutMs: LOCAL_TIMEOUT_MS
    })
    if (fetched.code !== 0) return { ahead: 0, behind: 0, files: [] }
    const head = await headSha(git, clone, signal)
    if (!head) {
      const total = await gitQuery(git, ['rev-list', '--count', 'FETCH_HEAD'], {
        cwd: clone,
        signal,
        timeoutMs: LOCAL_TIMEOUT_MS
      })
      const listing = await gitQuery(git, ['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], {
        cwd: clone,
        signal,
        timeoutMs: LOCAL_TIMEOUT_MS
      })
      const files = listing
        ? listing.split('\n').filter(Boolean).slice(0, 500).map((file) => ({ status: 'A', path: file }))
        : []
      return { ahead: 0, behind: Number(total || 0), files }
    }
    const ahead = await gitQuery(git, ['rev-list', '--count', 'FETCH_HEAD..HEAD'], {
      cwd: clone,
      signal,
      timeoutMs: LOCAL_TIMEOUT_MS
    })
    const behind = await gitQuery(git, ['rev-list', '--count', 'HEAD..FETCH_HEAD'], {
      cwd: clone,
      signal,
      timeoutMs: LOCAL_TIMEOUT_MS
    })
    const diff = await gitQuery(git, ['diff', '--name-status', 'HEAD', 'FETCH_HEAD'], {
      cwd: clone,
      signal,
      timeoutMs: LOCAL_TIMEOUT_MS
    })
    return { ahead: Number(ahead || 0), behind: Number(behind || 0), files: parseNameStatus(diff) }
  }

  async function rebaseOntoFetched(config, clone, signal) {
    const head = await headSha(git, clone, signal)
    if (!head) {
      const checkout = await git.run(['checkout', '-B', config.branch, 'FETCH_HEAD'], {
        cwd: clone,
        signal,
        timeoutMs: LOCAL_TIMEOUT_MS
      })
      if (checkout.code !== 0) throw classifyGitFailure(checkout)
      return { ok: true }
    }
    const result = await git.run(['rebase', 'FETCH_HEAD'], {
      cwd: clone,
      signal,
      timeoutMs: NETWORK_TIMEOUT_MS
    })
    if (result.code === 0) return { ok: true }
    const conflicts = await gitQuery(git, ['diff', '--name-only', '--diff-filter=U'], {
      cwd: clone,
      signal,
      timeoutMs: LOCAL_TIMEOUT_MS
    })
    await git.run(['rebase', '--abort'], { cwd: clone, signal, timeoutMs: LOCAL_TIMEOUT_MS }).catch(() => {})
    await git.run(['reset', '--hard', 'HEAD'], { cwd: clone, signal, timeoutMs: LOCAL_TIMEOUT_MS }).catch(() => {})
    const paths = conflicts ? conflicts.split('\n').filter(Boolean) : []
    if (paths.length > 0 || /CONFLICT|could not apply/i.test(result.stderr)) {
      return { conflict: true, conflicts: paths, detail: result.stderr.trim() }
    }
    throw classifyGitFailure(result)
  }

  function protectedNames(localManifest) {
    const names = new Set([SELF_BUNDLE])
    const deps = localManifest && localManifest.dependencies
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const [name, spec] of Object.entries(deps)) {
        if (isLocalSpec(spec)) names.add(name)
      }
    }
    const bundles = localManifest && localManifest.dsh && localManifest.dsh.profile && localManifest.dsh.profile.bundles
    if (Array.isArray(bundles)) {
      for (const name of bundles) {
        if (SELF_BUNDLE === name) names.add(name)
      }
    }
    return [...names]
  }

  async function applyPulledTree(config, clone, repoTree, state, signal) {
    const applied = await applyRepoTree(clone, repoTree, config, state.managed, { stamp: timestampSlug() })
    const snapshotManifest = parseManifestEntry(repoTree.entries.get('profile/package.json'))
    const localManifest = await readLocalManifest(config.profileDir)
    let reconcile = { installed: [], enabled: [], disabled: [], skipped: [], failed: [], pending: [] }
    const pluginManager = getPluginManager()
    if (snapshotManifest && pluginManager) {
      reconcile = await reconcileBundles({
        pluginManager,
        snapshotManifest,
        localManifest,
        install: config.installMissingBundles,
        protectedNames: protectedNames(localManifest)
      })
    } else if (!pluginManager) {
      reconcile.failed.push({ name: '*', message: 'pluginManager 服务不可用，未对账插件' })
    }
    return { applied, reconcile }
  }

  async function status() {
    try {
      const loaded = await currentConfig()
      const config = loaded.config
      const state = await loadState(env, loaded.profile)
      const version = await gitVersion()
      const clone = cloneDir(config)
      const cloned = config.repo !== '' && (await isGitRepo(clone))
      let cloneHead
      let cloneBranch
      if (cloned) {
        cloneHead = await headSha(git, clone)
        cloneBranch = await branchName(git, clone)
      }
      let drift
      try {
        const snapshot = await collectLocal(config)
        drift = computeDrift(snapshot, state.managed)
      } catch (error) {
        drift = { added: [], modified: [], deleted: [], count: 0, error: error && error.message ? error.message : String(error) }
      }
      const presets = await listPresets()
      return ok(
        {
          configured: config.repo !== '',
          repo: config.repo,
          branch: config.branch,
          autoPull: config.autoPull,
          installMissingBundles: config.installMissingBundles,
          git: version,
          profile: {
            name: loaded.profile.name,
            dir: loaded.profile.dir,
            source: loaded.profile.source,
            ambiguous: loaded.profile.ambiguous === true
          },
          clone: { exists: cloned, dir: clone, head: cloneHead, branch: cloneBranch },
          drift,
          lastSync: state.lastSync,
          lastCheck: state.lastCheck,
          lastError: state.lastError,
          presets,
          paths: {
            profileDir: config.profileDir,
            dataDir: config.dataDir,
            skills: config.skillDirs
          }
        },
        []
      )
    } catch (error) {
      return fail(error)
    }
  }

  async function check(input = {}) {
    try {
      const loaded = await currentConfig()
      const config = loaded.config
      requireRepo(config)
      const clone = await ensureClone(config, input.signal)
      const staged = await stageLocal(config, clone, { signal: input.signal, scan: false })
      const fetched = await fetchRemote(config, clone, input.signal)
      const state = await readState()
      if (fetched.empty) {
        await writeState({
          ...state,
          lastCheck: { at: new Date().toISOString(), ahead: 0, behind: 0, files: [], remoteEmpty: true },
          lastError: null
        })
        return ok(
          {
            remoteEmpty: true,
            ahead: 0,
            behind: 0,
            incoming: [],
            cloneHead: staged.committed.sha,
            branch: config.branch,
            presets: await listPresets()
          },
          ['远端还没有提交，请先推送初始化仓库']
        )
      }
      const compared = await compareWithFetched(clone, input.signal)
      const state2 = await readState()
      await writeState({
        ...state2,
        lastCheck: {
          at: new Date().toISOString(),
          ahead: compared.ahead,
          behind: compared.behind,
          files: compared.files.map((file) => file.path)
        },
        lastError: null
      })
      const summary = [
        '远端落后 ' + compared.behind + ' 个提交，本地领先 ' + compared.ahead + ' 个提交',
        compared.files.length > 0 ? '差异文件 ' + compared.files.length + ' 个' : '两边内容一致'
      ]
      return ok(
        {
          remoteEmpty: false,
          ahead: compared.ahead,
          behind: compared.behind,
          incoming: compared.files,
          cloneHead: staged.committed.sha,
          branch: config.branch,
          presets: await listPresets()
        },
        summary
      )
    } catch (error) {
      const failed = fail(error)
      await rememberError(failed)
      return failed
    }
  }

  async function pull(input = {}) {
    try {
      const loaded = await currentConfig()
      const config = loaded.config
      requireRepo(config)
      const clone = await ensureClone(config, input.signal)
      record('本地快照 → clone')
      const staged = await stageLocal(config, clone, { signal: input.signal, scan: false })
      const fetched = await fetchRemote(config, clone, input.signal)
      if (fetched.empty) {
        const head = staged.committed.sha
        const state = await readState()
        await writeState({
          ...state,
          lastSync: { at: new Date().toISOString(), sha: head, direction: 'pull', files: [] },
          lastError: null
        })
        return ok(
          {
            remoteEmpty: true,
            applied: null,
            reconcile: null,
            branch: config.branch,
            sha: head,
            presets: await listPresets()
          },
          ['远端还没有提交，本地快照已就绪，可以推送']
        )
      }
      if (input.dryRun) {
        const compared = await compareWithFetched(clone, input.signal)
        return ok(
          {
            dryRun: true,
            ahead: compared.ahead,
            behind: compared.behind,
            incoming: compared.files,
            branch: config.branch
          },
          ['预览：将应用 ' + compared.files.length + ' 个差异文件（未写入本地）']
        )
      }
      record('rebase 到远端')
      const rebased = await rebaseOntoFetched(config, clone, input.signal)
      if (rebased.conflict) {
        const paths = rebased.conflicts || []
        const error = {
          code: 'merge-conflict',
          message: '拉取中止：' + paths.length + ' 个文件两边都改过，本地文件未改动',
          detail: [paths.join('\n'), rebased.detail].filter(Boolean).join('\n\n')
        }
        const state = await readState()
        await writeState({
          ...state,
          lastError: { at: new Date().toISOString(), code: error.code, message: error.message }
        }).catch(() => {})
        return { ok: false, error, data: { conflicts: paths }, summary: [error.message, ...paths.slice(0, 20)] }
      }
      const repoTree = await readRepoTree(clone)
      const state = await readState()
      const { applied, reconcile } = await applyPulledTree(config, clone, repoTree, state, input.signal)
      const sha = await headSha(git, clone, input.signal)
      await writeState({
        ...state,
        lastSync: {
          at: new Date().toISOString(),
          sha,
          direction: 'pull',
          files: [...applied.added, ...applied.modified, ...applied.deleted]
        },
        lastError: null,
        managed: applied.managed
      })
      const presets = await listPresets()
      const summary = [
        '已从 ' + config.branch + ' 拉取：新增 ' + applied.added.length + '、更新 ' + applied.modified.length + '、删除 ' + applied.deleted.length
      ]
      if (applied.backupDir) summary.push('覆盖前备份：' + applied.backupDir)
      if (applied.ignored.length > 0) summary.push('忽略 ' + applied.ignored.length + ' 个未配置路径（见日志）')
      if (reconcile.installed.length > 0) summary.push('安装插件：' + reconcile.installed.join(', '))
      if (reconcile.enabled.length > 0) summary.push('启用插件：' + reconcile.enabled.join(', '))
      if (reconcile.disabled.length > 0) summary.push('禁用插件：' + reconcile.disabled.join(', '))
      if (reconcile.pending.length > 0) summary.push('待安装（超出单次上限）：' + reconcile.pending.join(', '))
      if (reconcile.failed.length > 0) summary.push('插件对账失败：' + reconcile.failed.map((item) => item.name).join(', '))
      summary.push('当前模式 ' + presets.items.length + ' 个')
      return ok(
        {
          applied: {
            added: applied.added,
            modified: applied.modified,
            deleted: applied.deleted,
            ignored: applied.ignored,
            backupDir: applied.backupDir
          },
          reconcile,
          branch: config.branch,
          sha,
          presets,
          restartRequired: reconcile.disabled.length > 0
        },
        summary
      )
    } catch (error) {
      const failed = fail(error)
      await rememberError(failed)
      return failed
    }
  }

  async function push(input = {}) {
    try {
      const loaded = await currentConfig()
      const config = loaded.config
      requireRepo(config)
      const clone = await ensureClone(config, input.signal)
      const staged = await stageLocal(config, clone, {
        signal: input.signal,
        scan: true,
        force: input.force === true,
        message: input.message
      })
      if (staged.blocked) {
        const matches = staged.blocked
        const message =
          '检测到疑似密钥，未推送：' +
          matches.slice(0, 5).map((match) => match.path + ':' + match.line + ' (' + match.rule + ')').join(', ')
        return {
          ok: false,
          error: { code: 'secret-detected', message, detail: matches.map((m) => m.path + ':' + m.line + ' ' + m.rule).join('\n') },
          data: { matches },
          summary: [message]
        }
      }
      record('推送 ' + config.branch)
      const result = await git.run(['push', '-u', 'origin', 'HEAD:' + config.branch], {
        cwd: clone,
        signal: input.signal,
        timeoutMs: CLONE_TIMEOUT_MS
      })
      if (result.code !== 0) {
        const failure = classifyGitFailure(result)
        const failed = fail(failure)
        const state = await readState()
        await writeState({
          ...state,
          lastError: { at: new Date().toISOString(), code: failed.error.code, message: failed.error.message }
        }).catch(() => {})
        return failed
      }
      const head = await headSha(git, clone, input.signal)
      // A preceding Check may already have committed the snapshot, so the push
      // itself can have written nothing. Report the commit's files either way.
      let changed = [...staged.tree.written, ...staged.tree.removed]
      if (changed.length === 0 && head) {
        // `show` lists the root commit's files too, unlike HEAD~1..HEAD.
        const diff = await gitQuery(git, ['show', '--pretty=format:', '--name-only', 'HEAD'], {
          cwd: clone,
          signal: input.signal,
          timeoutMs: LOCAL_TIMEOUT_MS
        })
        if (diff) changed = diff.split('\n').filter(Boolean)
      }
      const state = await readState()
      const managed = {}
      for (const entry of staged.snapshot.entries) managed[entry.rel] = entry.sha
      await writeState({
        ...state,
        lastSync: {
          at: new Date().toISOString(),
          sha: head,
          direction: 'push',
          files: changed
        },
        lastError: null,
        managed
      })
      const presets = await listPresets()
      const summary = [
        '已推送到 ' + config.branch + '：' + changed.length + ' 个文件变更',
        '提交 ' + String(head || '').slice(0, 12),
        '当前模式 ' + presets.items.length + ' 个'
      ]
      return ok(
        {
          branch: config.branch,
          sha: head,
          files: changed,
          removed: staged.tree.removed,
          skipped: staged.snapshot.skipped.slice(0, 100),
          strippedDeps: staged.snapshot.strippedDeps,
          presets
        },
        summary
      )
    } catch (error) {
      const failed = fail(error)
      await rememberError(failed)
      return failed
    }
  }

  async function saveConfig(patch = {}) {
    try {
      const { stored, config } = await saveConnection(env, await profile(), patch)
      record('配置已保存：' + (config.repo || '(未设置仓库)'))
      const summary = [
        config.repo ? '已保存仓库地址' : '已清空仓库地址',
        '分支 ' + config.branch,
        config.autoPull ? '启动后自动拉取：开' : '启动后自动拉取：关'
      ]
      return ok({ configured: config.repo !== '', repo: config.repo, branch: config.branch, autoPull: config.autoPull, stored }, summary)
    } catch (error) {
      return fail(error)
    }
  }

  async function testConnection() {
    try {
      const loaded = await currentConfig()
      const config = loaded.config
      requireRepo(config)
      await ensureDir(config.dataDir)
      const result = await git.run(['ls-remote', '--heads', config.repo, config.branch], {
        cwd: config.dataDir,
        timeoutMs: NETWORK_TIMEOUT_MS
      })
      if (result.code !== 0) throw classifyGitFailure(result)
      const heads = result.stdout.split('\n').filter((line) => line.trim() !== '')
      return ok(
        {
          repo: config.repo,
          branch: config.branch,
          branchExists: heads.length > 0
        },
        [heads.length > 0 ? '仓库可访问，分支 ' + config.branch + ' 已存在' : '仓库可访问，分支 ' + config.branch + ' 还不存在（首次推送会创建）']
      )
    } catch (error) {
      return fail(error)
    }
  }

  async function loadConfig() {
    const loaded = await currentConfig()
    return loaded
  }

  return {
    status,
    check,
    pull,
    push,
    saveConfig,
    testConnection,
    loadConfig,
    drainLog,
    gitVersion
  }
}
