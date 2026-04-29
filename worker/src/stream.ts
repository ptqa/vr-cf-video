import type { Env } from './types';

/**
 * Stream a video from R2, with HTTP range support so headsets can seek.
 *
 * Range requests use R2's native `{ offset, length }` reader so we never
 * buffer more than what the client asks for. Without a Range header we
 * return the whole object (also streamed — `R2ObjectBody.body` is a
 * ReadableStream).
 */
export async function streamVideo(filename: string, request: Request, env: Env): Promise<Response> {
  const key = `videos/${filename}`;
  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : undefined;

      const object = await env.BUCKET.get(key, {
        range:
          end !== undefined ? { offset: start, length: end - start + 1 } : { offset: start },
      });

      if (!object) {
        return new Response('Not found', { status: 404 });
      }

      const totalSize = object.size;
      const rangeEnd = end !== undefined ? end : totalSize - 1;
      const contentLength = rangeEnd - start + 1;

      return new Response(object.body, {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${rangeEnd}/${totalSize}`,
          'Content-Length': String(contentLength),
          'Accept-Ranges': 'bytes',
          // R2 keys are content-addressed by filename; treat as immutable.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
  }

  const object = await env.BUCKET.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(object.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
