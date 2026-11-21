// Synced from the shared source (see shared.json): change it there, not here.
//
// The report settings (src/lib/report-settings.js): this repo's, from its
// shared.json, or in the shared source each of its test cases; and what's
// refused before anything runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { checkedSettings, formSettings, settingsProblems, withDefaults } from '../src/lib/report-settings.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// The settings under test: this repo's own, or each case the shared source lists
const CASES = process.env.REPORTS_TEST_CASES
    ? JSON.parse(fs.readFileSync(process.env.REPORTS_TEST_CASES, 'utf8'))
    : [{ name: "this repo's shared.json", settings: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared.json'), 'utf8')).modules?.reports }]

for (const { name, settings } of CASES) {
    test(`the settings in ${name} are valid, and the page gets only the form's part of them`, () => {
        assert.deepEqual(settingsProblems(settings), [])
        const form = formSettings(settings)
        assert.deepEqual(Object.keys(form).sort(), ['ids', 'messages', 'product', 'publicRepo'])
        assert.ok(!JSON.stringify(form).includes(settings.privateRepo), "the private repository's name stays off the page")
    })
}

const fine = {
    origin: 'https://example.com',
    product: 'Example',
    userLabel: 'forum user',
    publicRepo: 'Example/example',
    privateRepo: 'Example/reports',
    ids: 'post',
    caps: { perSender: 5 },
}
const problems = changes => settingsProblems({ ...fine, ...changes })

test('wrong settings are refused before anything runs', () => {
    assert.deepEqual(settingsProblems(fine), [])
    assert.deepEqual(settingsProblems(undefined), ['shared.json has no report settings (modules.reports)'])
    assert.equal(settingsProblems([]).length, 1)
    assert.ok(problems({ prodcut: 'Example' }).includes('unknown setting "prodcut"'))
    assert.ok(problems({ constructor: 'x' }).includes('unknown setting "constructor"'))
    for (const origin of ['http://example.com', 'https://example.com/', 'https://example.com/feedback', 'example.com', 'https://localhost', 'https://Example.com']) {
        assert.equal(problems({ origin }).length, 1, origin)
    }
    for (const repo of ['example', 'https://github.com/Example/example', 'Example/example/issues', '']) {
        assert.equal(problems({ publicRepo: repo, privateRepo: repo }).length, 2, repo)
    }
    assert.equal(problems({ product: ' ' }).length, 1)
    assert.equal(problems({ userLabel: 7 }).length, 1)
    assert.equal(problems({ ids: 'post ids' }).length, 1)
    assert.equal(problems({ typeNames: { bug: 'Bug report', idea: 'Idea' } }).length, 1)
    assert.equal(problems({ typeNames: { bug: '' } }).length, 1)
    assert.equal(problems({ messages: { thanks: 'Thanks!' } }).length, 1)
    assert.equal(problems({ caps: {} }).length, 1)
    assert.equal(problems({ caps: { keptPerHour: 30 } }).length, 1)
    assert.equal(problems({ caps: { perSender: 0 } }).length, 1)
    assert.equal(problems({ caps: { perSender: 2.5 } }).length, 1)
    assert.equal(problems({ caps: { perSender: 5, perDay: 9 } }).length, 1)
    assert.equal(problems({ accent: 'orange' }).length, 1)
    assert.deepEqual(problems({ typeNames: { bug: 'Bug report' }, messages: { sent: 'Sent!' }, caps: { perSender: 5, keptPerHour: 30, filedPerHour: 10 }, accent: '#D93A00' }), [])
    const { privateRepo, ...missing } = fine
    assert.ok(settingsProblems(missing).includes('privateRepo is missing'))
    assert.throws(() => checkedSettings({ ...fine, ids: 'post ids' }), /modules\.reports\) are wrong: ids must be/)
    assert.throws(() => formSettings({ ...fine, caps: {} }), /caps must be/)
})

test('the defaults fill in each type name and message a site leaves out', () => {
    const s = withDefaults({ ...fine, typeNames: { bug: 'Bug report' }, messages: { sent: 'Sent!' } })
    assert.deepEqual(s.typeNames, { bug: 'Bug report', feature: 'Idea', question: 'Question', other: 'Feedback' })
    assert.deepEqual(s.messages, { empty: 'Please say what happened.', sent: 'Sent!' })
    assert.match(s.accent, /^#[0-9a-f]{6}$/)
    assert.equal(withDefaults({ ...fine, accent: '#d93a00' }).accent, '#d93a00')
})
