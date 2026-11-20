// Syncs the shared modules into the repos that take them, and checks them.
//
//   node sync.mjs [target ...]          write each target's shared files and its shared.lock.json
//   node sync.mjs --check [target ...]  write nothing; exit 1 when a target's copies differ
//   node sync.mjs --diff [target ...]   like --check, and print each difference
//   --force                             also overwrite (or remove) a target's file that the
//                                       sync didn't write as it is now: one edited there since
//                                       the last sync, or one that was there before the first
//
// Targets default to the ones targets.json lists (paths from this folder). A
// target's shared.json names the modules it takes, with their settings, as
// {"modules": {"publish": {...}}}. Every target also gets core, the test that
// fails when a synced file is edited there. Each module is a folder in modules/:
// module.json lists its files, kept under files/ at the paths they get in a
// target. The sync never commits: review the change and commit it in each target.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = 'shared.json'
const LOCK = 'shared.lock.json'
const LOCK_ABOUT =
    "Written by the sync from the shared source: each file it syncs into this repo, with its sha256. Change those files in the shared source, not here; a test fails when one is edited here."
const SKIPPED_NAMES = new Set(['.DS_Store'])

class SyncError extends Error {}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const isExecutable = mode => (mode & 0o111) !== 0

// Every file under `dir`, as posix paths relative to it
function walk(dir, prefix = '') {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIPPED_NAMES.has(entry.name)) continue
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
        else out.push(rel)
    }
    return out
}

// A module's files, from its module.json, which must list every file under files/
function loadModule(name) {
    const dir = path.join(HERE, 'modules', name)
    if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(path.join(dir, 'module.json'))) {
        throw new SyncError(`There's no module "${name}" in ${path.join(HERE, 'modules')}.`)
    }
    const files = readJson(path.join(dir, 'module.json')).files || []
    for (const file of files) {
        if (file !== path.posix.normalize(file) || file.startsWith('../') || path.isAbsolute(file)) {
            throw new SyncError(`Module ${name} lists "${file}", which isn't a plain path inside a repo.`)
        }
        if ([CONFIG, LOCK].includes(file)) throw new SyncError(`Module ${name} can't sync ${file}: each repo keeps its own.`)
        if (!fs.existsSync(path.join(dir, 'files', file))) throw new SyncError(`Module ${name} lists ${file}, which isn't in its files folder.`)
    }
    const unlisted = walk(path.join(dir, 'files')).filter(file => !files.includes(file))
    if (unlisted.length) throw new SyncError(`Module ${name}'s files folder has files module.json doesn't list: ${unlisted.join(', ')}.`)
    return files.map(file => {
        const from = path.join(dir, 'files', file)
        const bytes = fs.readFileSync(from)
        return { module: name, file, bytes, hash: sha256(bytes), mode: fs.statSync(from).mode & 0o777 }
    })
}

// What a sync of `target` would change, without changing anything
function planTarget(target) {
    if (!fs.existsSync(path.join(target, CONFIG))) throw new SyncError(`${target} has no ${CONFIG}, which names the modules it takes.`)
    const modules = readJson(path.join(target, CONFIG)).modules || {}
    if ('core' in modules) throw new SyncError(`${target}'s ${CONFIG} names core, which every repo gets: leave it out.`)
    const names = ['core', ...Object.keys(modules)]

    const wanted = new Map()
    for (const name of names) {
        for (const entry of loadModule(name)) {
            if (wanted.has(entry.file)) throw new SyncError(`${entry.file} is in both ${wanted.get(entry.file).module} and ${name}.`)
            wanted.set(entry.file, entry)
        }
    }

    const lockPath = path.join(target, LOCK)
    const oldLock = fs.existsSync(lockPath) ? readJson(lockPath) : { modules: {} }
    // What the last sync wrote, by path
    const synced = new Map(Object.values(oldLock.modules || {}).flatMap(files => Object.entries(files)))

    const actions = []
    for (const entry of [...wanted.values()].sort((a, b) => a.file.localeCompare(b.file))) {
        const at = path.join(target, entry.file)
        const there = fs.existsSync(at)
        const hash = there ? sha256(fs.readFileSync(at)) : null
        const modeMatches = there && isExecutable(fs.statSync(at).mode) === isExecutable(entry.mode)
        if (hash === entry.hash && modeMatches) continue
        actions.push({
            kind: !there ? 'add' : synced.has(entry.file) ? 'update' : 'replace',
            entry,
            file: entry.file,
            // Changed in the target since the sync wrote it
            edited: there && synced.has(entry.file) && hash !== synced.get(entry.file),
        })
    }
    for (const [file, hash] of synced) {
        if (wanted.has(file) || !fs.existsSync(path.join(target, file))) continue
        actions.push({ kind: 'remove', file, edited: sha256(fs.readFileSync(path.join(target, file))) !== hash })
    }

    const lock = { about: LOCK_ABOUT, modules: {} }
    for (const name of names) lock.modules[name] = {}
    for (const entry of [...wanted.values()].sort((a, b) => a.file.localeCompare(b.file))) lock.modules[entry.module][entry.file] = entry.hash
    const lockText = JSON.stringify(lock, null, 2) + '\n'
    const lockChanged = !fs.existsSync(lockPath) || fs.readFileSync(lockPath, 'utf8') !== lockText
    return { target, names, actions, lockText, lockChanged }
}

