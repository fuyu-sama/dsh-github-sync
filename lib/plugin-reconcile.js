// Bundle reconciliation after a pull.
//
// A pulled snapshot declares which profile bundles it expects. This module
// installs missing bundles through the Plugin Manager service (the only
// supported writer of a profile's package manifest) and enables or disables
// existing selections. It never removes packages and never touches bundles
// whose dependency spec is machine-local (`link:` / `file:`), because those
// cannot exist on another machine.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SELF_BUNDLE, isLocalSpec } from './snapshot.js'

export const DEFAULT_MAX_INSTALLS = 10

export function parseManifestEntry(entry) {
  if (!entry || !entry.data) return undefined
  try {
    const value = JSON.parse(entry.data.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function readLocalManifest(profileDir) {
  try {
    const text = await readFile(path.join(profileDir, 'package.json'), 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function manifestsFrom(manifest) {
  if (!manifest || typeof manifest !== 'object') return { bundles: [], deps: {} }
  const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : []
  const deps = manifest.dependencies && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies)
    ? manifest.dependencies
    : {}
  return { bundles, deps }
}

function infoName(info) {
  if (!info || typeof info !== 'object') return undefined
  return info.name || info.id || info.package || info.bundle
}

function infoEnabled(info) {
  if (!info || typeof info !== 'object') return undefined
  if (typeof info.enabled === 'boolean') return info.enabled
  return undefined
}

function describeChange(result) {
  if (!result || typeof result !== 'object') return { application: undefined, warnings: [] }
  const warnings = Array.isArray(result.warnings) ? result.warnings : []
  return { application: result.application, warnings }
}

/**
 * @returns {Promise<{installed: string[], enabled: string[], disabled: string[], skipped: Array<{name:string,reason:string}>, failed: Array<{name:string,message:string}>, pending: string[]}>}
 */
export async function reconcileBundles(options) {
  const {
    pluginManager,
    snapshotManifest,
    localManifest,
    install = true,
    protectedNames = [],
    maxInstalls = DEFAULT_MAX_INSTALLS
  } = options
  const result = { installed: [], enabled: [], disabled: [], skipped: [], failed: [], pending: [] }
  const desired = manifestsFrom(snapshotManifest)
  const local = manifestsFrom(localManifest)
  const protectedSet = new Set([SELF_BUNDLE, ...protectedNames])

  if (!pluginManager) {
    result.failed.push({ name: '*', message: 'pluginManager 服务不可用，未对账插件' })
    return result
  }

  let bundleInfo
  try {
    bundleInfo = await pluginManager.listBundles()
  } catch {
    bundleInfo = undefined
  }
  const infoByName = new Map()
  if (Array.isArray(bundleInfo)) {
    for (const info of bundleInfo) {
      const name = infoName(info)
      if (name) infoByName.set(name, info)
    }
  }
  const enabledState = (name) => {
    const info = infoByName.get(name)
    const state = infoEnabled(info)
    if (state !== undefined) return state
    return local.bundles.includes(name)
  }

  const wanted = desired.bundles.filter((name) => !protectedSet.has(name))

  let installCount = 0
  for (const name of wanted) {
    if (local.bundles.includes(name)) {
      if (enabledState(name) === false) {
        try {
          await pluginManager.setBundleEnabled(name, true)
          result.enabled.push(name)
        } catch (error) {
          result.failed.push({ name, message: error && error.message ? error.message : String(error) })
        }
      }
      continue
    }
    const spec = desired.deps[name]
    if (spec !== undefined && isLocalSpec(spec)) {
      result.skipped.push({ name, reason: '本机路径依赖（' + String(spec) + '），需手动安装' })
      continue
    }
    if (spec === undefined) {
      // A bundle the installation ships; enabling it needs no package install.
      try {
        await pluginManager.setBundleEnabled(name, true)
        result.enabled.push(name)
      } catch (error) {
        result.skipped.push({ name, reason: '安装版 bundle 无法启用：' + (error && error.message ? error.message : String(error)) })
      }
      continue
    }
    if (!install) {
      result.pending.push(name)
      continue
    }
    if (installCount >= maxInstalls) {
      result.pending.push(name)
      continue
    }
    installCount += 1
    try {
      const change = await pluginManager.installBundle(spec, { enabled: true })
      const summary = describeChange(change)
      if (summary.application === 'failed' || (change && change.error)) {
        result.failed.push({
          name,
          message: summary.application === 'failed' ? '安装后激活失败' : String(change && change.error)
        })
      } else {
        result.installed.push(name)
      }
    } catch (error) {
      result.failed.push({ name, message: error && error.message ? error.message : String(error) })
    }
  }

  for (const name of local.bundles) {
    if (protectedSet.has(name)) continue
    if (wanted.includes(name)) continue
    const dep = local.deps[name]
    if (dep !== undefined && isLocalSpec(dep)) {
      result.skipped.push({ name, reason: '本机路径依赖，保持现状' })
      continue
    }
    if (enabledState(name) === false) continue
    try {
      await pluginManager.setBundleEnabled(name, false)
      result.disabled.push(name)
    } catch (error) {
      result.failed.push({ name, message: error && error.message ? error.message : String(error) })
    }
  }

  return result
}
