// sync.mjs against a scratch shared source (the real sync.mjs and core module, and a
// made-up module) and a scratch target repo
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REAL = path.join(HERE, '..')
const SLOW = { timeout: 60_000 }

let tmp, source, target

const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
}
const inTarget = file => path.join(target, file)
const read = file => fs.readFileSync(inTarget(file), 'utf8')
const lock = () => JSON.parse(read('shared.lock.json'))
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex')
const setConfig = config => write(inTarget('shared.json'), JSON.stringify(config, null, 2) + '\n')
const setModules = modules => setConfig({ modules })
const demoFile = (file, text) => write(path.join(source, 'modules', 'demo', 'files', file), text)
const demoFiles = files => write(path.join(source, 'modules', 'demo', 'module.json'), JSON.stringify({ files }))

function sync(...args) {
    const r = spawnSync(process.execPath, [path.join(source, 'sync.mjs'), ...args], { cwd: tmp, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
}

// The target's own copy of the core test, run as the target's yarn test would
function coreTest() {
    const r = spawnSync(path.join(REAL, 'node_modules', '.bin', 'vitest'), ['run', 'scripts/shared-files.test.mjs'], {
        cwd: target,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    })
    return { code: r.status, out: r.stdout + r.stderr }
}

// The node:test form of it, run as a target tested with node --test runs it
function nodeCoreTest() {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/*.test.mjs'], { cwd: target, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'))
    source = path.join(tmp, 'source')
    target = path.join(tmp, 'target')
    fs.mkdirSync(source)
    fs.copyFileSync(path.join(REAL, 'sync.mjs'), path.join(source, 'sync.mjs'))
    fs.cpSync(path.join(REAL, 'modules', 'core'), path.join(source, 'modules', 'core'), { recursive: true })
    demoFile('scripts/demo/one.mjs', 'export const one = 1\n')
    demoFile('scripts/demo/two.mjs', 'export const two = 2\n')
    demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs'])
    write(path.join(source, 'targets.json'), JSON.stringify({ targets: ['../target'] }))
    setModules({ demo: { some: 'setting' } })
    write(inTarget('src/own.ts'), 'export const own = 1\n')
    // The core test's vitest, found walking up from the target
    fs.symlinkSync(path.join(REAL, 'node_modules'), path.join(target, 'node_modules'))
})

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
})

describe('sync.mjs', () => {
    it("writes each module's files, core's test and the lock, and --check then finds nothing to do", SLOW, () => {
        expect(sync('--check').code).toBe(1)
        const first = sync()
        expect(first.code).toBe(0)
        expect(first.out).toContain('add      scripts/demo/one.mjs')
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 1\n')
        expect(read('scripts/shared-files.test.mjs')).toBe(fs.readFileSync(path.join(REAL, 'modules', 'core', 'files', 'scripts', 'shared-files.test.mjs'), 'utf8'))
        expect(lock().modules).toEqual({
            core: { 'scripts/shared-files.test.mjs': expect.stringMatching(/^[0-9a-f]{64}$/) },
            demo: { 'scripts/demo/one.mjs': sha256('export const one = 1\n'), 'scripts/demo/two.mjs': sha256('export const two = 2\n') },
        })
        // The targets' own files are theirs
        expect(read('src/own.ts')).toBe('export const own = 1\n')

        const check = sync('--check')
        expect(check.code).toBe(0)
        expect(check.out).toContain('in sync (core, demo)')
        expect(coreTest().code).toBe(0)
    })

    it('updates the copies after a change to the shared source, which --check reports first', SLOW, () => {
        sync()
        demoFile('scripts/demo/one.mjs', 'export const one = 11\n')
        const check = sync('--check')
        expect(check.code).toBe(1)
        expect(check.out).toContain('update   scripts/demo/one.mjs')
        expect(check.out).toContain('lock     shared.lock.json')
        const diff = sync('--diff')
        expect(diff.code).toBe(1)
        expect(diff.out).toContain('+export const one = 11')
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 1\n')

        expect(sync().code).toBe(0)
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 11\n')
        expect(sync('--check').code).toBe(0)
    })

    it("fails the target's core test and --check when a copy is edited there, and won't overwrite it without --force", SLOW, () => {
        sync()
        write(inTarget('scripts/demo/one.mjs'), 'export const one = 2 // a fix made here\n')
        const test = coreTest()
        expect(test.code).toBe(1)
        expect(test.out).toContain('scripts/demo/one.mjs')
        expect(test.out).toContain('Make the change in the shared source and sync it instead')

        const check = sync('--check')
        expect(check.code).toBe(1)
        expect(check.out).toContain('scripts/demo/one.mjs  (edited there since the last sync)')
        const refused = sync()
        expect(refused.code).toBe(1)
        expect(refused.out).toContain('not synced')
        expect(read('scripts/demo/one.mjs')).toContain('a fix made here')

        expect(sync('--force').code).toBe(0)
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 1\n')
        expect(coreTest().code).toBe(0)
    })

    it('fails the core test when a synced file is deleted, or shared.json takes a module the last sync left out', SLOW, () => {
        sync()
        fs.rmSync(inTarget('scripts/demo/two.mjs'))
        const deleted = coreTest()
        expect(deleted.code).toBe(1)
        expect(deleted.out).toContain('scripts/demo/two.mjs (missing)')
        expect(sync().code).toBe(0)

        fs.cpSync(path.join(source, 'modules', 'demo'), path.join(source, 'modules', 'other'), { recursive: true })
        fs.rmSync(path.join(source, 'modules', 'other', 'files'), { recursive: true })
        write(path.join(source, 'modules', 'other', 'files', 'scripts', 'other.mjs'), 'export const other = 1\n')
        write(path.join(source, 'modules', 'other', 'module.json'), JSON.stringify({ files: ['scripts/other.mjs'] }))
        setModules({ demo: {}, other: {} })
        const added = coreTest()
        expect(added.code).toBe(1)
        expect(added.out).toContain('shared.json changed since the last sync')
        expect(sync().code).toBe(0)
        expect(read('scripts/other.mjs')).toBe('export const other = 1\n')
        expect(coreTest().code).toBe(0)
    })

    it('removes a file the module no longer has, with the folder that leaves empty', SLOW, () => {
        demoFile('scripts/old/gone.mjs', 'export const gone = 1\n')
        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs', 'scripts/old/gone.mjs'])
        sync()
        expect(fs.existsSync(inTarget('scripts/old/gone.mjs'))).toBe(true)

        fs.rmSync(path.join(source, 'modules', 'demo', 'files', 'scripts', 'old'), { recursive: true })
        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs'])
        expect(sync('--check').out).toContain('remove   scripts/old/gone.mjs')
        expect(sync().code).toBe(0)
        expect(fs.existsSync(inTarget('scripts/old'))).toBe(false)
        expect(Object.keys(lock().modules.demo)).toEqual(['scripts/demo/one.mjs', 'scripts/demo/two.mjs'])
    })

    it("replaces a target's own file at a module's path only with --force", SLOW, () => {
        write(inTarget('scripts/demo/one.mjs'), 'export const one = "the old hand-made copy"\n')
        const refused = sync()
        expect(refused.code).toBe(1)
        expect(refused.out).toContain("scripts/demo/one.mjs  (there before, and the sync didn't write it)")
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(false)

        expect(sync('--force').code).toBe(0)
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 1\n')
    })

    it('refuses a module that lists a file it lacks, has a file it doesn\'t list, or claims a path another has', SLOW, () => {
        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs', 'scripts/demo/three.mjs'])
        expect(sync().out).toContain("lists scripts/demo/three.mjs, which isn't in its files folder")

        demoFiles(['scripts/demo/one.mjs'])
        expect(sync().out).toContain("files folder has files module.json doesn't list: scripts/demo/two.mjs")

        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs', '../outside.mjs'])
        expect(sync().out).toContain("isn't a plain path inside a repo")

        demoFile('scripts/shared-files.test.mjs', '// a copy\n')
        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs', 'scripts/shared-files.test.mjs'])
        expect(sync().out).toContain('scripts/shared-files.test.mjs is in both core and demo')
        // Finder's files are left alone
        fs.rmSync(path.join(source, 'modules', 'demo', 'files', 'scripts', 'shared-files.test.mjs'))
        demoFiles(['scripts/demo/one.mjs', 'scripts/demo/two.mjs'])
        demoFile('scripts/.DS_Store', 'finder\n')
        expect(sync().code).toBe(0)
        expect(fs.existsSync(inTarget('scripts/.DS_Store'))).toBe(false)
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(true)
    })

    it("refuses a target without shared.json, or one that names core or a module there isn't", SLOW, () => {
        fs.rmSync(inTarget('shared.json'))
        expect(sync().out).toContain('has no shared.json')
        setModules({ core: {}, demo: {} })
        expect(sync().out).toContain('names core, which every repo gets')
        setModules({ nonesuch: {} })
        expect(sync().out).toContain('There\'s no module "nonesuch"')
        expect(sync().code).toBe(1)
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(false)
    })

    it('takes the targets named on the command line instead of targets.json', SLOW, () => {
        const other = path.join(tmp, 'other')
        write(path.join(other, 'shared.json'), JSON.stringify({ modules: { demo: {} } }))
        const r = sync('other')
        expect(r.code).toBe(0)
        expect(fs.existsSync(path.join(other, 'scripts', 'demo', 'one.mjs'))).toBe(true)
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(false)
    })

    it('stops on an option it doesn\'t know', SLOW, () => {
        expect(sync('--chek').code).toBe(2)
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(false)
    })
})

describe('sync.mjs for a target tested with node --test', () => {
    const NODE_CORE = 'test/shared-files.test.mjs'
    const VITEST_CORE = 'scripts/shared-files.test.mjs'

    it("gives it core's node:test form, which fails when a synced file is edited, deleted, or shared.json changes", SLOW, () => {
        setConfig({ testRunner: 'node', modules: { demo: {} } })
        expect(sync().code).toBe(0)
        expect(read(NODE_CORE)).toBe(fs.readFileSync(path.join(REAL, 'modules', 'core', 'files', NODE_CORE), 'utf8'))
        expect(fs.existsSync(inTarget(VITEST_CORE))).toBe(false)
        expect(Object.keys(lock().modules.core)).toEqual([NODE_CORE])
        expect(sync('--check').code).toBe(0)
        const clean = nodeCoreTest()
        expect(clean.code, clean.out).toBe(0)
        expect(clean.out).toMatch(/# pass 2\b/)

        write(inTarget('scripts/demo/one.mjs'), 'export const one = 2 // a fix made here\n')
        const edited = nodeCoreTest()
        expect(edited.code).toBe(1)
        expect(edited.out).toContain('These shared files were changed here: scripts/demo/one.mjs.')
        expect(edited.out).toContain('Make the change in the shared source and sync it instead')
        expect(sync('--force').code).toBe(0)

        fs.rmSync(inTarget('scripts/demo/two.mjs'))
        expect(nodeCoreTest().out).toContain('scripts/demo/two.mjs (missing)')
        expect(sync().code).toBe(0)

        fs.cpSync(path.join(source, 'modules', 'demo'), path.join(source, 'modules', 'other'), { recursive: true })
        setConfig({ testRunner: 'node', modules: { demo: {}, other: {} } })
        const added = nodeCoreTest()
        expect(added.code).toBe(1)
        expect(added.out).toContain('shared.json changed since the last sync')
    })

    it("moves core's test when a target changes runner", SLOW, () => {
        expect(sync().code).toBe(0)
        expect(fs.existsSync(inTarget(VITEST_CORE))).toBe(true)
        setConfig({ testRunner: 'node', modules: { demo: {} } })
        const check = sync('--check')
        expect(check.code).toBe(1)
        expect(check.out).toContain(`add      ${NODE_CORE}`)
        expect(check.out).toContain(`remove   ${VITEST_CORE}`)
        expect(sync().code).toBe(0)
        expect(fs.existsSync(inTarget(VITEST_CORE))).toBe(false)
        expect(read('scripts/demo/one.mjs')).toBe('export const one = 1\n')
        expect(nodeCoreTest().code).toBe(0)

        setConfig({ testRunner: 'vitest', modules: { demo: {} } })
        expect(sync().code).toBe(0)
        expect(fs.existsSync(inTarget(NODE_CORE))).toBe(false)
        expect(fs.existsSync(inTarget('test'))).toBe(false)
        expect(coreTest().code).toBe(0)
    })

    it("syncs a module's tests for the target's runner, and refuses a module with none for it", SLOW, () => {
        demoFile('scripts/demo/one.test.mjs', '// vitest\n')
        demoFile('test/demo.test.mjs', '// node:test\n')
        write(
            path.join(source, 'modules', 'demo', 'module.json'),
            JSON.stringify({ files: ['scripts/demo/one.mjs', 'scripts/demo/two.mjs'], tests: { vitest: ['scripts/demo/one.test.mjs'], node: ['test/demo.test.mjs'] } }),
        )
        setConfig({ testRunner: 'node', modules: { demo: {} } })
        expect(sync().code).toBe(0)
        expect(Object.keys(lock().modules.demo)).toEqual(['scripts/demo/one.mjs', 'scripts/demo/two.mjs', 'test/demo.test.mjs'])
        expect(fs.existsSync(inTarget('scripts/demo/one.test.mjs'))).toBe(false)

        write(path.join(source, 'modules', 'demo', 'module.json'), JSON.stringify({ files: ['scripts/demo/one.mjs', 'scripts/demo/two.mjs'], tests: { vitest: ['scripts/demo/one.test.mjs'] } }))
        fs.rmSync(path.join(source, 'modules', 'demo', 'files', 'test'), { recursive: true })
        const refused = sync('--check')
        expect(refused.code).toBe(1)
        expect(refused.out).toContain("Module demo has tests for vitest only, and this repo tests with node (shared.json's testRunner).")

        setConfig({ modules: { demo: {} } })
        expect(sync().code).toBe(0)
        expect(read('scripts/demo/one.test.mjs')).toBe('// vitest\n')
    })

    it('refuses a test runner it doesn\'t know, a setting it doesn\'t know, and tests that aren\'t lists', SLOW, () => {
        setConfig({ testRunner: 'jest', modules: { demo: {} } })
        expect(sync().out).toContain('names testRunner "jest": it\'s vitest (the default) or node')
        setConfig({ testrunner: 'node', modules: { demo: {} } })
        expect(sync().out).toContain("has testrunner, which the sync doesn't know: it takes modules and testRunner")
        setConfig({ modules: { demo: {} } })
        write(path.join(source, 'modules', 'demo', 'module.json'), JSON.stringify({ files: ['scripts/demo/one.mjs', 'scripts/demo/two.mjs'], tests: ['scripts/demo/one.mjs'] }))
        expect(sync().out).toContain("Module demo's tests must map test runners (vitest, node) to lists of files.")
        write(path.join(source, 'modules', 'demo', 'module.json'), JSON.stringify({ files: ['scripts/demo/one.mjs', 'scripts/demo/two.mjs'], tests: { vitest: ['scripts/demo/two.mjs'] } }))
        expect(sync().out).toContain('Module demo lists scripts/demo/two.mjs twice.')
        expect(sync().code).toBe(1)
        expect(fs.existsSync(inTarget('shared.lock.json'))).toBe(false)
    })
})
