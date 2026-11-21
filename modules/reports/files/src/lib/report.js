// Synced from the shared source (see shared.json): change it there, not here.
//
// The details the extension's "Report a problem" link carries (its report.ts),
// and hiding the ids in them. Plain JS, so the report page and node's test
// runner share it.

/**
 * @typedef {{ v: string, b: string, s: string, l: string }} Details
 * version, browser and system, status summary, diagnostic log
 */

/**
 * The details after `#r=` in the link: base64url JSON. Anything malformed is
 * null, and each field is capped as the form's handler caps it.
 * @param {string} hash location.hash
 * @returns {Details | null}
 */
export function readDetails(hash) {
    const m = /^#r=([A-Za-z0-9_-]+)$/.exec(hash)
    if (!m) return null
    try {
        const bin = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
        const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
        if (!d || typeof d !== 'object') return null
        const text = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '')
        return { v: text(d.v, 40), b: text(d.b, 80), s: text(d.s, 3000), l: text(d.l, 20000) }
    } catch {
        return null
    }
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const randomStandIn = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    // a letter first, so a stand-in can never be read as an id (#123) again
    return `#${LETTERS[bytes[0] % 26]}${Array.from(bytes.slice(1), b => (b % 36).toString(36)).join('')}`
}

/**
 * An id (#123) leads to whoever wrote what it names, and for your own posts
 * that's you. This swaps each for a random stand-in that stays the same
 * throughout one report, so the log still shows the same one coming up again
 * (seen at 10:05, gone at 14:00) without saying which it is.
 * @returns {(text: string) => string}
 */
export function idHider(makeStandIn = randomStandIn) {
    /** @type {Map<string, string>} */
    const standIns = new Map()
    const taken = new Set()
    return text =>
        text.replace(/#\d+/g, id => {
            let s = standIns.get(id)
            if (!s) {
                do s = makeStandIn()
                while (taken.has(s))
                standIns.set(id, s)
                taken.add(s)
            }
            return s
        })
}
