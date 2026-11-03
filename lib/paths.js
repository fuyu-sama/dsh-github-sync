// Filesystem and path helpers for dsh-github-sync.
//
// Everything here is plain Node ESM with no Cordis dependency, so the sync
// engine can be unit-tested (`node --test`) without booting the Harness.

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (nonEmpty(configured)) return path.resolve(configured)
  return path.join(os.homedir(), '.dsh')
}

export function profileName(env = process.env) {
  if (nonEmpty(env.DSH_PROFILE)) return env.DSH_PROFILE.trim()
  if (nonEmpty(env.DSH_PROFILE_DIR)) return path.basename(path.resolve(env.DSH_PROFILE_DIR))
  return 'desktop'
}

/**
 * Environment-only profile location. The Desktop Host boots an
 * application-owned profile and exports no DSH_PROFILE*, so this is only the
 * first candidate: `lib/profile-dir.js` discovers the real directory from the
 * Loader or the profile manifests before any file is touched.
 */
export function profileDir(env = process.env) {
  if (nonEmpty(env.DSH_PROFILE_DIR)) return path.resolve(env.DSH_PROFILE_DIR)
  return path.join(dshHome(env), 'profiles', profileName(env))
}

export function hasExplicitProfile(env = process.env) {
  return nonEmpty(env.DSH_PROFILE_DIR) || nonEmpty(env.DSH_PROFILE)
}

/** Machine-local state for this profile: connection.json, state.json, repo/, backups/. */
export function pluginDataDir(env = process.env, name = profileName(env)) {
  return path.join(dshHome(env), 'dsh-github-sync', name)
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

export async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (text.trim() === '') return undefined
  return JSON.parse(text)
}

export async function fileMode(target) {
  try {
    const info = await stat(target)
    return info.mode & 0o777
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

export async function writeJsonAtomic(file, value) {
  return writeBytesAtomic(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'))
}

export async function writeBytesAtomic(file, data, options = {}) {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const existing = options.mode ?? (await fileMode(file))
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp')
  try {
    await writeFile(tmp, data)
    if (existing !== undefined) await chmod(tmp, existing).catch(() => {})
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return file
}

export async function copyFilePreserving(source, target) {
  await ensureDir(path.dirname(target))
  const mode = await fileMode(source)
  await copyFile(source, target)
  if (mode !== undefined) await chmod(target, mode).catch(() => {})
  return target
}

/** Remove a directory tree, refusing anything that is not a plain absolute path. */
export async function removeTree(target) {
  const resolved = path.resolve(target)
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error('refusing to remove ' + String(target))
  }
  await rm(resolved, { recursive: true, force: true })
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

export function expandHome(value, env = process.env) {
  if (typeof value !== 'string') return value
  let next = value.trim()
  if (next === '~') return dshHome(env)
  if (next.startsWith('~/')) next = path.join(dshHome(env), next.slice(2))
  if (next.startsWith('$DSH_HOME/')) next = path.join(dshHome(env), next.slice('$DSH_HOME/'.length))
  return next
}

/** 'YYYYMMDD-HHmmss' in local time, for backup directories. */
export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
