// Snapshot collection and materialization for dsh-github-sync.
//
// The repository layout is fixed and small:
//
//   dsh-sync.json           metadata written by this tool
//   profile/<file>          the profile's manifest and cordis patch files
//   skills/<label>/<...>    each configured skill root, mirrored
//
// Only configured paths are ever read or deleted. Files that were never part of
// a snapshot are never touched on the local side.

import { chmod, copyFile, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  dshHome,
  ensureDir,
  pathExists,
  pluginDataDir,
  profileDir,
  profileName,
  sha256,
  writeBytesAtomic,
  writeJsonAtomic
} from './paths.js'
import { isNeverSyncName } from './secret-scan.js'

export const SELF_BUNDLE = 'dsh-github-sync'
export const DEFAULT_PROFILE_FILES = [
  'cordis.patch.yml',
  'package.json',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'compatibility.json'
]
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
export const SNAPSHOT_DIRS = ['profile', 'skills']
const SKIP_ENTRY_NAMES = new Set(['.git', 'node_modules', '.DS_Store'])
const MAX_DEPTH = 24
const LOCAL_SPEC = /^(?:link:|file:|\.\/|\.\.\/|\/|~\/)/

export function isLocalSpec(spec) {
  return typeof spec === 'string' && LOCAL_SPEC.test(spec)
}

export function defaultSkillDirs(env) {
  return [{ label: 'user', path: path.join(dshHome(env), 'skills') }]
}

export function normalizeSkillDirs(value, env) {
  if (value === undefined || value === null) return defaultSkillDirs(env)
  const pairs = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') pairs.push({ label: path.basename(item), path: item })
      else if (item && typeof item === 'object' && typeof item.path === 'string') {
        pairs.push({ label: typeof item.label === 'string' && item.label ? item.label : path.basename(item.path), path: item.path })
      }
    }
  } else if (typeof value === 'object') {
    for (const [label, dir] of Object.entries(value)) {
      if (typeof dir === 'string') pairs.push({ label, path: dir })
    }
  }
  const cleaned = []
  for (const pair of pairs) {
    const label = String(pair.label).trim().replace(/[^A-Za-z0-9._-]+/g, '-')
    if (!label) continue
    const raw = String(pair.path).trim()
    if (!raw) continue
    let resolved = raw
    if (raw === '~') resolved = dshHome(env)
    else if (raw.startsWith('~/')) resolved = path.join(dshHome(env), raw.slice(2))
    else if (raw.startsWith('$DSH_HOME/')) resolved = path.join(dshHome(env), raw.slice('$DSH_HOME/'.length))
    cleaned.push({ label, path: path.resolve(resolved) })
  }
  if (cleaned.length === 0) return defaultSkillDirs(env)
  return cleaned
}

export function sanitizeBranch(value) {
  const branch = String(value ?? '').trim()
  if (branch === '') return 'main'
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) return 'main'
  return branch
}

/** Expand a stored connection into the full runtime config used by the engine. */
export function normalizeConfig(connection, env = process.env, profile) {
  const raw = connection && typeof connection === 'object' ? connection : {}
  const files = Array.isArray(raw.profileFiles) && raw.profileFiles.length > 0
    ? raw.profileFiles.map((name) => String(name)).filter((name) => name !== '' && !name.includes('/') && !name.includes('\\'))
    : DEFAULT_PROFILE_FILES.slice()
  const maxFileBytes = Number.isFinite(raw.maxFileBytes) && raw.maxFileBytes > 0
    ? Math.min(Math.floor(raw.maxFileBytes), 32 * 1024 * 1024)
    : DEFAULT_MAX_FILE_BYTES
  const name = profile && typeof profile.name === 'string' && profile.name !== '' ? profile.name : profileName(env)
  const dir = profile && typeof profile.dir === 'string' && profile.dir !== '' ? path.resolve(profile.dir) : profileDir(env)
  return {
    repo: typeof raw.repo === 'string' ? raw.repo.trim() : '',
    branch: sanitizeBranch(raw.branch),
    autoPull: raw.autoPull === true,
    installMissingBundles: raw.installMissingBundles !== false,
    enableCommand: raw.enableCommand !== false,
    maxFileBytes,
    profileFiles: files,
    skillDirs: normalizeSkillDirs(raw.skillDirs, env),
    homeDir: dshHome(env),
    profileDir: dir,
    profileName: name,
    dataDir: pluginDataDir(env, name)
  }
}

