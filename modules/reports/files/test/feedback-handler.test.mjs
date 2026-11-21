// Synced from the shared source (see shared.json): change it there, not here.
//
// The report form's handler and the inbox (src/lib/feedback-handler.js) with
// this repo's settings (in the shared source, each of its test cases), and a
// stand-in KV, counter and fetch: who may send, what's kept, what the counter is
// told and what its answers do, the issue it files, and the inbox. The site's
// own entry and counter have their own tests.
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { addressOf, fenced, MAX_BODY_BYTES, reportsHandler } from '../src/lib/feedback-handler.js'
import { withDefaults } from '../src/lib/report-settings.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
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

// The site's counter as the handler sees it: it gives the answer it's set to
// (an Error is thrown), and notes who it was asked about
function fakeCounter() {
    const counter = {
        asked: [],
        answer: { ok: true, file: true },
        admit: async sender => {
            counter.asked.push(sender)
            if (counter.answer instanceof Error) throw counter.answer
            return counter.answer
        },
    }
    return counter
}

const details = { v: '0.0.6', b: 'Chrome 142, macOS', s: 'Watching 2', l: '11-14 10:05 check · #456 gone' }

test('an IPv6 sender’s whole /64 counts as one address, and an IPv4 address is itself', () => {
    assert.equal(addressOf('203.0.113.9'), '203.0.113.9')
    assert.equal(addressOf('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64')
    assert.equal(addressOf('2001:0DB8:00aa:bb::9'), '2001:db8:aa:bb::/64')
    assert.equal(addressOf('2001:db8::1'), '2001:db8:0:0::/64')
    assert.equal(addressOf('::1'), '0:0:0:0::/64')
    assert.equal(addressOf('::ffff:203.0.113.9'), '203.0.113.9')
    assert.equal(addressOf('unknown'), 'unknown')
})

test('a code fence is longer than any run of backticks in its text, so the text stays inside', () => {
    assert.equal(fenced('plain'), '```text\nplain\n```')
    assert.equal(fenced('a ``` b ```` c'), '`````text\na ``` b ```` c\n`````')
})

test('wrong settings stop the handler before it takes a report', () => {
    assert.throws(() => reportsHandler(undefined), /modules\.reports/)
    assert.throws(() => reportsHandler({ ...CASES[0].settings, origin: 'https://example.com/' }), /origin must be/)
})

for (const { name, settings } of CASES) {
    describe(`the handler with ${name}`, () => {
        const s = withDefaults(settings)
        const site = new URL(s.origin).host
        const { post, inbox, issueFor } = reportsHandler(settings)
        let env, counter, waits, dispatched, errors, consoleError

        beforeEach(() => {
            env = { FEEDBACK: fakeKv(), FEEDBACK_KEY: 'inbox-key', GITHUB_TOKEN: 'test-token' }
            counter = fakeCounter()
            waits = []
            dispatched = []
            // GitHub answers a workflow start with 204 and no body
            globalThis.fetch = async (url, init) => {
                dispatched.push({ url, init, inputs: JSON.parse(init.body).inputs, ref: JSON.parse(init.body).ref })
                return new Response(null, { status: 204 })
            }
            errors = []
            consoleError = console.error
            console.error = (...args) => void errors.push(args.join(' '))
        })
        afterEach(() => {
            console.error = consoleError
        })

        const send = async (body, headers = {}) => {
            const res = await post(
                new Request(`${s.origin}/api/feedback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Origin: s.origin, 'CF-Connecting-IP': '203.0.113.9', ...headers },
                    body: typeof body === 'string' ? body : JSON.stringify(body),
                }),
                env,
                { waitUntil: p => void waits.push(p), counter },
            )
            await Promise.all(waits)
            return res
        }
        const reports = () => [...env.FEEDBACK.data].filter(([k]) => k.startsWith('fb_')).map(([id, v]) => ({ id, ...JSON.parse(v) }))
        const get = query => inbox(new Request(`${s.origin}/api/feedback${query}`), env)

        test('keeps a report from the form, then files it through the private repository’s workflow', async () => {
            const res = await send({ type: 'bug', message: 'Nothing shows since Tuesday\nmore', username: 'someone', email: 'me@example.com', details })
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), { ok: true })
            assert.equal(res.headers.get('Cache-Control'), 'no-store')
            const [kept] = reports()
            assert.equal(kept.type, 'bug')
            assert.equal(kept.message, 'Nothing shows since Tuesday\nmore')
            assert.equal(kept.username, 'someone')
            assert.deepEqual(kept.details, details)
            // filed: the inbox can link to it
            assert.equal(kept.filed, true)

            assert.equal(dispatched.length, 1)
            const { url, init, ref, inputs } = dispatched[0]
            // the workflow, not this token, opens the issue, so GitHub tells the developer about it
            assert.equal(url, `https://api.github.com/repos/${s.privateRepo}/actions/workflows/file-report.yml/dispatches`)
            assert.equal(init.headers.Authorization, 'Bearer test-token')
            assert.match(init.headers['User-Agent'], /^[a-z0-9-]+-feedback$/)
            assert.equal(ref, 'main')
            assert.equal(inputs.title, `${s.typeNames.bug}: Nothing shows since Tuesday`)
            assert.equal(inputs.labels, 'bug')
            assert.ok(inputs.body.includes(`**${s.typeNames.bug}** · ${s.userLabel}: \`someone\` · email: \`me@example.com\``), inputs.body)
            assert.ok(inputs.body.includes(`**${s.product}** \`0.0.6\` · \`Chrome 142, macOS\``), inputs.body)
            // private: ids are kept unless the person hid them
            assert.match(inputs.body, /#456 gone/)
            // what the inbox's link searches for
            assert.ok(inputs.body.endsWith(`<sub>Report ${kept.id}</sub>`))
            // the counter is told a salted hash
            assert.equal(counter.asked.length, 1)
            assert.match(counter.asked[0], /^[0-9a-f]{16}$/)
        })

        test(`only the form on ${site} (or a local preview) may send`, async () => {
            for (const Origin of ['https://elsewhere.example', '', `http://${site}`, `https://${site}.elsewhere.example`, 'http://localhost.elsewhere.example', 'null']) {
                const res = await send({ message: 'hi' }, { Origin })
                assert.equal(res.status, 403, Origin)
                assert.equal((await res.json()).error, `Reports come from the form on ${site}.`)
            }
            assert.equal(reports().length, 0)
            for (const Origin of ['http://localhost:4321', 'http://127.0.0.1:8788', 'http://localhost']) {
                assert.equal((await send({ message: 'from a local preview' }, { Origin })).status, 200, Origin)
            }
            assert.equal(reports().length, 3)
        })

        test('a bot that fills the hidden field is thanked and forgotten, and a blank message or bad JSON is refused', async () => {
            assert.equal((await send({ message: 'buy now', website: 'http://spam.example' })).status, 200)
            const blank = await send({ message: '  ' })
            assert.equal(blank.status, 400)
            assert.equal((await blank.json()).error, s.messages.empty)
            assert.equal((await send({ message: 7 })).status, 400)
            assert.equal((await send('{not json')).status, 400)
            assert.equal((await send('null')).status, 400)
            assert.equal(reports().length, 0)
            assert.equal(dispatched.length, 0)
            assert.equal(counter.asked.length, 0)
        })

        test(`a report over ${MAX_BODY_BYTES / 1024} KB is refused, by its stated length or its body`, async () => {
            const stated = await send({ message: 'short' }, { 'Content-Length': String(MAX_BODY_BYTES + 1) })
            assert.equal(stated.status, 413)
            assert.equal((await send({ message: 'x'.repeat(MAX_BODY_BYTES) })).status, 413)
            assert.equal(reports().length, 0)
            assert.equal(counter.asked.length, 0)
        })

        test('the counter is told a salted hash of the sender, never the address, and a sender with no address is counted too', async () => {
            await send({ message: 'a' })
            await send({ message: 'b' })
            await send({ message: 'c' }, { 'CF-Connecting-IP': '198.51.100.4' })
            await send({ message: 'd' }, { 'CF-Connecting-IP': '2001:db8:aa:bb::1' })
            await send({ message: 'e' }, { 'CF-Connecting-IP': '2001:db8:aa:bb:ffff::2' })
            await send({ message: 'f' }, { 'CF-Connecting-IP': '' })
            await send({ message: 'g' }, { 'CF-Connecting-IP': '' })
            const [a, b, c, d, e, f, g] = counter.asked
            assert.equal(counter.asked.length, 7)
            for (const sender of counter.asked) assert.match(sender, /^[0-9a-f]{16}$/)
            assert.equal(a, b)
            assert.notEqual(a, c)
            // one IPv6 /64 is one sender
            assert.equal(d, e)
            assert.equal(f, g)
            assert.ok(![a, c, d].includes(f))
            // salted with the inbox's key
            env.FEEDBACK_KEY = 'another-key'
            await send({ message: 'h' })
            assert.notEqual(counter.asked[7], a)
            // the handler keeps nothing but the reports
            assert.ok([...env.FEEDBACK.data.keys()].every(k => k.startsWith('fb_')))
        })

        test('the counter’s answer decides: a no for the sender or the site, no answer, or keep without filing', async () => {
            counter.answer = { ok: false, why: 'sender', file: false }
            const sender = await send({ message: 'one too many' })
            assert.equal(sender.status, 429)
            assert.match((await sender.json()).error, /came from here in the last hour/)
            counter.answer = { ok: false, why: 'site', file: false }
            const busy = await send({ message: 'past the site’s cap' })
            assert.equal(busy.status, 429)
            assert.match((await busy.json()).error, /Many reports came in this hour/)
            for (const answer of [null, undefined, new Error('Durable Object unavailable')]) {
                counter.answer = answer
                const down = await send({ message: 'while the counter is down' })
                assert.equal(down.status, 503)
                assert.match((await down.json()).error, /can't be taken right now/)
            }
            assert.ok(errors.some(e => e.includes('report counter unavailable')))
            assert.equal(reports().length, 0)

            counter.answer = { ok: true, file: false }
            assert.equal((await send({ message: 'kept, not filed' })).status, 200)
            assert.equal(reports().length, 1)
            assert.equal(dispatched.length, 0)
        })

        test('without a token it only keeps, and a GitHub refusal or failure still keeps the report', async () => {
            delete env.GITHUB_TOKEN
            await send({ type: 'feature', message: 'Dark mode?' })
            assert.equal(dispatched.length, 0)
            env.GITHUB_TOKEN = 'test-token'
            globalThis.fetch = async () => new Response('nope', { status: 403 })
            assert.equal((await send({ type: 'bug', message: 'refused' })).status, 200)
            globalThis.fetch = async () => {
                throw new TypeError('fetch failed')
            }
            assert.equal((await send({ type: 'bug', message: 'failed' })).status, 200)
            assert.equal(reports().length, 3)
            assert.ok(reports().every(r => r.filed === undefined))
            assert.equal(errors.filter(e => e.includes('GitHub issue not filed')).length, 2)
        })

        test('sizes are capped, an unknown type is other, and details that are not an object are dropped', async () => {
            await send({ type: '<script>', message: ` ${'m'.repeat(6000)} `, username: 'u'.repeat(150), email: 'e'.repeat(300), details: { ...details, l: 'l'.repeat(30000), extra: 'dropped' } })
            const [entry] = reports()
            assert.equal(entry.type, 'other')
            assert.equal(entry.message.length, 5000)
            assert.equal(entry.username.length, 100)
            assert.equal(entry.email.length, 200)
            assert.equal(entry.details.l.length, 20000)
            assert.deepEqual(Object.keys(entry.details), ['v', 'b', 's', 'l'])
            await send({ type: 'question', message: 'q', details: 'not an object' })
            assert.equal(reports().find(r => r.type === 'question').details, undefined)
        })

        test('a report’s own words can’t turn into mentions or links in the issue', () => {
            const { title, body, labels } = issueFor('fb_x', {
                type: 'other',
                message: 'ping @someone ``` and [a link](https://example.com)',
                username: '@another`one\nline',
                email: '',
                details: { v: '0.0.1', b: '@third', s: 's ````', l: 'l' },
            })
            assert.equal(title, `${s.typeNames.other}: ping @someone \`\`\` and [a link](https://example.com)`)
            assert.equal(labels, '')
            // the message sits in a fence longer than any run of backticks in it
            assert.ok(body.startsWith('````text\nping @someone ``` and [a link](https://example.com)\n````\n'), body)
            // a username loses its backticks and line breaks, so it stays one piece of inline code
            assert.ok(body.includes(`${s.userLabel}: \`@anotheroneline\``), body)
            assert.ok(body.includes(`**${s.product}** \`0.0.1\` · \`@third\``), body)
            assert.ok(body.includes('`````text\ns ````\n`````'), body)
        })

        test('the largest report fits what a workflow start accepts', async () => {
            await send({ type: 'bug', message: 'm'.repeat(5000), username: 'u'.repeat(100), email: 'e'.repeat(200), details: { v: 'v'.repeat(40), b: 'b'.repeat(80), s: 's'.repeat(3000), l: 'l'.repeat(20000) } })
            const { inputs } = dispatched[0]
            assert.ok(inputs.title.length + inputs.body.length + inputs.labels.length < 65535)
        })

        test('the inbox needs its key, and none at all when no key is set', async () => {
            await send({ message: 'kept for the inbox' })
            for (const query of ['', '?key=', '?key=wrong', '?key=inbox-keyx', '?key=INBOX-KEY']) {
                const res = await get(query)
                assert.equal(res.status, 401, query)
                assert.equal(res.headers.get('Cache-Control'), 'no-store')
            }
            delete env.FEEDBACK_KEY
            assert.equal((await get('?key=')).status, 401)
            assert.equal((await get('?key=undefined')).status, 401)
            // an empty key is no key
            env.FEEDBACK_KEY = ''
            assert.equal((await get('?key=')).status, 401)
            assert.equal((await get('')).status, 401)
        })

        test('the inbox lists the reports, not the counts, links each filed issue, and passes its key to no link', async () => {
            await send({ type: 'bug', message: 'Listed <b>here</b>', username: 'someone', details })
            env.FEEDBACK.data.set('rl_0123456789abcdef_1', '3') // a site's count, kept beside the reports
            const page = await get('?key=inbox-key')
            assert.equal(page.status, 200)
            assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer')
            assert.equal(page.headers.get('Cache-Control'), 'no-store')
            assert.equal(page.headers.get('X-Robots-Tag'), 'noindex')
            assert.equal(page.headers.get('X-Frame-Options'), 'DENY')
            assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/)
            const html = await page.text()
            assert.ok(html.includes(`<title>${s.product} reports</title>`))
            assert.match(html, /1 total · 1 unread/)
            assert.ok(html.includes('Listed &lt;b&gt;here&lt;/b&gt;'))
            assert.ok(html.includes(`${s.product} 0.0.6 · Chrome 142, macOS`))
            const [{ id }] = reports()
            assert.ok(html.includes(`rel="noreferrer" href="https://github.com/${s.privateRepo}/issues?q=${encodeURIComponent(id)}"`))
        })

        test('the inbox marks and deletes only reports, and goes back to itself', async () => {
            await send({ message: 'first' })
            await send({ message: 'second' })
            env.FEEDBACK.data.set('rl_0123456789abcdef_1', '3')
            const [one, two] = reports()
            const read = await get(`?key=inbox-key&action=read&id=${encodeURIComponent(one.id)}`)
            assert.equal(read.status, 302)
            assert.equal(read.headers.get('Location'), '/api/feedback?key=inbox-key')
            assert.equal(read.headers.get('Referrer-Policy'), 'no-referrer')
            assert.equal(reports().find(r => r.id === one.id).read, true)
            // not a report: left alone
            await get('?key=inbox-key&action=delete&id=rl_0123456789abcdef_1')
            await get('?key=inbox-key&action=read&id=rl_0123456789abcdef_1')
            assert.equal(env.FEEDBACK.data.get('rl_0123456789abcdef_1'), '3')
            // the read ones go, the unread one stays
            await get('?key=inbox-key&action=clear-read')
            assert.deepEqual(reports().map(r => r.id), [two.id])
            await get(`?key=inbox-key&action=delete&id=${encodeURIComponent(two.id)}`)
            assert.equal(reports().length, 0)
            assert.equal(env.FEEDBACK.data.size, 1)
            assert.match(await (await get('?key=inbox-key')).text(), /No reports yet/)
        })
    })
}