// Files a sync may not overwrite or remove without --force
const guarded = plan => plan.actions.filter(a => a.edited || a.kind === 'replace')

function applyPlan(plan) {
    for (const action of plan.actions) {
        const at = path.join(plan.target, action.file)
        if (action.kind === 'remove') {
            fs.rmSync(at)
            // and the folders that leaves empty
            for (let dir = path.dirname(at); dir !== plan.target && fs.readdirSync(dir).length === 0; dir = path.dirname(dir)) fs.rmdirSync(dir)
            continue
        }
        fs.mkdirSync(path.dirname(at), { recursive: true })
        fs.writeFileSync(at, action.entry.bytes)
        fs.chmodSync(at, action.entry.mode)
    }
    if (plan.lockChanged) fs.writeFileSync(path.join(plan.target, LOCK), plan.lockText)
}

function describe(action) {
    const note = action.edited
        ? 'edited there since the last sync'
        : action.kind === 'replace'
          ? "there before, and the sync didn't write it"
          : ''
    return `  ${action.kind.padEnd(8)} ${action.file}${note ? `  (${note})` : ''}`
}

function showDiff(plan, action) {
    const ours = action.entry ? path.join(HERE, 'modules', action.entry.module, 'files', action.file) : '/dev/null'
    const theirs = path.join(plan.target, action.file)
    spawnSync('git', ['--no-pager', 'diff', '--no-index', '--', fs.existsSync(theirs) ? theirs : '/dev/null', ours], { stdio: 'inherit' })
}

function main(argv) {
    const flags = new Set(argv.filter(a => a.startsWith('--')))
    const unknown = [...flags].filter(f => !['--check', '--diff', '--force', '--help'].includes(f))
    if (flags.has('--help') || unknown.length) {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
        return unknown.length ? 2 : 0
    }
    const checkOnly = flags.has('--check') || flags.has('--diff')
    const named = argv.filter(a => !a.startsWith('--'))
    const targets = named.length
        ? named.map(t => path.resolve(t))
        : (readJson(path.join(HERE, 'targets.json')).targets || []).map(t => path.resolve(HERE, t))

    let code = 0
    for (const target of targets) {
        const label = path.relative(process.cwd(), target) || '.'
        let plan
        try {
            plan = planTarget(target)
        } catch (error) {
            if (!(error instanceof SyncError)) throw error
            console.error(`${label}: ${error.message}`)
            code = 1
            continue
        }
        const changes = plan.actions.length + (plan.lockChanged ? 1 : 0)
        if (!changes) {
            console.log(`${label}: in sync (${plan.names.join(', ')})`)
            continue
        }
        if (checkOnly) {
            console.log(`${label}: differs from the shared source (${plan.names.join(', ')})`)
            for (const action of plan.actions) {
                console.log(describe(action))
                if (flags.has('--diff')) showDiff(plan, action)
            }
            if (plan.lockChanged) console.log(`  lock     ${LOCK}`)
            code = 1
            continue
        }
        const blocked = guarded(plan)
        if (blocked.length && !flags.has('--force')) {
            console.error(`${label}: not synced, since it would overwrite or remove what the sync didn't write:`)
            for (const action of blocked) console.error(describe(action))
            console.error('Move any change worth keeping into the shared source, then run it again with --force.')
            code = 1
            continue
        }
        applyPlan(plan)
        console.log(`${label}: synced (${plan.names.join(', ')})`)
        for (const action of plan.actions) console.log(describe(action))
        if (plan.lockChanged) console.log(`  lock     ${LOCK}`)
    }
    return code
}

process.exitCode = main(process.argv.slice(2))