function compareEntries(a, b) {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

async function walkSkillDir(root, relRoot, entries, skipped, config, sub = '', depth = 0) {
  const dir = sub === '' ? root : path.join(root, sub)
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    skipped.push({ rel: relRoot + (sub === '' ? '' : '/' + sub), reason: 'unreadable' })
    return
  }
  items.sort(compareEntries)
  for (const item of items) {
    if (SKIP_ENTRY_NAMES.has(item.name) || item.name.startsWith('.')) continue
    const abs = path.join(dir, item.name)
    const rel = sub === '' ? item.name : sub + '/' + item.name
    let info
    try {
      info = await stat(abs)
    } catch {
      skipped.push({ rel: relRoot + '/' + rel, reason: 'broken-link' })
      continue
    }
    if (info.isDirectory()) {
      if (depth >= MAX_DEPTH) {
        skipped.push({ rel: relRoot + '/' + rel, reason: 'too-deep' })
        continue
      }
      await walkSkillDir(root, relRoot, entries, skipped, config, rel, depth + 1)
      continue
    }
    if (!info.isFile()) {
      skipped.push({ rel: relRoot + '/' + rel, reason: 'not-a-file' })
      continue
    }
    if (isNeverSyncName(item.name)) {
      skipped.push({ rel: relRoot + '/' + rel, reason: 'never-sync' })
      continue
    }
    if (info.size > config.maxFileBytes) {
      skipped.push({ rel: relRoot + '/' + rel, reason: 'too-large' })
      continue
    }
    let data
    try {
      data = await readFile(abs)
    } catch {
      skipped.push({ rel: relRoot + '/' + rel, reason: 'unreadable' })
      continue
    }
    entries.push({ rel: relRoot + '/' + rel, data, sha: sha256(data), source: abs })
  }
}

/**
 * Strip machine-local dependency specs (and this plugin itself) from the synced
 * profile manifest. `link:` and `file:` paths are meaningless on another
 * machine, and synchronizing this plugin would try to remove the tool doing the
 * synchronizing.
 */
export function sanitizeManifest(buffer) {
  let manifest
  try {
    manifest = JSON.parse(buffer.toString('utf8'))
  } catch {
    return { data: buffer, strippedDeps: [], warning: 'package.json 无法解析，按原文同步' }
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { data: buffer, strippedDeps: [], warning: 'package.json 不是对象，按原文同步' }
  }
  const strippedDeps = []
  if (manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)) {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (isLocalSpec(spec)) {
        strippedDeps.push({ name, spec })
        delete manifest.dependencies[name]
      }
    }
  }
  if (manifest.dependencies && typeof manifest.dependencies === 'object' && SELF_BUNDLE in manifest.dependencies) {
    strippedDeps.push({ name: SELF_BUNDLE, spec: manifest.dependencies[SELF_BUNDLE] })
    delete manifest.dependencies[SELF_BUNDLE]
  }
  const bundles = manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== SELF_BUNDLE)
  }
  return { data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), strippedDeps }
}

