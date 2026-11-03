// git execution for dsh-github-sync.
//
// git runs through the Host subprocess seam (`ctx.subprocess`) so the plugin
// never owns a process tree the Harness cannot tear down. Authentication stays
// entirely ambient: SSH agent / credential helper configuration of the user's
// own environment. No token is read, stored, or passed on a command line.

import { stat } from 'node:fs/promises'
import path from 'node:path'

const CANDIDATE_GIT_PATHS = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  '/opt/local/bin/git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
]

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 1024 * 1024

export class GitError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'GitError'
    this.code = code
    this.detail = detail
  }
}

function gitProcessEnv(env) {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_MERGE_AUTOEDIT: 'no',
    LC_ALL: 'C',
    LANG: 'C'
  }
}

function tail(text, limit = 4000) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Map a failed git run onto one of the plugin's public failure codes. */
export function classifyGitFailure(result) {
  const text = String(result.stderr || '') + '\n' + String(result.stdout || '')
  if (result.timedOut) {
    return new GitError('network', 'git 操作超时，请检查网络或仓库地址', tail(text))
  }
  if (
    /Permission denied \(publickey\)|Authentication failed|could not read Username|could not read Password|Host key verification failed|terminal prompts disabled|Invalid username or password|Repository not found/i.test(
      text
    )
  ) {
    return new GitError(
      'auth-failed',
      'git 认证失败：请确认本机 SSH key 已加入 ssh-agent（或 HTTPS 已配置 credential helper），并拥有该仓库权限',
      tail(text)
    )
  }
  if (
    /Could not resolve host|unable to access|Connection timed out|Connection refused|Network is unreachable|SSL|TLS|proxy|could not read from remote repository/i.test(
      text
    )
  ) {
    return new GitError('network', 'git 网络错误：无法访问远端仓库', tail(text))
  }
  if (/non-fast-forward|fetch first|Updates were rejected|\[rejected\]/i.test(text)) {
    return new GitError('remote-ahead', '远端有新提交，请先拉取再推送', tail(text))
  }
  return new GitError('internal', 'git 命令失败（exit ' + String(result.code) + '）', tail(text || result.argv?.join(' ')))
}

export function createGitRunner(subprocess, options = {}) {
  const baseEnv = options.env ?? process.env
  let resolved

  async function resolveGit(signal) {
    if (resolved) return resolved
    const attempts = []
    if (subprocess && typeof subprocess.resolveExecutable === 'function') {
      try {
        const found = await subprocess.resolveExecutable('git', baseEnv, signal)
        if (found) attempts.push(found)
      } catch {
        // Fall through to the filesystem candidates below.
      }
    }
    attempts.push(...CANDIDATE_GIT_PATHS)
    for (const candidate of attempts) {
      try {
        const info = await stat(candidate)
        if (info.isFile()) {
          resolved = candidate
          return candidate
        }
      } catch {
        // Try the next candidate.
      }
    }
    throw new GitError(
      'git-missing',
      '找不到 git 可执行文件：请安装 git 或把它加入 PATH（插件用本机 git 凭据访问 GitHub）'
    )
  }

  /**
   * Run one git command. Resolves with `{ code, stdout, stderr, timedOut }`
   * instead of throwing for a non-zero exit, so callers classify the failure.
   */
  async function run(args, runOptions = {}) {
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      throw new GitError('git-missing', 'Host subprocess 服务不可用，无法执行 git')
    }
    const executable = await resolveGit(runOptions.signal)
    const cwd = runOptions.cwd
    if (!cwd) throw new GitError('internal', 'git 缺少工作目录')
    const timeoutMs = runOptions.timeoutMs ?? 60000
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    let timedOut = false
    timeoutSignal.addEventListener('abort', () => {
      timedOut = true
    }, { once: true })
    const signals = [timeoutSignal]
    if (runOptions.signal) signals.push(runOptions.signal)
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const argv = [executable, ...args]
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_STDOUT_BYTES, spill: { maxBytes: MAX_STDOUT_BYTES } },
          stderr: { maxBytes: MAX_STDERR_BYTES, spill: { maxBytes: MAX_STDERR_BYTES } }
        },
        graceMs: 2000,
        signal,
        env: gitProcessEnv(baseEnv)
      })
    } catch (error) {
      throw new GitError('internal', '无法启动 git：' + (error && error.message ? error.message : String(error)))
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new GitError('internal', 'git 进程异常：' + (error && error.message ? error.message : String(error)))
    }
    let stdout = ''
    let stderr = ''
    try {
      if (handle.collected && handle.collected.stdout) stdout = handle.collected.stdout.readFrom(0).text
      if (handle.collected && handle.collected.stderr) stderr = handle.collected.stderr.readFrom(0).text
    } catch {
      // A missing reader means no captured bytes; the exit facts still stand.
    }
    return {
      code: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      timedOut,
      argv
    }
  }

  return {
    run,
    resolveGit,
    version: async (signal) => {
      const result = await run(['--version'], { cwd: baseEnv.HOME || process.cwd(), signal, timeoutMs: 10000 })
      if (result.code !== 0) return undefined
      return result.stdout.trim()
    }
  }
}

export async function isGitRepo(dir) {
  try {
    const info = await stat(path.join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

/** Run a query expected to succeed; returns trimmed stdout or undefined. */
export async function gitQuery(git, args, runOptions) {
  const result = await git.run(args, runOptions)
  if (result.code !== 0) return undefined
  return result.stdout.trim()
}

export async function headSha(git, dir, signal) {
  return gitQuery(git, ['rev-parse', '--verify', 'HEAD'], { cwd: dir, signal, timeoutMs: 15000 })
}

export async function branchName(git, dir, signal) {
  return gitQuery(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, signal, timeoutMs: 15000 })
}

export async function statusPorcelain(git, dir, signal) {
  const text = await gitQuery(git, ['status', '--porcelain'], { cwd: dir, signal, timeoutMs: 30000 })
  if (!text) return []
  return text.split('\n').filter((line) => line.trim() !== '')
}

/**
 * Commit everything in the working tree. Uses a synthetic identity only when the
 * machine has no user.name configured, so the author stays the user's own when
 * one exists.
 */
export async function commitAll(git, dir, message, signal) {
  const staged = await git.run(['add', '-A'], { cwd: dir, signal, timeoutMs: 30000 })
  if (staged.code !== 0) throw classifyGitFailure(staged)
  // `git status --porcelain` works on an unborn branch, unlike `diff --cached`.
  const changed = await statusPorcelain(git, dir, signal)
  if (changed.length === 0) return { committed: false, sha: await headSha(git, dir, signal) }
  const identity = []
  const userName = await gitQuery(git, ['config', 'user.name'], { cwd: dir, signal, timeoutMs: 10000 })
  if (!userName) {
    identity.push('-c', 'user.name=dsh-sync', '-c', 'user.email=dsh-sync@localhost')
  }
  const result = await git.run([...identity, 'commit', '--no-verify', '-m', message], {
    cwd: dir,
    signal,
    timeoutMs: 60000
  })
  if (result.code !== 0) throw classifyGitFailure(result)
  return { committed: true, sha: await headSha(git, dir, signal) }
}
