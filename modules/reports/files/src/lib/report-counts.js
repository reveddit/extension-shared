// Synced from the shared source (see shared.json): change it there, not here.
//
// How many reports a site takes in an hour, counted in one place for the whole
// site (the Limits Durable Object in worker/index.js), so the caps hold
// everywhere at once. Plain JS, so node's test runner checks it without
// Cloudflare's runtime.

export const hourOf = (t = Date.now()) => Math.floor(t / 3600000)

/**
 * One more report from `sender` in `hour`, if the caps allow it: perSender
 * from one sender (a salted hash of an address, or of an IPv6 /64),
 * keptPerHour from everyone together (a flood stops there, and the inbox
 * stays small), and filedPerHour filed as issues from everyone together (each
 * is an email to the developer and a run of the reports workflow; past it, a
 * report is still kept).
 * @param {{ hour: number, kept: number, filed: number, senders: Record<string, number> } | null | undefined} counts the hour's counts so far
 * @param {string} sender
 * @param {number} hour
 * @param {{ perSender: number, keptPerHour: number, filedPerHour: number }} caps shared.json's modules.reports.caps
 * @returns {{ counts: object, ok: boolean, why?: 'sender' | 'site', file: boolean }}
 */
export function admitCounts(counts, sender, hour, caps) {
    const c = counts && counts.hour === hour ? { ...counts, senders: { ...counts.senders } } : { hour, kept: 0, filed: 0, senders: {} }
    if ((c.senders[sender] || 0) >= caps.perSender) return { counts: c, ok: false, why: 'sender', file: false }
    if (c.kept >= caps.keptPerHour) return { counts: c, ok: false, why: 'site', file: false }
    c.senders[sender] = (c.senders[sender] || 0) + 1
    c.kept++
    const file = c.filed < caps.filedPerHour
    if (file) c.filed++
    return { counts: c, ok: true, file }
}
