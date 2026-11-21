// Synced from the shared source (see shared.json): change it there, not here.
//
// The site's videos, answered in part. Cloudflare serves a static file whole
// and ignores a request for part of one (Range), and Chrome and Edge then play
// a video as a live stream that can't be skipped through. So the deploy config
// sends the videos (/assets/*.mp4) to the Worker, which reads the file from the
// site's static files (the ASSETS binding) and sends only the bytes asked for:
// one range, the way browsers ask for a video's, or else the whole file.

/** A path the deploy config sends to the Worker as a video: /assets/*.mp4 */
export function isVideo(pathname) {
    return pathname.startsWith('/assets/') && pathname.endsWith('.mp4')
}

/**
 * What a Range header asks for in a file of `size` bytes: { start, end }
 * (`end` included), 'unsatisfiable' when none of its bytes exist, or null for
 * the whole file: no header, another unit, a header that doesn't parse, or more
 * than one range (a server may answer any of those whole).
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 */
export function parseRange(header, size) {
    const m = header && /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
    if (!m || (m[1] === '' && m[2] === '')) return null
    if (m[1] === '') {
        // the last n bytes
        const n = Number(m[2])
        return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(size - n, 0), end: size - 1 }
    }
    const start = Number(m[1])
    if (m[2] !== '' && Number(m[2]) < start) return null
    if (start >= size) return 'unsatisfiable'
    return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
}

/**
 * A GET or HEAD for a video, from the site's static files (`assets`, the ASSETS
 * binding): 206 with the range asked for, 416 for a range past the end, or the
 * file whole, as Cloudflare serves it. A whole file says ranges work.
 * @param {Request} request
 * @param {{ fetch(request: Request): Promise<Response> }} assets
 */
export async function videoResponse(request, assets) {
    const { method } = request
    const asked = request.headers.get('Range')
    if ((method !== 'GET' && method !== 'HEAD') || !asked) return rangesWork(await assets.fetch(request))
    // The whole file, asked for without Range, so it comes with its usual
    // headers (Cloudflare leaves Cache-Control off an answer to a Range
    // request), and by GET even for a HEAD, since only a GET's answer gives the
    // file's length. A body this doesn't send is left unread and dropped with
    // the request: Cloudflare's runtime won't cancel it.
    const file = await assets.fetch(new Request(request.url))
    const whole = (response = file) => rangesWork(method === 'HEAD' ? new Response(null, response) : response)
    const ifRange = request.headers.get('If-Range')
    // A file that's changed since the part the browser has, or one sent encoded
    // (whose length isn't the file's), goes whole
    if (file.status !== 200 || file.headers.has('Content-Encoding') || (ifRange && ifRange !== file.headers.get('ETag'))) return whole()
    let size = Number(file.headers.get('Content-Length') || NaN)
    let bytes = null
    if (!Number.isSafeInteger(size)) {
        // no length given: read the file to know it
        bytes = new Uint8Array(await file.arrayBuffer())
        size = bytes.byteLength
    }
    const range = parseRange(asked, size)
    if (range === null) return whole(bytes ? new Response(bytes, file) : file)
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } })
    const { start, end } = range
    const length = end - start + 1
    const headers = new Headers(file.headers)
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    headers.set('Content-Length', String(length))
    headers.set('Accept-Ranges', 'bytes')
    let body = null
    if (method === 'GET') body = bytes ? bytes.subarray(start, end + 1) : sized(start === 0 && end === size - 1 ? file.body : slice(file.body, start, end), length)
    return new Response(body, { status: 206, headers })
}

// The file whole, as Cloudflare answered, saying ranges work when it's there
function rangesWork(response) {
    if (response.status !== 200) return response
    const whole = new Response(response.body, response)
    whole.headers.set('Accept-Ranges', 'bytes')
    return whole
}

// The bytes from `start` to `end` (included) of a stream, which stops reading
// once it has them
function slice(stream, start, end) {
    let at = 0
    return stream.pipeThrough(
        new TransformStream({
            transform(chunk, controller) {
                const bytes = ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk)
                const from = at
                at += bytes.byteLength
                if (at > start && from <= end) controller.enqueue(bytes.subarray(Math.max(start - from, 0), Math.min(end + 1 - from, bytes.byteLength)))
                if (at > end) controller.terminate()
            },
        }),
    )
}

// Cloudflare's runtime sends a streamed body's length only through a
// FixedLengthStream. Node, which runs the tests, has none and needs none.
function sized(stream, length) {
    return typeof FixedLengthStream === 'function' ? stream.pipeThrough(new FixedLengthStream(length)) : stream
}
