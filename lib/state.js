// Machine-local persistence for dsh-github-sync.
//
// connection.json holds what the user configured for THIS machine (repository,
// branch, behavior). state.json holds sync bookkeeping. Neither is synchronized:
// the connection belongs to the machine, not to the configuration it mirrors.

import path from 'node:path'
import { isRecord, pluginDataDir, readJson, writeJsonAtomic } from './paths.js'
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_PROFILE_FILES,
  normalizeConfig,
  sanitizeBranch
} from './snapshot.js'

export const CONNECTION_FILE = 'connection.json'
export const STATE_FILE = 'state.json'
export const CONNECTION_SCHEMA_VERSION = 1
export const STATE_SCHEMA_VERSION = 1

export function connectionFile(env = process.env, profile = { name: 'desktop' }) {
  return path.join(pluginDataDir(env, profile.name), CONNECTION_FILE)
}

export function stateFile(env = process.env, profile = { name: 'desktop' }) {
  return path.join(pluginDataDir(env, profile.name), STATE_FILE)
}

/** Validate a repository address without requiring it to be reachable. */
export function validateRepo(repo) {
  const value = String(repo ?? '').trim()
  if (value === '') return { ok: false, message: '仓库地址不能为空' }
  if (value.startsWith('-')) return { ok: false, message: '仓库地址不能以 - 开头' }
  if (/\s/.test(value)) return { ok: false, message: '仓库地址不能包含空白字符' }
  if (value.length > 2048) return { ok: false, message: '仓库地址过长' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/@\s]+@[^:\s]+:[^\s]+$/.test(value) || path.isAbsolute(value)) {
    return { ok: true }
  }
  return {
    ok: false,
    message: '仓库地址需为 https:// / ssh:// / git@host:path / file:// 或本机绝对路径'
  }
}

function defaultStored() {
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    repo: '',
    branch: 'main',
    autoPull: false,
    installMissingBundles: true,
    enableCommand: true,
    profileFiles: DEFAULT_PROFILE_FILES.slice(),
    skillDirs: undefined,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES
  }
}

function storedFromRaw(raw) {
  const base = defaultStored()
  if (!isRecord(raw)) return base
  return {
    ...base,
    repo: typeof raw.repo === 'string' ? raw.repo : '',
    branch: typeof raw.branch === 'string' ? sanitizeBranch(raw.branch) : 'main',
    autoPull: raw.autoPull === true,
    installMissingBundles: raw.installMissingBundles !== false,
    enableCommand: raw.enableCommand !== false,
    profileFiles: Array.isArray(raw.profileFiles) && raw.profileFiles.length > 0 ? raw.profileFiles.slice() : base.profileFiles,
    skillDirs: isRecord(raw.skillDirs) || Array.isArray(raw.skillDirs) ? raw.skillDirs : undefined,
    maxFileBytes: Number.isFinite(raw.maxFileBytes) && raw.maxFileBytes > 0 ? raw.maxFileBytes : base.maxFileBytes
  }
}

export async function loadConnection(env = process.env, profile = { name: 'desktop' }) {
  let raw
  try {
    raw = await readJson(connectionFile(env, profile))
  } catch {
    raw = undefined
  }
  const stored = storedFromRaw(raw)
  return { stored, config: normalizeConfig(stored, env, profile), corrupt: raw !== undefined && !isRecord(raw) }
}

/** Persist a validated patch and return the resulting stored/config pair. */
export async function saveConnection(env, profile, patch) {
  const current = await loadConnection(env, profile)
  const next = { ...current.stored }
  if (Object.prototype.hasOwnProperty.call(patch, 'repo')) {
    const repo = String(patch.repo ?? '').trim()
    if (repo !== '') {
      const valid = validateRepo(repo)
      if (!valid.ok) {
        const error = new Error(valid.message)
        error.code = 'invalid-config'
        throw error
      }
    }
    next.repo = repo
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'branch')) next.branch = sanitizeBranch(patch.branch)
  if (Object.prototype.hasOwnProperty.call(patch, 'autoPull')) next.autoPull = patch.autoPull === true
  if (Object.prototype.hasOwnProperty.call(patch, 'installMissingBundles')) {
    next.installMissingBundles = patch.installMissingBundles !== false
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'enableCommand')) next.enableCommand = patch.enableCommand !== false
  if (Array.isArray(patch.profileFiles) && patch.profileFiles.length > 0) {
    next.profileFiles = patch.profileFiles.map(String)
  }
  if (isRecord(patch.skillDirs) || Array.isArray(patch.skillDirs)) next.skillDirs = patch.skillDirs
  if (Number.isFinite(patch.maxFileBytes) && patch.maxFileBytes > 0) next.maxFileBytes = patch.maxFileBytes
  next.schemaVersion = CONNECTION_SCHEMA_VERSION
  await writeJsonAtomic(connectionFile(env, profile), next)
  return { stored: next, config: normalizeConfig(next, env, profile) }
}

function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastSync: null,
    lastCheck: null,
    lastError: null,
    managed: {}
  }
}

export async function loadState(env = process.env, profile = { name: 'desktop' }) {
  let raw
  try {
    raw = await readJson(stateFile(env, profile))
  } catch {
    raw = undefined
  }
  const base = defaultState()
  if (!isRecord(raw)) return base
  return {
    ...base,
    lastSync: isRecord(raw.lastSync) ? raw.lastSync : null,
    lastCheck: isRecord(raw.lastCheck) ? raw.lastCheck : null,
    lastError: isRecord(raw.lastError) ? raw.lastError : null,
    managed: isRecord(raw.managed) ? raw.managed : {}
  }
}

export async function saveState(env, profile, state) {
  const next = { ...defaultState(), ...(isRecord(state) ? state : {}) }
  next.schemaVersion = STATE_SCHEMA_VERSION
  await writeJsonAtomic(stateFile(env, profile), next)
  return next
}
