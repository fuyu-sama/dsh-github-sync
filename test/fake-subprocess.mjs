// Test-only local implementation of the Host `subprocess` seam.
//
// The engine talks to git through ctx.subprocess in production; the tests need
// the same interface without booting Cordis.

import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'

export function createLocalSubprocess() {
  return {
    async resolveExecutable(command, env) {
      const pathValue = (env && env.PATH) || process.env.PATH || ''
      for (const dir of pathValue.split(path.delimiter)) {
        if (!dir) continue
        const candidate = path.join(dir, command)
        try {
          await access(candidate)
          const info = await stat(candidate)
          if (info.isFile()) return candidate
        } catch {
          // Try the next PATH entry.
        }
      }
      throw new Error('executable not found: ' + command)
    },

    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdoutChunks = []
      const stderrChunks = []
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
      let terminated = false
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (exitCode, signal) => {
          resolve({ exitCode, signal: signal || null })
        })
      })
      const onAbort = () => {
        terminated = true
        try {
          child.kill('SIGTERM')
        } catch {
          // Already exited.
        }
      }
      if (spec.signal) {
        if (spec.signal.aborted) onAbort()
        else spec.signal.addEventListener('abort', onAbort, { once: true })
      }
      const reader = (chunks) => ({
        readFrom() {
          return { text: Buffer.concat(chunks).toString('utf8'), nextOffset: 0, lossy: false }
        }
      })
      return {
        stdin: undefined,
        stdout: null,
        stderr: null,
        control: undefined,
        collected: { stdout: reader(stdoutChunks), stderr: reader(stderrChunks) },
        done,
        terminate: onAbort,
        waitForExit: () => done.then(() => true),
        get terminated() {
          return terminated
        }
      }
    }
  }
}
