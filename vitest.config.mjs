import fs from 'fs'
import { defineConfig } from 'vitest/config'

// The modules' vitest tests (each module.json's tests.vitest), which run here
// against the module's test cases. Core's test checks a target's synced files,
// so it only means something in a target. The modules tested with node's test
// runner (tests.node) run from tests/node-tests.test.mjs.
const MODULES = new URL('./modules/', import.meta.url)
const vitestTests = fs
    .readdirSync(MODULES)
    .filter(name => name !== 'core' && fs.existsSync(new URL(`${name}/module.json`, MODULES)))
    .flatMap(name => (JSON.parse(fs.readFileSync(new URL(`${name}/module.json`, MODULES), 'utf8')).tests?.vitest || []).map(file => `modules/${name}/files/${file}`))

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.mjs', ...vitestTests],
        exclude: ['**/node_modules/**'],
        env: { PUBLISH_TEST_CASES: 'modules/publish/test-cases.json' },
    },
})
