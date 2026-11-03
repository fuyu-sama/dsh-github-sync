import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverProfile, profileNameFromEntries } from '../lib/profile-dir.js'

async function root(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-profile-dir-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function makeProfile(home, name, manifest) {
  const dir = path.join(home, 'profiles', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest ?? { name: 'dsh-profile-' + name }))
  return dir
}

test('an explicit environment location wins', async (t) => {
  const home = await root(t)
  const dir = await makeProfile(home, 'desktop', {})
  const found = await discoverProfile({ env: { DSH_HOME: home, DSH_PROFILE_DIR: dir, DSH_PROFILE: 'desktop' } })
  assert.equal(found.source, 'env')
  assert.equal(found.dir, path.resolve(dir))
  assert.equal(found.name, 'desktop')
})

test('the Loader entry filename identifies the running profile', async (t) => {
  const home = await root(t)
  await makeProfile(home, 'web', {})
  const desktop = await makeProfile(home, 'desktop', {
    dependencies: { 'dsh-github-sync': 'link:/tmp/x' }
  })
  const entries = [
    { id: 'include', filename: path.join(desktop, 'cordis.yml') },
    { id: 'x', filename: '/elsewhere/node_modules/@deepseek-ai/x/cordis.patch.yml' }
  ]
  const found = await discoverProfile({ env: { DSH_HOME: home }, entries })
  assert.equal(found.source, 'loader')
  assert.equal(found.name, 'desktop')
  assert.equal(found.dir, desktop)
})

test('without Loader entries the profile declaring this package is used', async (t) => {
  const home = await root(t)
  await makeProfile(home, 'web', { dependencies: {} })
  const desktop = await makeProfile(home, 'desktop', {
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-github-sync'] } },
    dependencies: { 'dsh-github-sync': 'link:/tmp/x' }
  })
  const found = await discoverProfile({ env: { DSH_HOME: home } })
  assert.equal(found.source, 'manifest')
  assert.equal(found.name, 'desktop')
  assert.equal(found.dir, desktop)
})

test('an unknown profile location fails loudly instead of guessing', async (t) => {
  const home = await root(t)
  await makeProfile(home, 'web', {})
  await makeProfile(home, 'mobile', {})
  await assert.rejects(() => discoverProfile({ env: { DSH_HOME: home } }), (error) => {
    assert.equal(error.code, 'profile-dir-unknown')
    return true
  })
})

test('entry filenames outside the profiles tree are ignored', () => {
  assert.equal(
    profileNameFromEntries('/home/u/.dsh', [{ filename: '/Applications/DSH/app.asar/dsh/node_modules/x/cordis.patch.yml' }]),
    undefined
  )
  assert.equal(
    profileNameFromEntries('/home/u/.dsh', [
      { filename: '/home/u/.dsh/profiles/desktop/node_modules/dsh-pubmed/cordis.patch.yml' }
    ]),
    'desktop'
  )
})
