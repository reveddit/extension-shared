// Synced from the shared source (see shared.json): change it there, not here.
//
// The site's videos, sent in the parts a browser asks for (video-ranges.js),
// from a stand-in for the site's static files that answers as Cloudflare's do:
// every file whole, whatever Range asks, here in small chunks so ranges cross
// them.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideo, parseRange, videoResponse } from '../src/lib/video-ranges.js'

const FILE = Uint8Array.from({ length: 100 }, (_, i) => i)
const URL_ = 'https://example.com/assets/intro.mp4'

function fakeAssets({ file = FILE, chunk = 7, headers = {} } = {}) {
    const assets = {
        asked: [],
        chunksRead: 0,
        async fetch(request) {
            assets.asked.push(request)
            if (!new URL(request.url).pathname.endsWith('.mp4')) return new Response('Not found', { status: 404 })
            const h = new Headers({ 'Content-Type': 'video/mp4', 'Content-Length': String(file.byteLength), ETag: '"v1"', 'Cache-Control': 'public, max-age=0, must-revalidate' })
            for (const [k, v] of Object.entries(headers)) (v === null ? h.delete(k) : h.set(k, v))
            // Cloudflare's answer to a HEAD has no length
            if (request.method === 'HEAD') {
                h.delete('Content-Length')
                return new Response(null, { headers: h })
            }
            let at = 0
            // no reading ahead, so chunksRead counts only what was asked for
            const body = new ReadableStream(
                {
                    pull(controller) {
                        if (at >= file.byteLength) return controller.close()
                        controller.enqueue(file.slice(at, at + chunk))
                        assets.chunksRead++
                        at += chunk
                    },
                },
                { highWaterMark: 0 },
            )
            return new Response(body, { headers: h })
        },
    }
    return assets
}

const ask = (range, init = {}) => new Request(URL_, { ...init, headers: { ...(range ? { Range: range } : {}), ...init.headers } })
const bytesOf = async res => [...new Uint8Array(await res.arrayBuffer())]
const span = (from, to) => [...FILE.slice(from, to + 1)]

describe('which paths are videos', () => {
    test('a .mp4 under /assets/, as the deploy config sends them', () => {
        assert.equal(isVideo('/assets/intro.mp4'), true)
        assert.equal(isVideo('/assets/videos/intro.mp4'), true)
        for (const p of ['/intro.mp4', '/assets/intro.mp4.txt', '/assets/poster.jpg', '/api/feedback']) assert.equal(isVideo(p), false, p)
    })
})

describe('reading a Range header', () => {
    test('one range of bytes, from either end', () => {
        assert.deepEqual(parseRange('bytes=0-1', 100), { start: 0, end: 1 })
        assert.deepEqual(parseRange('bytes=40-', 100), { start: 40, end: 99 })
        assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
        assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 })
        assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 })
        assert.deepEqual(parseRange('BYTES=5-5', 100), { start: 5, end: 5 })
    })

    test('a range past the end is unsatisfiable', () => {
        assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
        assert.equal(parseRange('bytes=100-200', 100), 'unsatisfiable')
        assert.equal(parseRange('bytes=-0', 100), 'unsatisfiable')
        assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable')
    })

    test('anything else means the whole file', () => {
        for (const h of [null, '', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=0-1,5-6', 'items=0-1', 'bytes=a-b', 'bytes 0-1']) {
            assert.equal(parseRange(h, 100), null, String(h))
        }
    })
})

