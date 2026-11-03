// Host half of dsh-github-sync.
//
// Responsibilities:
//   - register the same-origin JSON routes under /dsh-github-sync (used by the
//     Plugins-page tab; no typert Remote generation is available to a plain-JS
//     bundle)
//   - register the global /dsh-sync human command (global command registrations
//     are merged into every agent's command surface, so this works in every mode)
//   - run the optional startup pull after the app settles
//
// Configuration, not credentials, lives in $DSH_HOME/dsh-github-sync/<profile>/.

import { createSyncEngine } from './lib/sync.js'

export const name = 'dsh-github-sync'
export const inject = ['webServer', 'subprocess', 'commands']

const PREFIX = '/dsh-github-sync'
const API_PREFIX = PREFIX + '/api/'
const MAX_BODY_BYTES = 1024 * 1024
const STARTUP_PULL_DELAY_MS = 15000

export function apply(ctx) {
  const engine = createSyncEngine({
    env: process.env,
    subprocess: ctx.subprocess,
    getPluginManager: () => ctx.get('pluginManager'),
    getAgentPresets: () => ctx.get('agentPresets'),
    getLoaderEntries: () => {
      // The Desktop Host exports no DSH_PROFILE*, so the profile directory is
      // discovered from the Loader's entry file names.
      try {
        const editor = ctx.get('configEditor')
        return editor && typeof editor.entries === 'function' ? editor.entries() : []
      } catch {
        return []
      }
    },
    logger: (line) => {
      try {
        console.log('[dsh-github-sync] ' + line)
      } catch {
        // Console may be unavailable in a packaged window; never fail a sync for it.
      }
    }
  })

  // One operation at a time: concurrent git writes to the same clone would
  // corrupt each other, and the startup pull must not race a user action.
  let tail = Promise.resolve()
  function serialize(operation) {
    const run = tail.then(operation, operation)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        void handleRequest(ctx, engine, serialize, req, res)
      }
    })
  )

  try {
    ctx.effect(() =>
      ctx.commands.register({
        name: 'dsh-sync',
        description: '与 GitHub 仓库同步 DSH 配置、插件、模式与 skill',
        input: { hint: 'status | check | pull | push | config repo=<url> [branch=main] [autopull=on|off]' },
        handler: async ({ rawInput, signal }) => {
          const result = await serialize(() => runCommand(engine, rawInput, signal))
          return { kind: result.ok ? 'success' : 'error', text: commandText(result) }
        }
      })
    )
  } catch (error) {
    console.warn('[dsh-github-sync] 无法注册 /dsh-sync 命令：', error)
  }

  ctx.effect(() => {
    let timer
    let cancelled = false
    const schedule = async () => {
      let config
      try {
        const loaded = await engine.loadConfig()
        config = loaded.config
      } catch {
        return
      }
      if (cancelled || !config.autoPull || !config.repo) return
      timer = setTimeout(() => {
        if (cancelled) return
        void serialize(() => engine.pull({ auto: true })).then((result) => {
          if (!result.ok) {
            console.warn('[dsh-github-sync] 启动自动拉取失败：' + result.error.code + ' ' + result.error.message)
          }
        })
      }, STARTUP_PULL_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }
    void schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  })
}

function commandText(result) {
  if (result.ok) {
    const lines = Array.isArray(result.summary) && result.summary.length > 0 ? result.summary : ['完成']
    return lines.join('\n')
  }
  const error = result.error || { code: 'internal', message: '未知错误' }
  const lines = ['失败（' + error.code + '）：' + error.message]
  if (error.detail) {
    const detail = String(error.detail)
    lines.push(detail.length > 2000 ? detail.slice(0, 2000) + '\n…' : detail)
  }
  return lines.join('\n')
}