/** Read the configured local paths into the repository layout. */
export async function collectLocal(config) {
  const entries = []
  const skipped = []
  let strippedDeps = []
  for (const name of config.profileFiles) {
    const abs = path.join(config.profileDir, name)
    if (!(await pathExists(abs))) {
      skipped.push({ rel: 'profile/' + name, reason: 'missing' })
      continue
    }
    let data
    try {
      data = await readFile(abs)
    } catch {
      skipped.push({ rel: 'profile/' + name, reason: 'unreadable' })
      continue
    }
    if (name === 'package.json') {
      const sanitized = sanitizeManifest(data)
      data = sanitized.data
      strippedDeps = sanitized.strippedDeps
      if (sanitized.warning) skipped.push({ rel: 'profile/' + name, reason: sanitized.warning })
    }
    entries.push({ rel: 'profile/' + name, data, sha: sha256(data), source: abs })
  }
  for (const dir of config.skillDirs) {
    const relRoot = 'skills/' + dir.label
    if (!(await pathExists(dir.path))) {
      skipped.push({ rel: relRoot, reason: 'missing-dir' })
      continue
    }
    await walkSkillDir(dir.path, relRoot, entries, skipped, config)
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  // The metadata file must stay byte-identical across machines and runs:
  // anything volatile (timestamps, machine paths, per-machine dependency
  // details) would conflict on every pull. Machine-specific facts stay in the
  // local state file instead.
  const meta = { schemaVersion: 1, tool: SELF_BUNDLE }
  return { entries, skipped, meta, strippedDeps }
}

async function pruneDir(repoDir, dir, wanted, removed) {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    if (item.name === '.git') continue
    const abs = path.join(dir, item.name)
    const rel = path.relative(repoDir, abs).split(path.sep).join('/')
    if (item.isDirectory()) {
      await pruneDir(repoDir, abs, wanted, removed)
      try {
        await rmdir(abs)
      } catch {
        // Not empty (or vanished) — keep it.
      }
      continue
    }
    if (!wanted.has(rel)) {
      await rm(abs, { force: true })
      removed.push(rel)
    }
  }
}

/** Make the clone's working tree mirror the collected local snapshot. */
export async function writeRepoTree(repoDir, snapshot, config) {
  const wanted = new Set(snapshot.entries.map((entry) => entry.rel))
  const written = []
  for (const entry of snapshot.entries) {
    const target = path.join(repoDir, entry.rel.split('/').join(path.sep))
    if (await pathExists(target)) {
      try {
        const current = await readFile(target)
        if (sha256(current) === entry.sha) continue
      } catch {
        // Fall through and rewrite it.
      }
    }
    await writeBytesAtomic(target, entry.data)
    written.push(entry.rel)
  }
  const removed = []
  for (const top of SNAPSHOT_DIRS) {
    const abs = path.join(repoDir, top)
    if (await pathExists(abs)) await pruneDir(repoDir, abs, wanted, removed)
  }
  await writeJsonAtomic(path.join(repoDir, 'dsh-sync.json'), snapshot.meta)
  return { written, removed }
}

async function walkRepoTree(repoDir, dir, entries) {
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  items.sort(compareEntries)
  for (const item of items) {
    if (item.name === '.git') continue
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      await walkRepoTree(repoDir, abs, entries)
      continue
    }
    if (!item.isFile()) continue
    const rel = path.relative(repoDir, abs).split(path.sep).join('/')
    let data
    try {
      data = await readFile(abs)
    } catch {
      continue
    }
    entries.set(rel, { rel, data, sha: sha256(data) })
  }
}

/** Read the repository tree after git merged it. */
export async function readRepoTree(repoDir) {
  const entries = new Map()
  for (const top of SNAPSHOT_DIRS) {
    const abs = path.join(repoDir, top)
    if (await pathExists(abs)) await walkRepoTree(repoDir, abs, entries)
  }
  let meta
  try {
    meta = JSON.parse(await readFile(path.join(repoDir, 'dsh-sync.json'), 'utf8'))
  } catch {
    meta = undefined
  }
  return { entries, meta }
}

