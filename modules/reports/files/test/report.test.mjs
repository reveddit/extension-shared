// Synced from the shared source (see shared.json): change it there, not here.
//
// The report page's reading of the extension's link (src/lib/report.js): the
// details after #r=, and the stand-ins that hide ids.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idHider, readDetails } from '../src/lib/report.js'

// as the extension's report.ts builds the link
const link = d => `#r=${Buffer.from(JSON.stringify(d)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

test('reads the details the extension put after #r=', () => {
    const d = { v: '0.0.6', b: 'Chrome 142, macOS', s: 'Checks every 1 min ✓', l: '11-14 10:05 check · #1000000000000000005 missing 😀', t: 1 }
    assert.deepEqual(readDetails(link(d)), { v: d.v, b: d.b, s: d.s, l: d.l })
})

test('caps each field, and drops anything that is not text', () => {
    const d = readDetails(link({ v: 'v'.repeat(100), b: 7, s: 's'.repeat(5000), l: 'l'.repeat(30000), extra: 'x' }))
    assert.deepEqual(Object.keys(d), ['v', 'b', 's', 'l'])
    assert.equal(d.v.length, 40)
    assert.equal(d.b, '')
    assert.equal(d.s.length, 3000)
    assert.equal(d.l.length, 20000)
})

test('anything else in the address is no details', () => {
    const notJson = `#r=${Buffer.from('not json').toString('base64url')}`
    for (const hash of ['', '#', '#r=', '#r=***', '#r=not json!', '#x=abc', notJson, link('just a string'), link(null), link(7)]) {
        assert.equal(readDetails(hash), null, hash)
    }
})

test('hides each id behind one stand-in, the same throughout a report', () => {
    let n = 0
    const hide = idHider(() => `#x${n++}`)
    assert.equal(hide('#123 seen · #456 gone · #123 gone'), '#x0 seen · #x1 gone · #x0 gone')
    // and in the next text from the same report
    assert.equal(hide('then #456'), 'then #x1')
})

test('a stand-in starts with a letter, so it is never read as an id again', () => {
    const hide = idHider()
    const once = hide('#1000000000000000005 and #1000000000000000006 and #1000000000000000005')
    assert.match(once, /^#[a-z][a-z0-9]{5} and #[a-z][a-z0-9]{5} and #[a-z][a-z0-9]{5}$/)
    const [a, b, c] = once.match(/#[a-z][a-z0-9]{5}/g)
    assert.equal(a, c)
    assert.notEqual(a, b)
    assert.equal(hide(once), once)
})

test('two ids never share a stand-in, and stand-ins differ between reports', () => {
    const picks = ['#aaaaaa', '#aaaaaa', '#bbbbbb']
    const hide = idHider(() => picks.shift())
    assert.equal(hide('#1 #2'), '#aaaaaa #bbbbbb')
    assert.notEqual(idHider()('#1'), idHider()('#1'))
})