function parseConfigArgs(tokens) {
  const patch = {}
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq === -1) {
      if (!('repo' in patch)) patch.repo = token
      continue
    }
    const key = token.slice(0, eq).toLowerCase()
    const value = token.slice(eq + 1)
    if (key === 'repo') patch.repo = value
    else if (key === 'branch') patch.branch = value
    else if (key === 'autopull' || key === 'auto-pull') patch.autoPull = /^(1|on|true|yes)$/i.test(value)
  }
  return patch
}

async function runCommand(engine, rawInput, signal) {
  const text = String(rawInput ?? '').trim()
  const tokens = text.split(/\s+/).filter(Boolean)
  const verb = (tokens[0] || 'status').toLowerCase()
  const rest = tokens.slice(1)
  switch (verb) {
    case 'status':
      return engine.status()
    case 'check':
      return engine.check({ signal })
    case 'pull':
      return engine.pull({ signal })
    case 'push':
      return engine.push({ signal, message: rest.join(' ') })
    case 'test':
      return engine.testConnection()
    case 'config':
      return engine.saveConfig(parseConfigArgs(rest))
    default:
      return {
        ok: false,
        error: {
          code: 'invalid-config',
          message: '未知子命令：' + verb + '（可用：status | check | pull | push | config）'
        },
        summary: ['未知子命令：' + verb]
      }
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function originAllowed(ctx, req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return origin === ctx.webServer.getOrigin()
  } catch {
    return false
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { code: 'invalid-config' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const value = JSON.parse(text)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'invalid-config' }))
        }
        resolve(value)
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'invalid-config' }))
      }
    })
    req.on('error', reject)
  })
}

function requestSignal(req, res) {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  req.on('aborted', () => controller.abort())
  return controller.signal
}

async function handleRequest(ctx, engine, serialize, req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith(API_PREFIX)) {
      return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' }, summary: [] })
    }
    const endpoint = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
    if (req.method === 'GET') {
      if (endpoint === 'status') return sendJson(res, 200, await serialize(() => engine.status()))
      if (endpoint === 'config') {
        const loaded = await engine.loadConfig()
        const config = loaded.config
        return sendJson(res, 200, {
          ok: true,
          data: {
            repo: config.repo,
            branch: config.branch,
            autoPull: config.autoPull,
            installMissingBundles: config.installMissingBundles,
            profileFiles: config.profileFiles,
            skillDirs: config.skillDirs,
            maxFileBytes: config.maxFileBytes
          },
          summary: []
        })
      }
      return sendJson(res, 405, { ok: false, error: { code: 'bad-method', message: '该接口只接受 POST' }, summary: [] })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: { code: 'bad-method', message: '只支持 GET/POST' }, summary: [] })
    }
    if (!originAllowed(ctx, req)) {
      return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '跨站请求被拒绝' }, summary: [] })
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendJson(res, 400, {
        ok: false,
        error: { code: error.code || 'invalid-config', message: error.message },
        summary: [error.message]
      })
    }
    const signal = requestSignal(req, res)
    let result
    switch (endpoint) {
      case 'check':
        result = await serialize(() => engine.check({ signal }))
        break
      case 'pull':
        result = await serialize(() => engine.pull({ signal, dryRun: body.dryRun === true }))
        break
      case 'push':
        result = await serialize(() => engine.push({ signal, message: body.message, force: body.force === true }))
        break
      case 'config': {
        const patch = {}
        for (const key of ['repo', 'branch', 'autoPull', 'installMissingBundles', 'profileFiles', 'skillDirs', 'maxFileBytes']) {
          if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key]
        }
        result = await serialize(() => engine.saveConfig(patch))
        break
      }
      case 'test':
        result = await serialize(() => engine.testConnection())
        break
      default:
        result = { ok: false, error: { code: 'not-found', message: '未知接口：' + endpoint }, summary: [] }
        return sendJson(res, 404, result)
    }
    return sendJson(res, 200, result)
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: { code: 'internal', message: error && error.message ? error.message : String(error) },
      summary: [String(error && error.message ? error.message : error)]
    })
  }
}
