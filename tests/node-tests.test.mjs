// The modules tested with node's test runner (module.json's tests.node), run
// here as a repo that takes them runs them, with node --test, against the
// module's test cases: modules/<name>/test-cases.json, passed in
// <NAME>_TEST_CASES (REPORTS_TEST_CASES for reports).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const REAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))

const modules = fs
    .readdirSync(path.join(REAL, 'modules'))
    .filter(name => name !== 'core' && fs.existsSync(path.join(REAL, 'modules', name, 'module.json')))
    .map(name => ({ name, files: readJson(path.join(REAL, 'modules', name, 'module.json')).tests?.node || [] }))
    .filter(m => m.files.length)

describe("the modules' node:test tests", () => {
    it('include the reports module', () => {
        expect(modules.map(m => m.name)).toContain('reports')
    })

    it.each(modules)('pass for $name, with its test cases', { timeout: 120_000 }, ({ name, files }) => {
        const cases = path.join('modules', name, 'test-cases.json')
        const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map(file => path.join('modules', name, 'files', file))], {
            cwd: REAL,
            encoding: 'utf8',
            env: { ...process.env, ...(fs.existsSync(path.join(REAL, cases)) ? { [`${name.toUpperCase().replace(/-/g, '_')}_TEST_CASES`]: cases } : {}), FORCE_COLOR: '0' },
        })
        const out = r.stdout + r.stderr
        expect(r.status, out).toBe(0)
        expect(Number(out.match(/ℹ pass (\d+)/)?.[1]), out).toBeGreaterThan(0)
    })
})
