// Synced from the shared source (see shared.json): change it there, not here.
//
// The site's Worker (src/lib/report-worker.js) with this repo's settings (in
// the shared source, each of its test cases): the router, and the one counter
// for the whole site, whose counting (report-counts.js) runs here for real
// behind a stand-in Durable Object, with a stand-in KV and fetch. The Durable
// Object's class (worker/index.js) needs Cloudflare's runtime. In a repo, also
// that its deploy config gives the Worker what it needs.
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { admitCounts, hourOf } from '../src/lib/report-counts.js'
import { withDefaults } from '../src/lib/report-settings.js'
import { reportsWorker } from '../src/lib/report-worker.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = path.join(ROOT, 'deploy', 'cloudflare.config.ts')
// The settings under test: this repo's own, or each case the shared source lists
const CASES = process.env.REPORTS_TEST_CASES
    ? JSON.parse(fs.readFileSync(process.env.REPORTS_TEST_CASES, 'utf8'))
    : [{ name: "this repo's shared.json", settings: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared.json'), 'utf8')).modules?.reports }]

function fakeKv() {
    const data = new Map()
    return {
        data,
        get: async k => (data.has(k) ? data.get(k) : null),
        put: async (k, v) => void data.set(k, v),
        delete: async k => void data.delete(k),
        list: async ({ prefix = '' } = {}) => ({ keys: [...data.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }),
    }
}

// The Durable Object binding: one object for the whole site, counting as
// worker/index.js's Limits does
function fakeLimits(caps) {
    let counts = null
    const object = {
        asked: [],
        admit: async sender => {
            object.asked.push(sender)
            const r = admitCounts(counts, sender, hourOf(), caps)
            if (r.ok) counts = r.counts
            return { ok: r.ok, why: r.why, file: r.file }
        },
    }
    return { object, idFromName: name => name, get: id => (id === 'site' ? object : null) }
}

test('the counts start over each hour, and a count is never changed in place', () => {
    const caps = { perSender: 2, keptPerHour: 3, filedPerHour: 1 }
    let counts = null
    for (let i = 0; i < 2; i++) counts = admitCounts(counts, 'a', 7, caps).counts
    assert.equal(admitCounts(counts, 'a', 7, caps).ok, false)
    const next = admitCounts(counts, 'a', 8, caps)
    assert.equal(next.ok, true)
    assert.deepEqual(next.counts, { hour: 8, kept: 1, filed: 1, senders: { a: 1 } })
    // one more report from someone else: a new count, the old one as it was
    const before = JSON.stringify(counts)
    const added = admitCounts(counts, 'b', 7, caps)
    assert.deepEqual(added.counts, { hour: 7, kept: 3, filed: 1, senders: { a: 2, b: 1 } })
    assert.equal(JSON.stringify(counts), before)
})

test("a sender's cap comes before the site's, and past the filed cap a report is still kept", () => {
    const caps = { perSender: 1, keptPerHour: 2, filedPerHour: 1 }
    let r = admitCounts(null, 'a', 1, caps)
    assert.deepEqual([r.ok, r.file], [true, true])
    r = admitCounts(r.counts, 'b', 1, caps)
    assert.deepEqual([r.ok, r.file], [true, false])
    assert.deepEqual([admitCounts(r.counts, 'a', 1, caps).why, admitCounts(r.counts, 'c', 1, caps).why], ['sender', 'site'])
})

for (const { name, settings } of CASES) {
    describe(`the Worker with ${name}`, () => {
        const s = withDefaults(settings)
        const { caps, origin } = s
        const worker = reportsWorker(settings)
        let env, waits, dispatched, consoleError

        beforeEach(() => {
            env = { FEEDBACK: fakeKv(), LIMITS: fakeLimits(caps), GITHUB_TOKEN: 'test-token', FEEDBACK_KEY: 'inbox-key' }
            waits = []
            dispatched = []
            // GitHub answers a workflow start with 204 and no body
            globalThis.fetch = async (url, init) => {
                dispatched.push({ url, inputs: JSON.parse(init.body).inputs })
                return new Response(null, { status: 204 })
            }
            consoleError = console.error
            console.error = () => {}
        })
        afterEach(() => {
            console.error = consoleError
        })

        const ctx = () => ({ waitUntil: p => void waits.push(p) })
        const post = (body, headers = {}) =>
            worker.fetch(
                new Request(`${origin}/api/feedback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '203.0.113.9', ...headers },
                    body: JSON.stringify(body),
                }),
                env,
                ctx(),
            )
        const reports = () => [...env.FEEDBACK.data].filter(([k]) => k.startsWith('fb_')).map(([, v]) => JSON.parse(v))

        test('keeps a report from the form and files it, through the router and the counter', async () => {
            const res = await post({ type: 'bug', message: 'It stopped\nmore' })
            assert.equal(res.status, 200)
            await Promise.all(waits)
            assert.equal(dispatched.length, 1)
            assert.equal(dispatched[0].url, `https://api.github.com/repos/${s.privateRepo}/actions/workflows/file-report.yml/dispatches`)
            assert.equal(dispatched[0].inputs.title, `${s.typeNames.bug}: It stopped`)
            assert.equal(reports()[0].filed, true)
            assert.equal(env.LIMITS.object.asked.length, 1)
        })

        test(`one address gets ${caps.perSender} reports an hour, counted by a salted hash and never the address`, async () => {
            for (let i = 0; i < caps.perSender; i++) assert.equal((await post({ message: `report ${i}` })).status, 200)
            const tooMany = await post({ message: 'one too many' })
            assert.equal(tooMany.status, 429)
            assert.match((await tooMany.json()).error, /from here/)
            assert.equal((await post({ message: 'another address' }, { 'CF-Connecting-IP': '198.51.100.4' })).status, 200)
            // the counter is told a hash, never the address; KV keeps only the reports
            for (const sender of env.LIMITS.object.asked) assert.match(sender, /^[0-9a-f]{16}$/)
            assert.ok([...env.FEEDBACK.data.keys()].every(k => k.startsWith('fb_')))
        })

        test('addresses in one IPv6 /64 share the hourly cap', async () => {
            for (let i = 0; i < caps.perSender; i++) {
                assert.equal((await post({ message: `report ${i}` }, { 'CF-Connecting-IP': `2001:db8:aa:bb::${i + 1}` })).status, 200)
            }
            assert.equal((await post({ message: 'a new address, same network' }, { 'CF-Connecting-IP': '2001:db8:aa:bb:ffff::1' })).status, 429)
            assert.equal((await post({ message: 'another network' }, { 'CF-Connecting-IP': '2001:db8:aa:cc::1' })).status, 200)
        })

        test('when the counter can’t be asked, a report is turned away as the site’s trouble, not the sender’s', async () => {
            env.LIMITS.object.admit = async () => {
                throw new Error('Durable Object unavailable')
            }
            const res = await post({ message: 'while the counter is down' })
            assert.equal(res.status, 503)
            assert.match((await res.json()).error, /can't be taken right now/)
            delete env.LIMITS
            assert.equal((await post({ message: 'with no counter bound' })).status, 503)
            assert.equal(reports().length, 0)
        })

        test(`at most ${caps.filedPerHour} reports an hour become issues and ${caps.keptPerHour} are kept, from everyone together`, async () => {
            // a sender per report, so only the site's caps apply
            const address = i => `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`
            for (let i = 0; i < caps.keptPerHour; i++) assert.equal((await post({ message: `report ${i}` }, { 'CF-Connecting-IP': address(i) })).status, 200)
            const past = await post({ message: 'past the site’s cap' }, { 'CF-Connecting-IP': '192.0.2.1' })
            assert.equal(past.status, 429)
            assert.match((await past.json()).error, /this hour/)
            await Promise.all(waits)
            assert.equal(dispatched.length, Math.min(caps.filedPerHour, caps.keptPerHour))
            assert.equal(reports().length, caps.keptPerHour)
        })

        test('the inbox is at /api/feedback, another method there is refused, and anything else is not found', async () => {
            await post({ message: 'kept for the inbox' })
            const page = await worker.fetch(new Request(`${origin}/api/feedback?key=inbox-key`), env, ctx())
            assert.equal(page.status, 200)
            assert.match(await page.text(), /kept for the inbox/)
            const put = await worker.fetch(new Request(`${origin}/api/feedback`, { method: 'PUT' }), env, ctx())
            assert.equal(put.status, 405)
            assert.equal(put.headers.get('Allow'), 'GET, POST')
            assert.equal((await worker.fetch(new Request(`${origin}/api/other`), env, ctx())).status, 404)
        })

        test("a video is read from the site's files and sent in the part asked for; nothing else under /assets/ is the Worker's", async () => {
            const asked = []
            env.ASSETS = {
                fetch: async request => {
                    asked.push(new URL(request.url).pathname)
                    return new Response(new Uint8Array(10), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10' } })
                },
            }
            const res = await worker.fetch(new Request(`${origin}/assets/intro.mp4`, { headers: { Range: 'bytes=2-5' } }), env, ctx())
            assert.equal(res.status, 206)
            assert.equal(res.headers.get('Content-Range'), 'bytes 2-5/10')
            assert.equal((await res.arrayBuffer()).byteLength, 4)
            assert.deepEqual(asked, ['/assets/intro.mp4'])
            assert.equal((await worker.fetch(new Request(`${origin}/assets/poster.jpg`), env, ctx())).status, 404)
        })
    })
}

test('the deploy config gives the Worker what it needs', { skip: !fs.existsSync(DEPLOY) && 'no deploy config here' }, () => {
    const config = fs.readFileSync(DEPLOY, 'utf8')
    const host = new URL(CASES[0].settings.origin).host.replace(/\./g, '\\.')
    const has = (pattern, what) => assert.match(config, pattern, `deploy/cloudflare.config.ts: ${what}`)
    has(/entrypoint:\s*["']\.\.\/worker\/index\.js["']/, 'the entrypoint is ../worker/index.js')
    has(new RegExp(`domains:\\s*\\[[^\\]]*["']${host}["']`), `the domain is the settings' origin, ${host.replace(/\\/g, '')}`)
    has(/runWorkerFirst:\s*\[\s*["']\/api\/\*["']\s*,\s*["']\/assets\/\*\.mp4["']\s*\]/, 'only /api/* and the videos (/assets/*.mp4) run the Worker')
    has(/ASSETS:\s*bindings\.assets\(\)/, "ASSETS is the site's static files, which the videos are read from")
    has(/notFoundHandling:\s*["']404-page["']/, 'a missing page gets the 404 page')
    has(/Limits:\s*exports\.durableObject\(/, 'Limits is exported as a Durable Object')
    has(/FEEDBACK:\s*bindings\.kv\(/, 'FEEDBACK is a KV namespace')
    has(/LIMITS:\s*bindings\.durableObject\(\{[^}]*exportName:\s*["']Limits["']/, 'LIMITS is the Limits Durable Object')
    has(/GITHUB_TOKEN:\s*bindings\.secret\(\)/, 'GITHUB_TOKEN is a secret')
    has(/FEEDBACK_KEY:\s*bindings\.secret\(\)/, 'FEEDBACK_KEY is a secret')
    assert.doesNotMatch(config, /GITHUB_REPO/, 'the private repository is in shared.json, not the deploy config')
})
