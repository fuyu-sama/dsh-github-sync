import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sha256 } from '../lib/paths.js'
import { applyRepoTree, normalizeConfig } from '../lib/snapshot.js'
import { scanText } from '../lib/secret-scan.js'
import { createSyncEngine } from '../lib/sync.js'
import { createLocalSubprocess } from './fake-subprocess.mjs'

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

const PATCH = '- id: row-a\n  name: demo\n'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function makeRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-github-sync-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function makeRemote(root) {
  const remote = path.join(root, 'remote.git')
  await mkdir(remote, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'pipe' })
  return remote
}

async function makeMachine(root, name) {
  const base = path.join(root, name)
  const home = path.join(base, 'home')
  const profile = path.join(home, 'profiles', 'test')
  const skillDir = path.join(home, 'skills')
  await mkdir(profile, { recursive: true })
  await mkdir(path.join(skillDir, 'alpha-skill'), { recursive: true })
  await writeFile(path.join(profile, 'cordis.patch.yml'), PATCH)
  await writeFile(
    path.join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-test',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-github-sync'] } },
        dependencies: {
          'dsh-github-sync': 'link:' + path.join(root, 'dsh-github-sync'),
          'dsh-science-workbench': 'github:poplarity/dsh-science-workbench'
        }
      },
      null,
      2
    ) + '\n'
  )
  await writeFile(
    path.join(skillDir, 'alpha-skill', 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: A test skill\n---\nbody\n'
  )
  const env = {
    DSH_HOME: home,
    DSH_PROFILE: 'test',
    DSH_PROFILE_DIR: profile,
    HOME: process.env.HOME,
    PATH: process.env.PATH
  }
  const engine = createSyncEngine({ env, subprocess: createLocalSubprocess() })
  return { base, home, profile, skillDir, env, engine }
}

async function configure(machine, remote, extra) {
  const result = await machine.engine.saveConfig({ repo: remote, branch: 'main', ...extra })
  assert.equal(result.ok, true, JSON.stringify(result))
}

test('push then pull round-trips config and skills, and sanitizes machine-local manifest entries', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  const b = await makeMachine(root, 'b')
  await configure(a, remote)
  await configure(b, remote)

  const pushed = await a.engine.push({ message: 'init' })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))

  const inspection = path.join(root, 'inspection')
  git(root, ['clone', remote, inspection])
  const synced = JSON.parse(await readFile(path.join(inspection, 'profile', 'package.json'), 'utf8'))
  assert.equal(synced.dependencies['dsh-github-sync'], undefined)
  assert.equal(synced.dependencies['dsh-science-workbench'], 'github:poplarity/dsh-science-workbench')
  assert.deepEqual(synced.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  const meta = JSON.parse(await readFile(path.join(inspection, 'dsh-sync.json'), 'utf8'))
  assert.equal(meta.schemaVersion, 1)
  assert.ok(pushed.data.strippedDeps.some((entry) => entry.name === 'dsh-github-sync'))
  assert.equal(await readFile(path.join(inspection, 'profile', 'cordis.patch.yml'), 'utf8'), PATCH)
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'alpha-skill', 'SKILL.md')), true)

  const pulled = await b.engine.pull({})
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.equal(await readFile(path.join(b.profile, 'cordis.patch.yml'), 'utf8'), PATCH)
  assert.equal(
    await readFile(path.join(b.skillDir, 'alpha-skill', 'SKILL.md'), 'utf8'),
    '---\nname: alpha-skill\ndescription: A test skill\n---\nbody\n'
  )
})

test('a deletion on one machine propagates, and drift reports local edits', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  const b = await makeMachine(root, 'b')
  await configure(a, remote)
  await configure(b, remote)
  assert.equal((await a.engine.push({})).ok, true)
  assert.equal((await b.engine.pull({})).ok, true)
  assert.equal(await exists(path.join(b.skillDir, 'alpha-skill', 'SKILL.md')), true)

  await rm(path.join(a.skillDir, 'alpha-skill'), { recursive: true, force: true })
  const second = await a.engine.push({})
  assert.equal(second.ok, true, JSON.stringify(second))
  const pulled = await b.engine.pull({})
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.equal(await exists(path.join(b.skillDir, 'alpha-skill')), false)

  await writeFile(path.join(b.profile, 'cordis.patch.yml'), '- id: row-b\n  name: changed\n')
  const status = await b.engine.status()
  assert.equal(status.ok, true)
  assert.ok(status.data.drift.modified.includes('profile/cordis.patch.yml'), JSON.stringify(status.data.drift))
})

test('a conflicting pull aborts, reports the files and leaves local content untouched', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  const b = await makeMachine(root, 'b')
  await configure(a, remote)
  await configure(b, remote)
  assert.equal((await a.engine.push({})).ok, true)
  assert.equal((await b.engine.pull({})).ok, true)

  await writeFile(path.join(a.profile, 'cordis.patch.yml'), '- id: from-a\n  name: a\n')
  assert.equal((await a.engine.push({})).ok, true)
  await writeFile(path.join(b.profile, 'cordis.patch.yml'), '- id: from-b\n  name: b\n')

  const pulled = await b.engine.pull({})
  assert.equal(pulled.ok, false)
  assert.equal(pulled.error.code, 'merge-conflict')
  assert.ok(pulled.error.detail.includes('profile/cordis.patch.yml'), pulled.error.detail)
  assert.equal(await readFile(path.join(b.profile, 'cordis.patch.yml'), 'utf8'), '- id: from-b\n  name: b\n')
  assert.equal(await exists(path.join(b.home, 'dsh-github-sync', 'test', 'repo', '.git', 'rebase-merge')), false)
})

