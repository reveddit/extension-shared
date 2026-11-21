// Synced from the shared source (see shared.json): change it there, not here.
//
// The report form's handler (the report page posts to /api/feedback) and the
// inbox the developer reads reports in. A report is kept in KV and filed as an
// issue in the private reports repository, by that repository's workflow, so
// GitHub tells the developer about it. Each site's own entry calls this with
// its settings and its counter of reports:
//
//   const { post, inbox } = reportsHandler(shared.modules.reports)
//   post(request, env, { waitUntil, counter })   // POST: a report from the form
//   inbox(request, env)                          // GET: the inbox (?key=<FEEDBACK_KEY> once)
//
// counter.admit(sender) says whether one more report from `sender` (a salted
// hash of its address) fits the hour's caps: { ok, why, file }, where why is
// 'sender' or 'site' when it doesn't, and file says whether to file it as an
// issue as well as keep it. When it throws or answers nothing, the report is
// turned away as the site's trouble, not the sender's.
//
// env: FEEDBACK (KV, the reports as fb_*), FEEDBACK_KEY (the inbox's key and
// the counts' salt), and GITHUB_TOKEN (Actions read and write on the private
// repository only). Without the token a report is only kept.
import { checkedSettings, TYPES } from './report-settings.js'

// a report with the longest log the extension sends is about 30 KB
export const MAX_BODY_BYTES = 64 * 1024
// The private repository's workflow (.github/workflows/file-report.yml there)
// opens the issue. Opened with this token it would be the developer's own
// doing, and GitHub doesn't tell anyone about their own activity; opened by
// GitHub Actions and assigned to them, it reaches them. So the token needs
// only Actions: read and write, on that one repository.
const WORKFLOW = 'file-report.yml'
const LABELS = { bug: ['bug'], feature: ['enhancement'], question: ['question'] }
// a local preview of the site, which may send reports too
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

const text = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '')
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// An IPv6 sender usually holds a whole /64, and can pick a new address in it
// for each request, so the network's first half counts as the address
export function addressOf(ip) {
    if (!ip.includes(':')) return ip
    const [head, tail = ''] = ip.toLowerCase().split('::')
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    // an IPv4 address written as IPv6 (::ffff:203.0.113.9) is that IPv4 address
    const last = t.at(-1) ?? h.at(-1) ?? ''
    if (last.includes('.')) return last
    const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
    return `${groups
        .slice(0, 4)
        .map(g => g.replace(/^0+(?=.)/, ''))
        .join(':')}::/64`
}

// a code fence longer than any run of backticks in the text, so the text can't close it
export const fenced = t => {
    const fence = '`'.repeat(Math.max(3, ...[...t.matchAll(/`+/g)].map(m => m[0].length + 1)))
    return `${fence}text\n${t}\n${fence}`
}

// a short field as inline code, so it can't turn into a mention or a link either
const code = t => `\`${String(t).replace(/[`\n\r]/g, '')}\``

// The inbox's response headers
const PAGE_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // the first page's address carries the key: no link from it may pass that on
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

// The inbox's times as "5m ago", with the time itself on hover
const AGO_SCRIPT = `<script>
function prettyAgo(iso) {
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    var units = [[60,'s'],[60,'m'],[24,'h'],[7,'d'],[4.35,'w'],[12,'mo'],[Infinity,'y']];
    var t = s;
    for (var i = 0; i < units.length; i++) {
        if (t < units[i][0]) {
            var whole = Math.floor(t);
            var rem = i > 0 ? Math.round((t - whole) * units[i-1][0]) : 0;
            if (i > 0 && rem === units[i-1][0]) { whole++; rem = 0; }
            var str = whole + units[i][1];
            if (i >= 2 && rem > 0) str += ' ' + rem + units[i-1][1];
            return str + ' ago';
        }
        t = t / units[i][0];
    }
    return 'just now';
}
document.querySelectorAll('.time').forEach(function(el) {
    var iso = el.dataset.ts;
    if (isNaN(new Date(iso).getTime())) return;
    el.title = new Date(iso).toLocaleString();
    el.textContent = prettyAgo(iso);
});
</script>`

const hexOf = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
const digestOf = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))

// Whether two secrets are the same, in the same time wherever they differ
async function sameSecret(a, b) {
    const [x, y] = (await Promise.all([digestOf(a), digestOf(b)])).map(d => new Uint8Array(d))
    let diff = 0
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
    return diff === 0
}

// The inbox's cookie. It holds a hash of the key, not the key, goes back only to
// the inbox's address, and comes only from a page on this site (SameSite=Strict),
// so another site's link can't mark or delete anything.
const SESSION_COOKIE = 'inbox'
const SESSION_SECONDS = 30 * 24 * 60 * 60
const sessionOf = async key => hexOf(await digestOf(`inbox session|${key}`))
const cookieIn = (request, name) => {
    for (const part of (request.headers.get('Cookie') || '').split(';')) {
        const [k, ...v] = part.trim().split('=')
        if (k === name) return v.join('=')
    }
    return ''
}

