// Synced from the shared source (see shared.json): change it there, not here.
//
// The report page's script (src/lib/feedback-form.js) on a stand-in page, with
// this repo's settings (in the shared source, each of its test cases): the hint
// when no details came, the details box, hiding ids, sending privately, and the
// public issue. In a repo, also that its report page has what the script needs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { PAGE_IDS, startReportForm } from '../src/lib/feedback-form.js'
import { formSettings } from '../src/lib/report-settings.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = path.join(ROOT, 'src', 'pages', 'feedback.astro')
// The settings under test: this repo's own, or each case the shared source lists
const CASES = process.env.REPORTS_TEST_CASES
    ? JSON.parse(fs.readFileSync(process.env.REPORTS_TEST_CASES, 'utf8'))
    : [{ name: "this repo's shared.json", settings: JSON.parse(fs.readFileSync(path.join(ROOT, 'shared.json'), 'utf8')).modules?.reports }]

// as the extension's report.ts builds the link
const link = d => `#r=${Buffer.from(JSON.stringify(d)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
const details = { v: '0.0.6', b: 'Chrome 142, macOS', s: 'Watching #111', l: '10:05 check · #111 seen · #222 gone' }

// A stand-in page: the elements the script finds by id, as the page's markup
// starts them, the form's submit button and the details box's <details>, and the
// window's location, history, fetch, clipboard and open. `type` is the choice the
// type list starts on ('' for a "Choose one" placeholder).
function fakePage(settings, { hash = '', type = '', clipboard = true, answer = { status: 200, body: { ok: true } } } = {}) {
    const listeners = {}
    const start = {
        'fb-from-extension': { hidden: true },
        'fb-details': { hidden: true },
        'fb-type': { value: type },
        'fb-include': { checked: true },
        'fb-hide-ids': { checked: false },
    }
    const el = Object.fromEntries(
        PAGE_IDS.map(id => [
            id,
            {
                id,
                hidden: false,
                textContent: '',
                className: '',
                value: '',
                checked: false,
                dataset: {},
                ...start[id],
                addEventListener: (type, fn) => void (listeners[`${id} ${type}`] = fn),
            },
        ]),
    )
    const submit = { textContent: 'Send privately', disabled: false }
    const box = { open: false }
    el['fb-form'].dataset.settings = JSON.stringify(formSettings(settings))
    el['fb-form'].querySelector = selector => (selector === 'button[type="submit"]' ? submit : null)
    // what a form's reset() puts back: the fields, as the markup starts them
    el['fb-form'].reset = () => {
        for (const id of ['fb-message', 'fb-username', 'fb-email', 'fb-website']) el[id].value = ''
        for (const id of ['fb-type', 'fb-include', 'fb-hide-ids']) Object.assign(el[id], start[id])
    }
    el['fb-details'].querySelector = selector => (selector === 'details' ? box : null)

    const calls = { replaced: [], sent: [], opened: [], copied: [] }
    const win = {
        document: { getElementById: id => el[id] ?? null },
        location: { hash, pathname: '/feedback', search: '' },
        history: { replaceState: (...args) => void calls.replaced.push(args) },
        fetch: async (url, init) => {
            calls.sent.push({ url, method: init.method, body: JSON.parse(init.body) })
            return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status })
        },
        navigator: clipboard ? { clipboard: { writeText: async text => void calls.copied.push(text) } } : {},
        open: (...args) => void calls.opened.push(args),
    }
    startReportForm(win)
    const fire = async (id, type) => listeners[`${id} ${type}`]({ preventDefault() {} })
    return { el, submit, box, calls, fire, setAnswer: a => (answer = a) }
}

// the ids a text still shows
const ids = text => text.match(/#\d+/g) || []

for (const { name, settings } of CASES) {
    const s = formSettings(settings)

    describe(`the report form with ${name}`, () => {
        test('with no details, the hint points to the extension’s button, and the details box stays hidden', () => {
            const { el, calls } = fakePage(settings)
            assert.equal(el['fb-from-extension'].hidden, false)
            assert.equal(el['fb-details'].hidden, true)
            assert.equal(el['fb-type'].value, '')
            assert.deepEqual(calls.replaced, [])
        })

        test('with details, the box shows them, the address forgets them, and the report is a problem', () => {
            const { el, calls } = fakePage(settings, { hash: link(details) })
            assert.equal(el['fb-details'].hidden, false)
            assert.equal(el['fb-from-extension'].hidden, true)
            assert.equal(el['fb-details-line'].textContent, `${s.product} 0.0.6 · Chrome 142, macOS`)
            assert.equal(el['fb-details-text'].textContent, `${details.s}\n\n${details.l}`)
            assert.deepEqual(calls.replaced, [[null, '', '/feedback']])
            assert.equal(el['fb-type'].value, 'bug')
            // a link with no details in it is still taken out of the address
            const bad = fakePage(settings, { hash: '#r=***' })
            assert.deepEqual(bad.calls.replaced, [[null, '', '/feedback']])
            assert.equal(bad.el['fb-from-extension'].hidden, false)
        })

        test('hiding ids hides them in the status summary and the log, with the stand-ins a public issue gets', async () => {
            const { el, calls, fire } = fakePage(settings, { hash: link(details) })
            el['fb-hide-ids'].checked = true
            await fire('fb-hide-ids', 'change')
            const shown = el['fb-details-text'].textContent
            assert.deepEqual(ids(shown), [])
            const [inStatus, inLog, other] = shown.match(/#[a-z][a-z0-9]{5}/g)
            // #111 is the same stand-in in both, and #222 another
            assert.equal(inStatus, inLog)
            assert.notEqual(inLog, other)

            await fire('fb-github', 'click')
            const opened = new URL(calls.opened[0][0])
            assert.equal(opened.searchParams.get('status'), shown.split('\n\n')[0])
            assert.equal(calls.copied[0], shown.split('\n\n')[1])
        })

        test('sending privately posts the report, thanks the person, and starts the form over', async () => {
            const { el, submit, calls, fire } = fakePage(settings, { hash: link(details) })
            el['fb-message'].value = '  It stopped  '
            el['fb-username'].value = 'someone'
            el['fb-email'].value = 'me@example.com'
            await fire('fb-form', 'submit')
            assert.deepEqual(calls.sent, [
                {
                    url: '/api/feedback',
                    method: 'POST',
                    body: { type: 'bug', message: 'It stopped', username: 'someone', email: 'me@example.com', details, website: '' },
                },
            ])
            assert.equal(el['fb-status'].textContent, s.messages.sent)
            assert.equal(el['fb-status'].className, 'fb-status ok')
            assert.equal(el['fb-message'].value, '')
            assert.equal(el['fb-type'].value, 'bug')
            assert.deepEqual([submit.textContent, submit.disabled], ['Send privately', false])

            // ids hidden as the person chose, or no details at all
            el['fb-message'].value = 'again'
            el['fb-hide-ids'].checked = true
            await fire('fb-form', 'submit')
            assert.deepEqual(ids(JSON.stringify(calls.sent[1].body.details)), [])
            el['fb-message'].value = 'and again'
            el['fb-include'].checked = false
            await fire('fb-form', 'submit')
            assert.equal(calls.sent[2].body.details, null)
        })

        test('an empty message is refused on the page, and the handler’s refusal is shown', async () => {
            const page = fakePage(settings)
            const { el, calls, fire } = page
            el['fb-message'].value = '   '
            await fire('fb-form', 'submit')
            assert.equal(el['fb-status'].textContent, s.messages.empty)
            assert.equal(el['fb-status'].className, 'fb-status err')
            assert.equal(calls.sent.length, 0)

            el['fb-message'].value = 'one too many'
            page.setAnswer({ status: 429, body: { error: 'Several reports came from here in the last hour. Please try again later.' } })
            await fire('fb-form', 'submit')
            assert.equal(el['fb-status'].textContent, 'Several reports came from here in the last hour. Please try again later.')
            assert.equal(el['fb-message'].value, 'one too many')
            page.setAnswer({ status: 502, body: undefined })
            await fire('fb-form', 'submit')
            assert.equal(el['fb-status'].textContent, 'Something went wrong. Try again?')
            assert.equal(el['fb-status'].className, 'fb-status err')
        })

        test('the public issue opens the issue form with ids always hidden, and the log goes by the clipboard', async () => {
            const { el, calls, fire } = fakePage(settings, { hash: link(details) })
            el['fb-message'].value = 'It stopped'
            await fire('fb-github', 'click')
            const [[url, target, features]] = calls.opened
            assert.deepEqual([target, features], ['_blank', 'noopener'])
            const opened = new URL(url)
            assert.equal(`${opened.origin}${opened.pathname}`, `https://github.com/${s.publicRepo}/issues/new`)
            assert.equal(opened.searchParams.get('template'), 'problem.yml')
            assert.equal(opened.searchParams.get('what-happened'), 'It stopped')
            assert.equal(opened.searchParams.get('version'), '0.0.6, Chrome 142, macOS')
            assert.deepEqual(ids(opened.searchParams.get('status')), [])
            assert.equal(calls.copied.length, 1)
            assert.deepEqual(ids(calls.copied[0]), [])
            assert.match(el['fb-status'].textContent, /The log is on your clipboard/)
            // the private box still shows the ids, as the person left it
            assert.deepEqual(ids(el['fb-details-text'].textContent), ['#111', '#111', '#222'])
        })

        test(`without a clipboard, the box opens with ${s.ids} ids hidden, to copy the log by hand`, async () => {
            const { el, box, calls, fire } = fakePage(settings, { hash: link(details), clipboard: false })
            await fire('fb-github', 'click')
            assert.equal(calls.opened.length, 1)
            assert.equal(el['fb-hide-ids'].checked, true)
            assert.equal(box.open, true)
            assert.deepEqual(ids(el['fb-details-text'].textContent), [])
            assert.equal(el['fb-status'].textContent, `GitHub opened in a new tab. To add the log, copy it from the box above, where ${s.ids} ids are now hidden.`)
        })

        test('with no details, or the details left out, the public issue carries only the message', async () => {
            const bare = fakePage(settings)
            bare.el['fb-message'].value = 'An idea'
            await bare.fire('fb-github', 'click')
            const opened = new URL(bare.calls.opened[0][0])
            assert.deepEqual([...opened.searchParams.keys()], ['template', 'what-happened'])
            assert.equal(bare.calls.copied.length, 0)
            assert.equal(bare.el['fb-status'].textContent, 'GitHub opened in a new tab.')

            const left = fakePage(settings, { hash: link(details) })
            left.el['fb-include'].checked = false
            await left.fire('fb-github', 'click')
            assert.deepEqual([...new URL(left.calls.opened[0][0]).searchParams.keys()], ['template'])
            assert.equal(left.calls.copied.length, 0)
        })
    })
}

test('the report page has every element the script uses, and gives its form the settings', { skip: !fs.existsSync(PAGE) && 'no report page here' }, () => {
    const page = fs.readFileSync(PAGE, 'utf8')
    for (const id of PAGE_IDS) assert.match(page, new RegExp(`\\bid="${id}"`), `src/pages/feedback.astro has no element with id="${id}"`)
    // the hint and the details box start hidden: the script shows one of them
    assert.match(page, /<[^>]*\bid="fb-from-extension"[^>]*\shidden[\s>]/)
    assert.match(page, /<[^>]*\bid="fb-details"[^>]*\shidden[\s>]/)
    assert.match(page, /<button type="submit"/)
    assert.match(page, /<form [^>]*\bid="fb-form"[^>]*\sdata-settings=\{JSON\.stringify\(formSettings\(/)
    assert.match(page, /import \{ startReportForm \} from '\.\.\/lib\/feedback-form\.js'\s+startReportForm\(\)/)
})