test('concurrent non-conflicting edits merge on pull', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  const b = await makeMachine(root, 'b')
  await configure(a, remote)
  await configure(b, remote)
  assert.equal((await a.engine.push({})).ok, true)
  assert.equal((await b.engine.pull({})).ok, true)

  await writeFile(
    path.join(a.skillDir, 'alpha-skill', 'SKILL.md'),
    '---\nname: alpha-skill\ndescription: edited by A\n---\nbody A\n'
  )
  assert.equal((await a.engine.push({})).ok, true)

  await mkdir(path.join(b.skillDir, 'beta-skill'), { recursive: true })
  await writeFile(
    path.join(b.skillDir, 'beta-skill', 'SKILL.md'),
    '---\nname: beta-skill\ndescription: added by B\n---\nbody B\n'
  )
  const pulled = await b.engine.pull({})
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.ok(
    (await readFile(path.join(b.skillDir, 'alpha-skill', 'SKILL.md'), 'utf8')).includes('edited by A')
  )
  assert.equal(await exists(path.join(b.skillDir, 'beta-skill', 'SKILL.md')), true)
  const changed = [...pulled.data.applied.added, ...pulled.data.applied.modified]
  assert.ok(changed.includes('skills/user/alpha-skill/SKILL.md'), JSON.stringify(pulled.data.applied))
  assert.ok(!pulled.data.applied.deleted.includes('skills/user/beta-skill/SKILL.md'))
})

test('a push refuses a detected credential unless forced', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  await configure(a, remote)
  await mkdir(path.join(a.skillDir, 'leak-skill'), { recursive: true })
  await writeFile(
    path.join(a.skillDir, 'leak-skill', 'SKILL.md'),
    '---\nname: leak-skill\ndescription: leak\n---\ntoken ghp_' + 'a'.repeat(36) + '\n'
  )
  const refused = await a.engine.push({})
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'secret-detected')
  const inspection = path.join(root, 'inspection')
  git(root, ['clone', remote, inspection])
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'leak-skill')), false)

  const forced = await a.engine.push({ force: true })
  assert.equal(forced.ok, true, JSON.stringify(forced))
  const inspection2 = path.join(root, 'inspection2')
  git(root, ['clone', remote, inspection2])
  assert.equal(await exists(path.join(inspection2, 'skills', 'user', 'leak-skill', 'SKILL.md')), true)
})

test('credential files, dotfiles, node_modules and key files are never collected', async (t) => {
  if (!HAS_GIT) return t.skip('git is not installed')
  const root = await makeRoot(t)
  const remote = await makeRemote(root)
  const a = await makeMachine(root, 'a')
  await configure(a, remote)
  const skill = path.join(a.skillDir, 'alpha-skill')
  await writeFile(path.join(skill, '.env'), 'GITHUB_TOKEN=x\n')
  await writeFile(path.join(skill, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n')
  await mkdir(path.join(skill, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(skill, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const pushed = await a.engine.push({})
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  const inspection = path.join(root, 'inspection')
  git(root, ['clone', remote, inspection])
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'alpha-skill', '.env')), false)
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'alpha-skill', 'server.pem')), false)
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'alpha-skill', 'node_modules')), false)
  assert.equal(await exists(path.join(inspection, 'skills', 'user', 'alpha-skill', 'SKILL.md')), true)
})

test('applying a pulled tree backs up overwritten and deleted local files', async (t) => {
  const root = await makeRoot(t)
  const home = path.join(root, 'home')
  const profile = path.join(home, 'profiles', 'test')
  const skillDir = path.join(home, 'skills')
  await mkdir(profile, { recursive: true })
  await mkdir(path.join(skillDir, 'old-skill'), { recursive: true })
  await writeFile(path.join(profile, 'cordis.patch.yml'), 'old\n')
  await writeFile(path.join(skillDir, 'old-skill', 'SKILL.md'), 'old skill\n')
  const env = { DSH_HOME: home, DSH_PROFILE: 'test', DSH_PROFILE_DIR: profile, HOME: process.env.HOME, PATH: process.env.PATH }
  const config = normalizeConfig({ repo: 'file:///tmp/example.git', skillDirs: { user: skillDir } }, env)
  const managed = {
    'profile/cordis.patch.yml': sha256(Buffer.from('old\n')),
    'skills/user/old-skill/SKILL.md': sha256(Buffer.from('old skill\n'))
  }
  const tree = {
    entries: new Map([
      ['profile/cordis.patch.yml', { rel: 'profile/cordis.patch.yml', data: Buffer.from('new\n'), sha: sha256(Buffer.from('new\n')) }]
    ])
  }
  const applied = await applyRepoTree(path.join(root, 'unused-clone'), tree, config, managed, { stamp: 'test-stamp' })
  assert.deepEqual(applied.modified, ['profile/cordis.patch.yml'])
  assert.deepEqual(applied.deleted, ['skills/user/old-skill/SKILL.md'])
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), 'new\n')
  assert.equal(await exists(path.join(skillDir, 'old-skill', 'SKILL.md')), false)
  assert.ok(applied.backupDir)
  assert.equal(await readFile(path.join(applied.backupDir, 'profile', 'cordis.patch.yml'), 'utf8'), 'old\n')
  assert.equal(
    await readFile(path.join(applied.backupDir, 'skills', 'user', 'old-skill', 'SKILL.md'), 'utf8'),
    'old skill\n'
  )
  assert.equal(await exists(path.join(profile, 'package.json')), false)
})

test('secret scanning reports rule and line', () => {
  const matches = scanText('line one\nkey = "sk-' + 'b'.repeat(24) + '"\n', 'profile/cordis.patch.yml')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].rule, 'api-key')
  assert.equal(matches[0].line, 2)
  assert.equal(scanText('nothing here', 'x.txt').length, 0)
})
