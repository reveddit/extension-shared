// Synced from the shared source (see shared.json): change it there, not here.
//
// The site's Worker, less its Durable Object (both in worker/index.js, which
// node can't load). The pages are static files that Cloudflare serves without
// it: the deploy config's runWorkerFirst sends only /api/* and the videos
// (/assets/*.mp4) here. /api/feedback is the report form's handler and the
// inbox (feedback-handler.js), with the site's one counter of reports, the
// Limits Durable Object. A video is sent in the parts a browser asks for
// (video-ranges.js), so it can be skipped through.
import { reportsHandler } from './feedback-handler.js'
import { isVideo, videoResponse } from './video-ranges.js'

/**
 * The Worker for one site, from its settings (shared.json's modules.reports).
 * @returns {{ fetch(request: Request, env: any, ctx: { waitUntil(p: Promise<any>): void }): Promise<Response> }}
 */
export function reportsWorker(settings) {
    const { post, inbox } = reportsHandler(settings)
    // The one counter for the whole site. When it can't be asked, the handler
    // turns the report away as the site's trouble, not the sender's.
    const siteCounter = env => ({ admit: sender => env.LIMITS.get(env.LIMITS.idFromName('site')).admit(sender) })
    return {
        async fetch(request, env, ctx) {
            const { pathname } = new URL(request.url)
            if (pathname === '/api/feedback') {
                if (request.method === 'POST') return post(request, env, { waitUntil: p => ctx.waitUntil(p), counter: siteCounter(env) })
                if (request.method === 'GET') return inbox(request, env)
                return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } })
            }
            if (isVideo(pathname)) return videoResponse(request, env.ASSETS)
            return new Response('Not found', { status: 404 })
        },
    }
}
