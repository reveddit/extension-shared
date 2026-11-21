// Synced from the shared source (see shared.json): change it there, not here.
//
// The report page's script, which the page's <script> starts with
// startReportForm(). The extension's "Report a problem" link carries details
// after #r= (its report.ts): the version, browser, status summary and
// diagnostic log. They never leave the page unless the person sends them:
// privately to /api/feedback (feedback-handler.js), or in their own public
// GitHub issue.
//
// The page has the elements PAGE_IDS names, and its form carries what
// formSettings gives (report-settings.js) in its data-settings.
import { idHider, readDetails } from './report.js'

// The elements the page has, by id. fb-from-extension is the hint shown when no
// details came: a visit that didn't come from the extension, or a browser that
// kept them back.
export const PAGE_IDS = [
    'fb-from-extension',
    'fb-form',
    'fb-type',
    'fb-message',
    'fb-details',
    'fb-include',
    'fb-details-line',
    'fb-hide-ids',
    'fb-details-text',
    'fb-username',
    'fb-email',
    'fb-website',
    'fb-github',
    'fb-status',
]

/**
 * Starts the form on the page.
 * @param {any} page the window (its document, location, history, navigator, fetch and open), or a stand-in for one
 */
export function startReportForm(page = globalThis) {
    const { document, location, history } = page
    const $ = id => document.getElementById(id)
    const form = $('fb-form')
    const s = JSON.parse(form.dataset.settings)
    const issues = `https://github.com/${s.publicRepo}/issues/new`

    const details = readDetails(location.hash)
    // Out of the address bar and the history, so the log doesn't linger there.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    // The same stand-ins for this report wherever its ids are hidden: in a
    // private report the person chose to hide them in, and always in a public one.
    const hide = idHider()
    const hidden = details && { ...details, s: hide(details.s), l: hide(details.l) }
    const status = $('fb-status')
    const type = $('fb-type')
    const include = $('fb-include')
    const hideIds = $('fb-hide-ids')
    const send = form.querySelector('button[type="submit"]')
    const sendLabel = send.textContent
    const say = (text, kind = '') => {
        status.textContent = text
        status.className = `fb-status ${kind}`.trim()
    }

    // what a private report would send, which the box shows
    const sending = () => (details && include.checked ? (hideIds.checked ? hidden : details) : null)
    const preview = () => {
        const d = hideIds.checked ? hidden : details
        if (d) $('fb-details-text').textContent = `${d.s}\n\n${d.l}`
    }
    if (details) {
        $('fb-details').hidden = false
        $('fb-details-line').textContent = `${s.product} ${details.v} · ${details.b}`
        preview()
        // the details come from the extension's "Report a problem"
        type.value = 'bug'
    } else {
        // no details: point the person at the extension's own button
        $('fb-from-extension').hidden = false
    }
    hideIds.addEventListener('change', preview)

    form.addEventListener('submit', async e => {
        e.preventDefault()
        say('')
        const message = $('fb-message').value.trim()
        if (!message) return say(s.messages.empty, 'err')
        send.disabled = true
        send.textContent = 'Sending…'
        try {
            const res = await page.fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: type.value,
                    message,
                    username: $('fb-username').value,
                    email: $('fb-email').value,
                    details: sending(),
                    website: $('fb-website').value,
                }),
            })
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed')
            say(s.messages.sent, 'ok')
            form.reset()
            preview()
            if (details) type.value = 'bug'
        } catch (err) {
            say(err instanceof Error && err.message !== 'Failed' ? err.message : 'Something went wrong. Try again?', 'err')
        } finally {
            send.disabled = false
            send.textContent = sendLabel
        }
    })

    // A public issue, filled in the same way. GitHub turns away very long
    // links, so the log goes by the clipboard (copied first: the new tab takes
    // the focus a copy needs).
    $('fb-github').addEventListener('click', async () => {
        const message = $('fb-message').value.trim()
        const d = details && include.checked ? hidden : null // public: ids always hidden
        const params = new URLSearchParams({ template: 'problem.yml' })
        if (message) params.set('what-happened', message.slice(0, 1500))
        if (d) {
            params.set('version', `${d.v}, ${d.b}`)
            params.set('status', d.s.slice(0, 1500))
        }
        let copied = false
        if (d?.l) {
            try {
                await page.navigator.clipboard.writeText(d.l)
                copied = true
            } catch {
                // no clipboard: show the copy with ids hidden, to copy by hand
                hideIds.checked = true
                preview()
                $('fb-details').querySelector('details').open = true
            }
        }
        page.open(`${issues}?${params}`, '_blank', 'noopener')
        say(
            copied
                ? 'GitHub opened in a new tab. The log is on your clipboard: paste it into the log box there.'
                : d
                  ? `GitHub opened in a new tab. To add the log, copy it from the box above, where ${s.ids} ids are now hidden.`
                  : 'GitHub opened in a new tab.',
            'ok',
        )
    })
}
