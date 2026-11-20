import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        // The sync's own tests, and each module's tests, which run here against
        // the module's test cases. Core's test checks a target's synced files, so
        // it only means something in a target.
        include: ['tests/**/*.test.mjs', 'modules/*/files/**/*.test.mjs'],
        exclude: ['modules/core/**', '**/node_modules/**'],
        env: { PUBLISH_TEST_CASES: 'modules/publish/test-cases.json' },
    },
})
