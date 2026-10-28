import { HttpTransportError } from './http-error.js';
import { MAX_RESPONSE_BYTES, validResponseLimit } from './limits.js';

/** Decode an explicitly supplied HTML document; no network or browser execution. */
export function decodeHtmlBytes(bytes: Uint8Array, maxBytes = MAX_RESPONSE_BYTES, contentType?: string): string {
    if (!validResponseLimit(maxBytes)) throw new TypeError('Invalid HTML size limit.');
    if (bytes.byteLength > maxBytes)
        throw new HttpTransportError('RESPONSE_TOO_LARGE', 'El HTML excede el límite de tamaño.');
    const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString('latin1');
    const declared =
        contentType?.match(/charset\s*=\s*["']?([a-zA-Z0-9._-]+)/i)?.[1] ??
        prefix.match(/<meta\b[^>]{0,512}\bcharset\s*=\s*["']?([a-zA-Z0-9._-]+)/i)?.[1];
    let decoder: TextDecoder;
    try {
        decoder = new TextDecoder(declared ?? 'utf-8', { fatal: true });
    } catch {
        throw new HttpTransportError('UNSUPPORTED_CHARSET', 'La codificación del HTML no está admitida.');
    }
    let html: string;
    try {
        html = decoder.decode(bytes);
    } catch {
        throw new HttpTransportError('INVALID_TEXT_ENCODING', 'El HTML contiene bytes inválidos para su codificación.');
    }
    if (Buffer.byteLength(html, 'utf8') > maxBytes)
        throw new HttpTransportError('RESPONSE_TOO_LARGE', 'El HTML decodificado excede el límite de tamaño.');
    return html;
}
