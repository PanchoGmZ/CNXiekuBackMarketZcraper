import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { decodeHtmlBytes } from './html-bytes.js';
import { HttpTransportError } from './http-error.js';
import { MAX_HEADER_BYTES, validResponseLimit } from './limits.js';
import { limitsForTarget, type ProductResponse, RequestTimeout, type SingleRequest } from './request.js';
import { PolicyError, rejectRedirect, validateProductUrl, validateResolvedAddresses } from './url-policy.js';

export type PinnedHttpsOptions = RequestOptions & { autoSelectFamily: false; ALPNProtocols: string[] };
export type HttpsRequester = (
    url: URL,
    options: PinnedHttpsOptions,
    callback: (response: IncomingMessage) => void,
) => ClientRequest;
function normalizeError(error: unknown, status: number | null): Error {
    if (error instanceof PolicyError || error instanceof RequestTimeout) return error;
    if (error instanceof HttpTransportError)
        return new HttpTransportError(error.code, error.message, error.httpStatus ?? status);
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))
        return new RequestTimeout('Se agotó el tiempo de la solicitud.');
    if (code === 'HPE_HEADER_OVERFLOW')
        return new HttpTransportError(
            'RESPONSE_HEADERS_TOO_LARGE',
            'Los encabezados exceden el límite permitido.',
            status,
        );
    if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code))
        return new HttpTransportError('TLS_ERROR', 'No se pudo verificar la conexión TLS.', status);
    return new HttpTransportError('NETWORK_ERROR', 'La conexión no pudo completarse.', status);
}
function comparableAddress(address: string): string {
    if (address.startsWith('::ffff:') && address.slice(7).includes('.')) return address.slice(7);
    return address.includes(':') ? new URL(`http://[${address}]/`).hostname : address;
}
function responseHeaders(response: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const name of [
        'content-type',
        'content-encoding',
        'content-length',
        'location',
        'retry-after',
        'cf-mitigated',
    ]) {
        const value = response.headers[name];
        if (typeof value === 'string') headers[name] = value;
    }
    return headers;
}
/** Native HTTPS only. Production scheduling must pass the authorization gate in real-request.ts. */
export function createHttpsTransport(
    requester: HttpsRequester = httpsRequest,
    responseKind: 'html' | 'cnxieku-static-script' | 'cnxieku-json' = 'html',
): (request: SingleRequest) => Promise<ProductResponse> {
    return async (input) => {
        const target = validateProductUrl(input.url);
        if (responseKind !== 'html' && target.hostname !== 'www.cnxieku.com')
            throw new PolicyError('INVALID_REQUEST_POLICY', 'El transporte de datos CNXieku exige su dominio exacto.');
        let mimeTypes = ['text/html', 'application/xhtml+xml'];
        if (responseKind === 'cnxieku-static-script') mimeTypes = ['text/javascript', 'application/javascript'];
        else if (responseKind === 'cnxieku-json') mimeTypes = ['application/json'];
        const pin = Object.freeze({ ...validateResolvedAddresses([input.pinnedAddress]) });
        if (
            target.hostname !== input.hostname ||
            input.method !== 'GET' ||
            input.redirect !== 'manual' ||
            Object.entries(limitsForTarget(target)).some(
                ([key, value]) => input.limits[key as keyof SingleRequest['limits']] !== value,
            ) ||
            !Number.isInteger(input.timeoutSecs) ||
            input.timeoutSecs < 1 ||
            input.timeoutSecs > 60 ||
            !validResponseLimit(input.maxResponseBytes)
        ) {
            throw new PolicyError('INVALID_REQUEST_POLICY', 'La solicitud no cumple la política de un producto.');
        }
        if (input.signal.aborted) throw new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.');
        return new Promise<ProductResponse>((resolve, reject) => {
            let request: ClientRequest | undefined;
            let response: IncomingMessage | undefined;
            let status: number | null = null;
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abort: () => void = () => undefined;
            const cleanup = (): void => {
                if (timer) clearTimeout(timer);
                input.signal.removeEventListener('abort', abort);
            };
            const fail = (error: unknown): void => {
                if (settled) return;
                settled = true;
                cleanup();
                response?.destroy();
                request?.destroy();
                reject(normalizeError(error, status));
            };
            const finish = (result: ProductResponse): void => {
                if (settled) return;
                settled = true;
                cleanup();
                response?.destroy();
                request?.destroy();
                resolve(result);
            };
            abort = (): void => fail(new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.'));
            input.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(
                () => fail(new RequestTimeout('Se agotó el tiempo de la solicitud.')),
                input.timeoutSecs * 1000,
            );
            const lookup: LookupFunction = (hostname, options, callback) => {
                if (hostname !== target.hostname) {
                    callback(new Error('Unexpected lookup host'), '', pin.family);
                    return;
                }
                if (options.all) callback(null, [pin]);
                else callback(null, pin.address, pin.family);
            };
            const consume = async (incoming: IncomingMessage): Promise<void> => {
                if (settled || input.signal.aborted) {
                    incoming.destroy();
                    return;
                }
                response = incoming;
                status = incoming.statusCode ?? null;
                if (!status || status < 100 || status > 599)
                    throw new HttpTransportError('INVALID_RESPONSE', 'La respuesta HTTP es inválida.');
                const socket = incoming.socket as TLSSocket;
                if (socket.authorized !== true)
                    throw new HttpTransportError('TLS_ERROR', 'La conexión TLS no está verificada.', status);
                if (
                    !socket.remoteAddress ||
                    comparableAddress(socket.remoteAddress) !== comparableAddress(pin.address)
                ) {
                    throw new HttpTransportError(
                        'UNSAFE_ADDRESS',
                        'La conexión no corresponde a la dirección pública validada.',
                        status,
                    );
                }
                if (incoming.rawHeaders.length > 128)
                    throw new HttpTransportError(
                        'RESPONSE_HEADERS_TOO_LARGE',
                        'La respuesta contiene demasiados encabezados.',
                        status,
                    );
                const headers = responseHeaders(incoming);
                if (status >= 300 && status < 400) {
                    // Return only headers for Back Market. The operation validates each Location before DNS.
                    if (limitsForTarget(target).maxRedirects > 0) {
                        finish({ statusCode: status, headers, body: null });
                        return;
                    }
                    try {
                        rejectRedirect(headers.location, target);
                    } catch (error) {
                        if (error instanceof PolicyError)
                            throw new HttpTransportError(error.code, error.message, status);
                        throw error;
                    }
                }
                // Do not download protected, rate-limited, not-found or HTTP-error bodies.
                if (status < 200 || status >= 300 || headers['cf-mitigated'] === 'challenge') {
                    finish({ statusCode: status, headers, body: null });
                    return;
                }
                const mime = headers['content-type']?.split(';')[0].trim().toLowerCase();
                if (!mime || !mimeTypes.includes(mime)) {
                    throw new HttpTransportError(
                        'UNSUPPORTED_CONTENT_TYPE',
                        'La respuesta no declara HTML admitido.',
                        status,
                    );
                }
                const length = headers['content-length'];
                if (length && (!/^\d+$/.test(length) || Number(length) > input.maxResponseBytes)) {
                    throw new HttpTransportError(
                        'RESPONSE_TOO_LARGE',
                        'La respuesta excede el límite de tamaño.',
                        status,
                    );
                }
                const encoding = (headers['content-encoding'] ?? 'identity').trim().toLowerCase();
                let decoder: Transform;
                if (encoding === 'gzip') decoder = createGunzip();
                else if (encoding === 'br') decoder = createBrotliDecompress();
                else if (encoding === 'deflate') decoder = createInflate();
                else if (encoding === 'identity') decoder = new PassThrough();
                else
                    throw new HttpTransportError(
                        'UNSUPPORTED_CONTENT_ENCODING',
                        'La compresión de la respuesta no está admitida.',
                        status,
                    );
                let wireBytes = 0;
                let bodyBytes = 0;
                const chunks: Buffer[] = [];
                const wire = new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        wireBytes += chunk.length;
                        if (wireBytes > input.maxResponseBytes)
                            callback(
                                new HttpTransportError(
                                    'RESPONSE_TOO_LARGE',
                                    'La descarga excede el límite de tamaño.',
                                    status,
                                ),
                            );
                        else callback(null, chunk);
                    },
                });
                const sink = new Writable({
                    write(chunk: Buffer, _encoding, callback) {
                        bodyBytes += chunk.length;
                        if (bodyBytes > input.maxResponseBytes)
                            callback(
                                new HttpTransportError(
                                    'RESPONSE_TOO_LARGE',
                                    'El contenido descomprimido excede el límite de tamaño.',
                                    status,
                                ),
                            );
                        else {
                            chunks.push(Buffer.from(chunk));
                            callback();
                        }
                    },
                });
                await pipeline(incoming, wire, decoder, sink, { signal: input.signal });
                if (settled) return;
                if (!incoming.complete)
                    throw new HttpTransportError(
                        'INCOMPLETE_RESPONSE',
                        'La respuesta HTTP terminó incompleta.',
                        status,
                    );
                const body = decodeHtmlBytes(
                    Buffer.concat(chunks, bodyBytes),
                    input.maxResponseBytes,
                    headers['content-type'],
                );
                finish({ statusCode: status, headers, body });
            };
            try {
                request = requester(
                    new URL(target.url),
                    {
                        method: 'GET',
                        port: 443,
                        family: pin.family,
                        lookup,
                        autoSelectFamily: false,
                        agent: false,
                        rejectUnauthorized: true,
                        checkServerIdentity,
                        servername: target.hostname,
                        minVersion: 'TLSv1.2',
                        ALPNProtocols: ['http/1.1'],
                        maxHeaderSize: MAX_HEADER_BYTES,
                        signal: input.signal,
                        headers: {
                            'user-agent': 'TU-CUMPA-Product-Scrapers/0.0.1',
                            accept: mimeTypes.join(', '),
                            'accept-encoding': 'gzip, br, deflate',
                            connection: 'close',
                        },
                    },
                    (incoming) => {
                        void consume(incoming).catch(fail);
                    },
                );
                request.on('error', fail);
                request.on('upgrade', (_incoming, socket) => {
                    socket.destroy();
                    fail(new HttpTransportError('UNEXPECTED_UPGRADE', 'No se admiten cambios de protocolo HTTP.'));
                });
                if (settled) request.destroy();
                else request.end();
            } catch (error) {
                fail(error);
            }
        });
    };
}
