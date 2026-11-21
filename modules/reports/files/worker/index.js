// Synced from the shared source (see shared.json): change it there, not here.
//
// The site's Worker, the deploy config's entrypoint: the report form's handler
// and the inbox at /api/feedback (src/lib/report-worker.js), and Limits, the
// Durable Object that counts the site's reports. Every report from anywhere
// asks this same object, one at a time, so its counts are never stale the way
// KV's can be at each Cloudflare location. It keeps only the current hour's
// counts, as salted hashes of senders, and an alarm drops them within two
// hours. Cloudflare's runtime only: node's tests load report-worker.js and
// report-counts.js instead.
import { DurableObject } from 'cloudflare:workers'
import shared from '../shared.json' with { type: 'json' }
import { admitCounts, hourOf } from '../src/lib/report-counts.js'
import { reportsWorker } from '../src/lib/report-worker.js'

const settings = shared.modules.reports

export default reportsWorker(settings)

export class Limits extends DurableObject {
    async admit(sender) {
        const hour = hourOf()
        const { counts, ok, why, file } = admitCounts(await this.ctx.storage.get('counts'), sender, hour, settings.caps)
        if (ok) {
            await this.ctx.storage.put('counts', counts)
            await this.ctx.storage.setAlarm((hour + 2) * 3600000)
        }
        return { ok, why, file }
    }

    async alarm() {
        await this.ctx.storage.deleteAll()
    }
}