/** Map a repository path back onto the local filesystem, or undefined when unmanaged. */
export function mapRepoPathToLocal(rel, config) {
  if (rel === 'dsh-sync.json') return undefined
  if (rel.startsWith('profile/')) {
    const name = rel.slice('profile/'.length)
    if (name === '' || name.includes('/')) return undefined
    if (!config.profileFiles.includes(name)) return undefined
    return path.join(config.profileDir, name)
  }
  if (rel.startsWith('skills/')) {
    const rest = rel.slice('skills/'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) return undefined
    const label = rest.slice(0, slash)
    const inner = rest.slice(slash + 1)
    const dir = config.skillDirs.find((item) => item.label === label)
    if (!dir) return undefined
    const root = path.resolve(dir.path)
    const target = path.resolve(root, inner)
    if (target !== root && !target.startsWith(root + path.sep)) return undefined
    return target
  }
  return undefined
}

async function pruneEmptyParents(target, stopAt) {
  const stop = path.resolve(stopAt)
  let current = path.dirname(target)
  while (current.startsWith(stop + path.sep)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

/**
 * Apply a merged repository tree to the local filesystem.
 *
 * - `package.json` is node output of the bundle reconciliation, never written here.
 * - overwrites and deletions are backed up first
 * - only paths recorded in `previousManaged` may be deleted
 */
export async function applyRepoTree(repoDir, repoTree, config, previousManaged, options = {}) {
  const nextManaged = {}
  const added = []
  const modified = []
  const deleted = []
  const ignored = []
  const unchanged = []
  const backupRoot = path.join(config.dataDir, 'backups', options.stamp || String(Date.now()))
  let backupUsed = false

  async function backup(target, rel) {
    const destination = path.join(backupRoot, rel.split('/').join(path.sep))
    await ensureDir(path.dirname(destination))
    await copyFile(target, destination)
    try {
      const info = await stat(target)
      await chmod(destination, info.mode & 0o777)
    } catch {
      // Mode preservation is best effort.
    }
    backupUsed = true
  }

  for (const [rel, entry] of repoTree.entries) {
    const target = mapRepoPathToLocal(rel, config)
    if (!target) {
      ignored.push(rel)
      continue
    }
    nextManaged[rel] = entry.sha
    if (rel === 'profile/package.json') continue
    const exists = await pathExists(target)
    if (exists && previousManaged[rel] === entry.sha) {
      unchanged.push(rel)
      continue
    }
    if (exists) {
      let current
      try {
        current = await readFile(target)
      } catch {
        current = undefined
      }
      if (current !== undefined && sha256(current) === entry.sha) {
        unchanged.push(rel)
        continue
      }
      await backup(target, rel)
      modified.push(rel)
    } else {
      added.push(rel)
    }
    await writeBytesAtomic(target, entry.data)
  }

  for (const rel of Object.keys(previousManaged)) {
    if (nextManaged[rel]) continue
    if (rel === 'profile/package.json') continue
    const target = mapRepoPathToLocal(rel, config)
    if (!target) continue
    if (!(await pathExists(target))) continue
    await backup(target, rel)
    await rm(target, { force: true })
    deleted.push(rel)
    const dir = config.skillDirs.find((item) => target.startsWith(path.resolve(item.path) + path.sep))
    if (dir) await pruneEmptyParents(target, dir.path)
  }

  return {
    added,
    modified,
    deleted,
    ignored,
    unchanged,
    managed: nextManaged,
    backupDir: backupUsed ? backupRoot : undefined
  }
}

/** Compare the current local snapshot against the last synchronized hashes. */
export function computeDrift(snapshot, managed) {
  const previous = managed && typeof managed === 'object' ? managed : {}
  const current = new Map(snapshot.entries.map((entry) => [entry.rel, entry.sha]))
  const added = []
  const modified = []
  const deleted = []
  for (const [rel, sha] of current) {
    const old = previous[rel]
    if (!old) added.push(rel)
    else if (old !== sha) modified.push(rel)
  }
  for (const rel of Object.keys(previous)) {
    if (!current.has(rel)) deleted.push(rel)
  }
  added.sort()
  modified.sort()
  deleted.sort()
  return { added, modified, deleted, count: added.length + modified.length + deleted.length }
}