describe('answering for a video', () => {
    test('with no Range, the whole file as Cloudflare sends it, saying ranges work', async () => {
        const assets = fakeAssets()
        const res = await videoResponse(ask(), assets)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
        assert.equal(res.headers.get('ETag'), '"v1"')
        assert.deepEqual(await bytesOf(res), span(0, 99))
    })

    test('the first two bytes, as Safari asks first', async () => {
        const assets = fakeAssets()
        const res = await videoResponse(ask('bytes=0-1'), assets)
        assert.equal(res.status, 206)
        assert.equal(res.headers.get('Content-Range'), 'bytes 0-1/100')
        assert.equal(res.headers.get('Content-Length'), '2')
        assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
        assert.equal(res.headers.get('Content-Type'), 'video/mp4')
        assert.equal(res.headers.get('ETag'), '"v1"')
        assert.deepEqual(await bytesOf(res), [0, 1])
        // the file was asked for whole, without Range, so it kept its usual headers
        assert.equal(assets.asked[0].headers.get('Range'), null)
        assert.equal(res.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate')
        // and only as much of it was read as the range needed
        assert.ok(assets.chunksRead <= 2, `read ${assets.chunksRead} chunks`)
    })

    test('a range across chunks, from the middle to the end, and the last bytes', async () => {
        for (const [range, from, to] of [
            ['bytes=10-29', 10, 29],
            ['bytes=64-', 64, 99],
            ['bytes=-5', 95, 99],
            ['bytes=90-500', 90, 99],
            ['bytes=0-', 0, 99],
            ['bytes=7-13', 7, 13],
        ]) {
            const res = await videoResponse(ask(range), fakeAssets())
            assert.equal(res.status, 206, range)
            assert.equal(res.headers.get('Content-Range'), `bytes ${from}-${to}/100`, range)
            assert.equal(res.headers.get('Content-Length'), String(to - from + 1), range)
            assert.deepEqual(await bytesOf(res), span(from, to), range)
        }
    })

    test('a range past the end gets 416 with the size, without reading the file', async () => {
        const assets = fakeAssets()
        const res = await videoResponse(ask('bytes=100-'), assets)
        assert.equal(res.status, 416)
        assert.equal(res.headers.get('Content-Range'), 'bytes */100')
        assert.equal(assets.chunksRead, 0)
    })

    test('several ranges, or one that makes no sense, get the whole file', async () => {
        for (const range of ['bytes=0-1,5-6', 'bytes=5-2', 'items=0-1']) {
            const res = await videoResponse(ask(range), fakeAssets())
            assert.equal(res.status, 200, range)
            assert.equal(res.headers.get('Accept-Ranges'), 'bytes', range)
            assert.deepEqual(await bytesOf(res), span(0, 99), range)
        }
    })

    test('If-Range: the part while the file is the same, the whole file once it has changed', async () => {
        const same = await videoResponse(ask('bytes=3-4', { headers: { 'If-Range': '"v1"' } }), fakeAssets())
        assert.equal(same.status, 206)
        assert.deepEqual(await bytesOf(same), [3, 4])
        for (const ifRange of ['"v0"', 'W/"v1"', 'Fri, 20 Nov 2026 00:00:00 GMT']) {
            const changed = await videoResponse(ask('bytes=3-4', { headers: { 'If-Range': ifRange } }), fakeAssets())
            assert.equal(changed.status, 200, ifRange)
            assert.deepEqual(await bytesOf(changed), span(0, 99), ifRange)
        }
    })

    test('HEAD with a range gets the part’s headers and no body, the length coming from a GET', async () => {
        const assets = fakeAssets()
        const res = await videoResponse(ask('bytes=10-19', { method: 'HEAD' }), assets)
        assert.equal(res.status, 206)
        assert.equal(res.headers.get('Content-Range'), 'bytes 10-19/100')
        assert.equal(res.headers.get('Content-Length'), '10')
        assert.equal(res.body, null)
        assert.equal(assets.asked[0].method, 'GET')
        // and a HEAD that gets the whole file gets no body either
        const whole = await videoResponse(ask('bytes=10-19', { method: 'HEAD', headers: { 'If-Range': '"v0"' } }), fakeAssets())
        assert.equal(whole.status, 200)
        assert.equal(whole.headers.get('Content-Length'), '100')
        assert.equal(whole.body, null)
    })

    test('a file sent without its length is read to find it', async () => {
        const res = await videoResponse(ask('bytes=50-52'), fakeAssets({ headers: { 'Content-Length': null } }))
        assert.equal(res.status, 206)
        assert.equal(res.headers.get('Content-Range'), 'bytes 50-52/100')
        assert.deepEqual(await bytesOf(res), [50, 51, 52])
    })

    test('a file sent encoded goes whole, since its length is not the file’s', async () => {
        const res = await videoResponse(ask('bytes=0-1'), fakeAssets({ headers: { 'Content-Encoding': 'gzip' } }))
        assert.equal(res.status, 200)
    })

    test('a missing video stays missing, and a conditional request without Range goes as it came', async () => {
        const missing = await videoResponse(new Request('https://example.com/assets/nope.mp4x', { headers: { Range: 'bytes=0-1' } }), fakeAssets())
        assert.equal(missing.status, 404)
        const assets = fakeAssets()
        await videoResponse(ask(null, { headers: { 'If-None-Match': '"v1"' } }), assets)
        assert.equal(assets.asked[0].headers.get('If-None-Match'), '"v1"')
    })
})
