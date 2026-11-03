// Resolve which profile directory the running Host serves.
//
// CLI launches export DSH_PROFILE_DIR (or DSH_PROFILE); the Desktop Host boots an
// application-owned profile and exports neither, so the directory is discovered
// from the live Loader entries and then from the profile manifests.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { dshHome, hasExplicitProfile, profileDir, profileName } from './paths.js'

export const SELF_PACKAGE = 'dsh-github-sync'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function explicitProfile(env) {
  if (!hasExplicitProfile(env)) return undefined
  const dir = profileDir(env)
  const name = profileName(env)
  return { name, dir, source: 'env', candidates: [name], ambiguous: false }
}

function nameFromFilename(home, filename) {
  if (!nonEmpty(filename)) return undefined
  let resolved
  try {
    resolved = path.resolve(filename)
  } catch {
    return undefined
  }
  const prefix = path.join(path.resolve(home), 'profiles') + path.sep
  if (!resolved.startsWith(prefix)) return undefined
  const first = resolved.slice(prefix.length).split(path.sep)[0]
  return first || undefined
}

/**
 * The Loader records the file each entry came from. Any entry whose source lives
 * under `<home>/profiles/<name>/` names the running profile — including a
 * profile-installed bundle's patch inside that profile's node_modules.
 */
export function profileNameFromEntries(home, entries) {
  if (!Array.isArray(entries)) return undefined
  const counts = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const candidates = [
      entry.filename,
      entry.file,
      entry.options && entry.options.filename,
      entry.meta && entry.meta.filename
    ]
    for (const candidate of candidates) {
      const name = nameFromFilename(home, candidate)
      if (name) {
        counts.set(name, (counts.get(name) || 0) + 1)
        break
      }
    }
  }
  let best
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { name, count }
  }
  return best && best.name
}

export async function listProfileNames(home) {
  try {
    const items = await readdir(path.join(home, 'profiles'), { withFileTypes: true })
    return items
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
  } catch {
    return []
  }
}

export async function profileDeclares(home, name) {
  try {
    const text = await readFile(path.join(home, 'profiles', name, 'package.json'), 'utf8')
    const manifest = JSON.parse(text)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
    const bundles =
      manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
        ? manifest.dsh.profile.bundles
        : []
    if (bundles.includes(SELF_PACKAGE)) return true
    const deps = manifest.dependencies
    return Boolean(deps && typeof deps === 'object' && !Array.isArray(deps) && SELF_PACKAGE in deps)
  } catch {
    return false
  }
}

export async function discoverProfile(options = {}) {
  const env = options.env ?? process.env
  const entries = typeof options.entries === 'function' ? options.entries() : options.entries
  const explicit = explicitProfile(env)
  if (explicit) return explicit
  const home = dshHome(env)
  const candidates = await listProfileNames(home)
  const located = (name, source, ambiguous = false) => ({
    name,
    dir: path.join(home, 'profiles', name),
    source,
    candidates,
    ambiguous
  })
  const fromEntries = profileNameFromEntries(home, entries)
  if (fromEntries) return located(fromEntries, 'loader')
  const declared = []
  for (const name of candidates) {
    if (await profileDeclares(home, name)) declared.push(name)
  }
  if (declared.length === 1) return located(declared[0], 'manifest')
  if (declared.includes('desktop')) return located('desktop', 'manifest-preferred', declared.length > 1)
  if (candidates.length === 1) return located(candidates[0], 'only-profile')
  const error = new Error(
    '无法确定当前 DSH profile 目录：请设置 DSH_PROFILE_DIR 或在某个 profile 中安装本插件后重试'
  )
  error.code = 'profile-dir-unknown'
  error.detail = candidates.length > 0 ? '候选 profile：' + candidates.join(', ') : '没有找到任何 profile'
  throw error
}