/**
 * The handler for one site, from its settings (shared.json's modules.reports).
 * Wrong settings throw here, before any report is taken.
 */
export function reportsHandler(settings) {
    const s = checkedSettings(settings)
    const site = new URL(s.origin).host
    // Only the form on this site sends reports. A browser always names the page a
    // POST comes from, so a page elsewhere can't send them for its visitors.
    const fromTheForm = origin => origin === s.origin || LOCAL.test(origin)
    const userAgent = `${s.product.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-feedback`

    // Who sent it, for the hourly count: a salted hash of the address (or its
    // IPv6 /64), never the address itself. A request without one is still
    // counted, as one sender.
    async function senderOf(request, env) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.FEEDBACK_KEY || ''}|${addressOf(ip)}`))
        return [...new Uint8Array(digest)]
            .slice(0, 8)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
    }

    function issueFor(key, e) {
        const name = s.typeNames[e.type] || s.typeNames.other
        const first = e.message.split('\n')[0]
        const title = `${name}: ${first.length > 70 ? `${first.slice(0, 69)}…` : first}`
        const who = [e.username && `${s.userLabel}: ${code(e.username)}`, e.email && `email: ${code(e.email)}`].filter(Boolean).join(' · ')
        const body = [
            // the person's own words, fenced, so nothing in them turns into a mention or a link
            fenced(e.message),
            '',
            `**${name}**${who ? ` · ${who}` : ''}`,
            ...(e.details
                ? ['', `**${s.product}** ${code(e.details.v)} · ${code(e.details.b)}`, '', fenced(e.details.s), '', '<details><summary>Diagnostic log</summary>', '', fenced(e.details.l), '', '</details>']
                : []),
            '',
            `<sub>Report ${key}</sub>`,
        ].join('\n')
        return { title, body, labels: (LABELS[e.type] || []).join(',') }
    }

    async function fileIssue(env, key, e) {
        try {
            const res = await fetch(`https://api.github.com/repos/${s.privateRepo}/actions/workflows/${WORKFLOW}/dispatches`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': userAgent,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ref: 'main', inputs: issueFor(key, e) }),
            })
            if (!res.ok) {
                console.error('feedback: GitHub issue not filed', res.status, await res.text().catch(() => ''))
                return
            }
            // the inbox links to it (the issue's text ends with this report's key)
            e.filed = true
            await env.FEEDBACK.put(key, JSON.stringify(e))
        } catch (err) {
            console.error('feedback: GitHub issue not filed', err)
        }
    }

    async function post(request, env, { waitUntil, counter }) {
        if (!fromTheForm(request.headers.get('Origin') || '')) return json({ error: `Reports come from the form on ${site}.` }, 403)
        if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return json({ error: 'That report is too long.' }, 413)
        let body
        try {
            const raw = await request.text()
            if (raw.length > MAX_BODY_BYTES) return json({ error: 'That report is too long.' }, 413)
            body = JSON.parse(raw)
        } catch {
            return json({ error: 'Invalid JSON' }, 400)
        }

        const { type, message, username, email, details, website } = body || {}
        if (!message || typeof message !== 'string' || !message.trim()) return json({ error: s.messages.empty }, 400)
        // a hidden field people leave empty and bots fill in: thank them, keep nothing
        if (website) return json({ ok: true })
        // the site's counter says whether to keep it, and whether to file it
        let admitted = null
        try {
            admitted = await counter.admit(await senderOf(request, env))
        } catch (err) {
            console.error('feedback: report counter unavailable', err)
        }
        if (!admitted) return json({ error: "Reports can't be taken right now. Please try again later." }, 503)
        if (!admitted.ok)
            return json(
                { error: admitted.why === 'sender' ? 'Several reports came from here in the last hour. Please try again later.' : 'Many reports came in this hour. Please try again later.' },
                429,
            )

        const entry = {
            type: TYPES.includes(type) ? type : 'other',
            message: message.trim().slice(0, 5000),
            username: text(username, 100).trim(),
            email: text(email, 200).trim(),
            ts: new Date().toISOString(),
            // what the extension's "Report a problem" link brought along, if the person kept it
            ...(details && typeof details === 'object'
                ? { details: { v: text(details.v, 40), b: text(details.b, 80), s: text(details.s, 3000), l: text(details.l, 20000) } }
                : {}),
        }

        const key = `fb_${entry.ts}_${crypto.randomUUID().slice(0, 8)}`
        await env.FEEDBACK.put(key, JSON.stringify(entry))
        // After the answer, so the person isn't kept waiting
        if (admitted.file && env.GITHUB_TOKEN) waitUntil(fileIssue(env, key, entry))
        return json({ ok: true })
    }

    // --- the inbox: /api/feedback ---
    // The key comes once, in a bookmark's address (?key=<FEEDBACK_KEY>). The page it
    // opens sets the cookie and takes the key out of the address, so it stays out of
    // later addresses, links and request logs. Any action in that first address is
    // left undone.

    async function inbox(request, env) {
        const url = new URL(request.url)
        const denied = () => new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } })
        if (!env.FEEDBACK_KEY) return denied()
        const session = await sessionOf(env.FEEDBACK_KEY)
        const key = url.searchParams.get('key')
        if (key !== null) {
            if (!(await sameSecret(key, env.FEEDBACK_KEY))) return denied()
            const page = await inboxPage(env)
            const headers = new Headers(page.headers)
            headers.set('Set-Cookie', `${SESSION_COOKIE}=${session}; Path=${url.pathname}; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`)
            return new Response(page.body, { headers })
        }
        if (!(await sameSecret(cookieIn(request, SESSION_COOKIE), session))) return denied()

        const action = url.searchParams.get('action')
        const id = url.searchParams.get('id')
        const back = () => new Response(null, { status: 302, headers: { Location: url.pathname, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } })
        // only reports: never the counts or anything else in KV
        if (action === 'delete' && id?.startsWith('fb_')) {
            await env.FEEDBACK.delete(id)
            return back()
        }
        if (action === 'read' && id?.startsWith('fb_')) {
            const raw = await env.FEEDBACK.get(id)
            if (raw) {
                const entry = JSON.parse(raw)
                entry.read = !entry.read
                await env.FEEDBACK.put(id, JSON.stringify(entry))
            }
            return back()
        }
        if (action === 'clear-read') {
            const list = await env.FEEDBACK.list({ prefix: 'fb_' })
            for (const k of list.keys) {
                const raw = await env.FEEDBACK.get(k.name)
                if (raw && JSON.parse(raw).read) await env.FEEDBACK.delete(k.name)
            }
            return back()
        }
        return inboxPage(env)
    }

    async function inboxPage(env) {
        const list = await env.FEEDBACK.list({ prefix: 'fb_' })
        const entries = (
            await Promise.all(
                list.keys.map(async k => {
                    const raw = await env.FEEDBACK.get(k.name)
                    return raw ? { id: k.name, ...JSON.parse(raw) } : null
                }),
            )
        ).filter(Boolean)
        entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
        const unread = entries.filter(e => !e.read).length
        const title = `${esc(s.product)} reports`
        const html = `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title>
<style>
body { font-family: system-ui; max-width: 760px; margin: 2rem auto; padding: 0 1rem; background: #000; color: #e7e9ea; }
h1 { font-size: 1.4rem; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 1rem; }
.count { font-size: 0.9rem; color: #71767b; }
.entry { border: 1px solid #2f3336; border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
.entry.read { opacity: 0.45; }
.meta { font-size: 0.85rem; color: #71767b; margin-bottom: 4px; }
.time { cursor: default; border-bottom: 1px dotted #536471; }
.msg { white-space: pre-wrap; margin-top: 6px; }
.badge { display: inline-block; background: ${s.accent}; color: #fff; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; }
.actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.btn { font: inherit; font-size: 0.78rem; padding: 4px 12px; border-radius: 999px; border: 1px solid #536471; background: #16181c; color: #e7e9ea; text-decoration: none; }
.btn:hover { background: #2f3336; }
.det { margin-top: 12px; font-size: 0.85rem; color: #aab; }
.det pre { white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; background: #16181c; padding: 8px; border-radius: 6px; }
</style>
</head><body>
<h1>${title}</h1>
<div class="toolbar">
    <span class="count">${entries.length} total · ${unread} unread</span>
    ${entries.some(e => e.read) ? `<a class="btn" href="?action=clear-read" onclick="return confirm('Delete all read reports?')">Delete read</a>` : ''}
</div>
${entries
    .map(
        e => `<div class="entry${e.read ? ' read' : ''}">
<div class="meta"><span class="badge">${esc(e.type)}</span> <span class="time" data-ts="${esc(e.ts)}">${esc(e.ts)}</span>${e.username ? ` · ${esc(e.username)}` : ''}${e.email ? ` · ${esc(e.email)}` : ''}</div>
<div class="msg">${esc(e.message)}</div>
${e.details ? `<details class="det"><summary>${esc(s.product)} ${esc(e.details.v)} · ${esc(e.details.b)}</summary><pre>${esc(e.details.s)}\n\n${esc(e.details.l)}</pre></details>` : ''}
<div class="actions">
    ${e.filed ? `<a class="btn" rel="noreferrer" href="https://github.com/${esc(s.privateRepo)}/issues?q=${encodeURIComponent(e.id)}">GitHub issue</a>` : ''}
    <a class="btn" href="?action=read&id=${encodeURIComponent(e.id)}">${e.read ? 'Mark unread' : 'Mark read'}</a>
    <a class="btn" href="?action=delete&id=${encodeURIComponent(e.id)}" onclick="return confirm('Delete this report?')">Delete</a>
</div>
</div>`,
    )
    .join('\n')}
${entries.length === 0 ? '<p style="color:#71767b">No reports yet.</p>' : ''}
${AGO_SCRIPT}
<script>if (location.search) history.replaceState(null, '', location.pathname)</script>
</body></html>`
        return new Response(html, { headers: PAGE_HEADERS })
    }

    return { post, inbox, issueFor, senderOf }
}
