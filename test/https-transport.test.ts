import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';

import { HttpTransportError } from '../src/http-error.js';
import { createHttpsTransport, type HttpsRequester, type PinnedHttpsOptions } from '../src/https-transport.js';
import { createAuthorizedRequestDependencies, resolvePublicHostname } from '../src/real-request.js';
import { MAX_RESPONSE_BYTES } from '../src/limits.js';
import { limitsForTarget, requestLimits, RequestTimeout, type SingleRequest } from '../src/request.js';
import { processProduct } from '../src/process-product.js';
import { validateProductUrl } from '../src/url-policy.js';
import { productUrl } from './helpers.js';

function input(extra: Partial<SingleRequest> = {}): SingleRequest {
    return {
        url: productUrl,
        hostname: 'www.cnxieku.com',
        pinnedAddress: { address: '93.184.216.34', family: 4 },
        method: 'GET',
        redirect: 'manual',
        signal: new AbortController().signal,
        limits: requestLimits,
        timeoutSecs: 30,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        ...extra,
    };
}
class FakeRequest extends EventEmitter {
    destroyed = false;
    onEnd: () => void = () => undefined;
    end() {
        queueMicrotask(this.onEnd);
        return this;
    }
    destroy() {
        this.destroyed = true;
        return this;
    }
}
function fakeHttp(
    options: {
        status?: number;
        headers?: Record<string, string>;
        chunks?: Buffer[];
        peer?: string;
        authorized?: boolean;
        complete?: boolean;
        stall?: boolean;
        error?: Error;
        rawHeaders?: string[];
    } = {},
) {
    const calls: { url: URL; options: PinnedHttpsOptions }[] = [];
    let request!: FakeRequest;
    let reads = 0;
    const requester: HttpsRequester = (url, requestOptions, callback) => {
        calls.push({ url, options: requestOptions });
        request = new FakeRequest();
        request.onEnd = () => {
            if (options.error) {
                request.emit('error', options.error);
                return;
            }
            if (options.stall) return;
            const chunks = options.chunks ?? [Buffer.from('<html>Document</html>')];
            const stream = Readable.from(
                (function* () {
                    for (const chunk of chunks) {
                        reads++;
                        yield chunk;
                    }
                })(),
            );
            const response = Object.assign(stream, {
                statusCode: options.status ?? 200,
                headers: options.headers ?? { 'content-type': 'text/html; charset=utf-8' },
                rawHeaders: options.rawHeaders ?? [],
                complete: options.complete ?? true,
                socket: { authorized: options.authorized ?? true, remoteAddress: options.peer ?? '93.184.216.34' },
            }) as unknown as IncomingMessage;
            callback(response);
        };
        return request as unknown as ClientRequest;
    };
    return {
        requester,
        calls,
        get request() {
            return request;
        },
        get reads() {
            return reads;
        },
    };
}
describe('Native HTTPS transport with controlled stream doubles', () => {
    it('accepts JSON only through the CNXieku-specific response kind and retains the default HTML restriction', async () => {
        const fake = fakeHttp({ headers: { 'content-type': 'application/json' }, chunks: [Buffer.from('{"code":0}')] });
        assert.equal((await createHttpsTransport(fake.requester, 'cnxieku-json')(input())).body, '{"code":0}');
        await assert.rejects(
            () => createHttpsTransport(fake.requester)(input()),
            (error: unknown) => error instanceof HttpTransportError && error.code === 'UNSUPPORTED_CONTENT_TYPE',
        );
        assert.equal(fake.calls[0].options.rejectUnauthorized, true);
    });
    it('pins lookup and TLS with no proxy, reuse or automatic redirect', async () => {
        const fake = fakeHttp();
        const result = await createHttpsTransport(fake.requester)(input());
        assert.equal(result.body, '<html>Document</html>');
        assert.equal(fake.calls.length, 1);
        const { options } = fake.calls[0];
        assert.equal(options.agent, false);
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.checkServerIdentity, checkServerIdentity);
        assert.equal(options.servername, 'www.cnxieku.com');
        assert.equal(options.port, 443);
        assert.equal(options.autoSelectFamily, false);
        assert.equal(options.maxHeaderSize, 16384);
        options.lookup!('www.cnxieku.com', {}, (error, address, family) => {
            assert.equal(error, null);
            assert.equal(address, '93.184.216.34');
            assert.equal(family, 4);
        });
        options.lookup!('www.cnxieku.com', { all: true }, (error, addresses) => {
            assert.equal(error, null);
            assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
        });
        options.lookup!('unapproved.invalid', {}, (error) => assert.ok(error));
        assert.ok(!('cookie' in (options.headers ?? {})));
        assert.ok(!('authorization' in (options.headers ?? {})));
        assert.ok(fake.request.destroyed);
    });
    for (const [encoding, encode] of [
        ['gzip', gzipSync],
        ['br', brotliCompressSync],
        ['deflate', deflateSync],
    ] as const) {
        it('decodes bounded ' + encoding, async () => {
            const body = '<html>Contenido explícito</html>';
            const fake = fakeHttp({
                headers: { 'content-type': 'text/html', 'content-encoding': encoding },
                chunks: [encode(Buffer.from(body))],
            });
            assert.equal((await createHttpsTransport(fake.requester)(input())).body, body);
        });
    }
    const oversizedCases: Parameters<typeof fakeHttp>[0][] = [
        { headers: { 'content-type': 'text/html', 'content-length': '1025' } },
        { chunks: [Buffer.alloc(700), Buffer.alloc(700)] },
        {
            headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
            chunks: [gzipSync(Buffer.alloc(2000, 65))],
        },
    ];
    for (const [index, options] of oversizedCases.entries()) {
        it('refuses oversized declared, streamed or expanded content ' + index, async () => {
            const fake = fakeHttp(options);
            await assert.rejects(
                () => createHttpsTransport(fake.requester)(input({ maxResponseBytes: 1024 })),
                (error: unknown) => error instanceof HttpTransportError && error.code === 'RESPONSE_TOO_LARGE',
            );
            assert.ok(fake.request.destroyed);
            assert.equal(fake.calls.length, 1);
        });
    }
    for (const status of [401, 403, 404, 429, 500]) {
        it('returns HTTP ' + status + ' headers without downloading or retrying', async () => {
            const fake = fakeHttp({ status, headers: { 'retry-after': '120' }, chunks: [Buffer.alloc(10000)] });
            const result = await createHttpsTransport(fake.requester)(input());
            assert.equal(result.statusCode, status);
            assert.equal(result.body, null);
            assert.equal(result.headers['retry-after'], '120');
            assert.equal(fake.reads, 0);
            assert.equal(fake.calls.length, 1);
        });
    }
    it('rejects a challenge at headers without downloading the body', async () => {
        const fake = fakeHttp({ headers: { 'cf-mitigated': 'challenge' } });
        assert.equal((await createHttpsTransport(fake.requester)(input())).body, null);
        assert.equal(fake.reads, 0);
    });
    for (const location of ['/product/other', 'https://127.0.0.1/p', 'https://unapproved.invalid/p']) {
        it('rejects redirect before reading its body: ' + location, async () => {
            const fake = fakeHttp({ status: 302, headers: { location } });
            await assert.rejects(
                () => createHttpsTransport(fake.requester)(input()),
                (error: unknown) =>
                    error instanceof HttpTransportError &&
                    ['REDIRECT_LIMIT', 'UNAUTHORIZED_REDIRECT'].includes(error.code) &&
                    error.httpStatus === 302,
            );
            assert.equal(fake.calls.length, 1);
            assert.equal(fake.reads, 0);
        });
    }
    it('produces a structured redirect failure with its HTTP status', async () => {
        const fake = fakeHttp({ status: 302, headers: { location: 'https://127.0.0.1/p' } });
        const result = await processProduct(
            { mode: 'mock', url: productUrl },
            {
                dependencies: {
                    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                    transport: createHttpsTransport(fake.requester),
                },
            },
        );
        assert.equal(result.status, 'blocked');
        assert.equal(result.httpStatus, 302);
        assert.equal(result.error?.code, 'UNAUTHORIZED_REDIRECT');
        assert.equal(fake.calls.length, 1);
    });
    for (const status of [301, 302, 307, 308]) {
        it(`returns Back Market HTTP ${status} and Location without reading the body or following automatically`, async () => {
            const url = 'https://www.backmarket.com/en-us/p/iphone/117a572b-532b-4946-befd-bca2abeee6d7';
            const target = validateProductUrl(url);
            const location = '/testchallengepage?next=' + encodeURIComponent(url);
            const fake = fakeHttp({ status, headers: { location } });
            const response = await createHttpsTransport(fake.requester)(
                input({
                    url,
                    hostname: target.hostname,
                    limits: limitsForTarget(target),
                }),
            );
            assert.equal(response.statusCode, status);
            assert.equal(response.headers.location, location);
            assert.equal(response.body, null);
            assert.equal(fake.calls.length, 1);
            assert.equal(fake.reads, 0);
            assert.equal(fake.calls[0].options.rejectUnauthorized, true);
            assert.equal(fake.calls[0].options.servername, 'www.backmarket.com');
            assert.equal(fake.calls[0].options.checkServerIdentity, checkServerIdentity);
            assert.ok(fake.request.destroyed);
        });
    }
    it('refuses to expand the redirect cap for CNXieku in a forged transport request', async () => {
        const fake = fakeHttp();
        await assert.rejects(
            () =>
                createHttpsTransport(fake.requester)(
                    input({
                        limits: { ...requestLimits, maxRedirects: 2 },
                    }),
                ),
            (error: unknown) => error instanceof Error && error.message.includes('política'),
        );
        assert.equal(fake.calls.length, 0);
    });
    for (const [code, options] of [
        ['TLS_ERROR', { authorized: false }],
        ['UNSAFE_ADDRESS', { peer: '127.0.0.1' }],
        ['RESPONSE_TOO_LARGE', { headers: { 'content-type': 'text/html', 'content-length': '2097153' } }],
    ] as const) {
        it(`retains ${code} validation on a redirected Back Market connection`, async () => {
            const url = 'https://www.backmarket.com/en-us/p/iphone/117a572b-532b-4946-befd-bca2abeee6d7';
            const first = fakeHttp({ status: 301, headers: { location: url + '?selected=1' } });
            const second = fakeHttp(options);
            let calls = 0;
            const transport = createHttpsTransport((page, settings, callback) =>
                (++calls === 1 ? first : second).requester(page, settings, callback),
            );
            const result = await processProduct(
                { mode: 'mock', url },
                {
                    dependencies: {
                        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                        transport,
                    },
                },
            );
            assert.equal(result.error?.code, code);
            assert.equal(calls, 2);
            assert.equal(second.reads, 0);
            assert.equal(second.calls[0].options.rejectUnauthorized, true);
            assert.ok(second.request.destroyed);
        });
    }
    for (const options of [{ peer: '127.0.0.1' }, { authorized: false }]) {
        it('refuses an unexpected peer or unverified TLS socket', async () => {
            const fake = fakeHttp(options);
            await assert.rejects(
                () => createHttpsTransport(fake.requester)(input()),
                (error: unknown) =>
                    error instanceof HttpTransportError && ['UNSAFE_ADDRESS', 'TLS_ERROR'].includes(error.code),
            );
            assert.equal(fake.reads, 0);
        });
    }
    it('rejects unsupported MIME, encoding, charset and corrupt compression', async () => {
        const cases: Parameters<typeof fakeHttp>[0][] = [
            { headers: { 'content-type': 'application/octet-stream' } },
            { headers: { 'content-type': 'text/html', 'content-encoding': 'unrecognized' } },
            { headers: { 'content-type': 'text/html; charset=unknown-encoding' } },
            { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, chunks: [Buffer.from('bad gzip')] },
        ];
        for (const options of cases) {
            const fake = fakeHttp(options);
            await assert.rejects(() => createHttpsTransport(fake.requester)(input()), HttpTransportError);
            assert.equal(fake.calls.length, 1);
        }
    });
    it('rejects incomplete responses and excess headers', async () => {
        for (const options of [{ complete: false }, { rawHeaders: Array(130).fill('x') }]) {
            const fake = fakeHttp(options);
            await assert.rejects(() => createHttpsTransport(fake.requester)(input()), HttpTransportError);
        }
    });
    it('destroys the socket on total timeout', async () => {
        const fake = fakeHttp({ stall: true });
        await assert.rejects(() => createHttpsTransport(fake.requester)(input({ timeoutSecs: 1 })), RequestTimeout);
        assert.ok(fake.request.destroyed);
    });
    it('cancels on abort and makes no request if already aborted', async () => {
        const controller = new AbortController();
        const fake = fakeHttp({ stall: true });
        const task = createHttpsTransport(fake.requester)(input({ signal: controller.signal }));
        controller.abort();
        await assert.rejects(() => task, /detenida/);
        assert.ok(fake.request.destroyed);
        await assert.rejects(() => createHttpsTransport(fake.requester)(input({ signal: controller.signal })));
        assert.equal(fake.calls.length, 1);
    });
    it('sanitizes socket and certificate failures', async () => {
        for (const code of ['ECONNRESET', 'CERT_HAS_EXPIRED']) {
            const fake = fakeHttp({ error: Object.assign(new Error('sensitive socket detail'), { code }) });
            await assert.rejects(
                () => createHttpsTransport(fake.requester)(input()),
                (error: unknown) => error instanceof HttpTransportError && !error.message.includes('sensitive'),
            );
            assert.equal(fake.calls.length, 1);
        }
    });
    it('cancels an in-flight body stream and destroys its request', async () => {
        const controller = new AbortController();
        let request!: FakeRequest;
        let stream!: Readable;
        let start!: () => void;
        const started = new Promise<void>((resolve) => {
            start = resolve;
        });
        const requester: HttpsRequester = (_url, _options, callback) => {
            request = new FakeRequest();
            request.onEnd = () => {
                stream = new Readable({
                    read() {
                        start();
                    },
                });
                callback(
                    Object.assign(stream, {
                        statusCode: 200,
                        rawHeaders: [],
                        headers: { 'content-type': 'text/html' },
                        complete: false,
                        socket: { authorized: true, remoteAddress: '93.184.216.34' },
                    }) as unknown as IncomingMessage,
                );
            };
            return request as unknown as ClientRequest;
        };
        const task = createHttpsTransport(requester)(input({ signal: controller.signal }));
        await started;
        controller.abort();
        await assert.rejects(() => task, /detenida/);
        assert.ok(request.destroyed);
        assert.ok(stream.destroyed);
    });
    it('discards a response that arrives after cancellation', async () => {
        const controller = new AbortController();
        let deliver!: (response: IncomingMessage) => void;
        const request = new FakeRequest();
        const requester: HttpsRequester = (_url, _options, callback) => {
            deliver = callback;
            return request as unknown as ClientRequest;
        };
        const task = createHttpsTransport(requester)(input({ signal: controller.signal }));
        controller.abort();
        await assert.rejects(() => task, /detenida/);
        const late = new Readable({
            read() {
                assert.fail('Late body must not be read');
            },
        });
        deliver(late as unknown as IncomingMessage);
        assert.ok(late.destroyed);
    });
    it('rejects unsafe targets and invalid limits before connecting', async () => {
        const fake = fakeHttp();
        for (const extra of [
            { pinnedAddress: { address: '127.0.0.1', family: 4 as const } },
            { url: 'https://127.0.0.1/p' },
            { maxResponseBytes: MAX_RESPONSE_BYTES + 1 },
            { hostname: 'other.invalid' },
            { timeoutSecs: 0 },
        ])
            await assert.rejects(() => createHttpsTransport(fake.requester)(input(extra)));
        assert.equal(fake.calls.length, 0);
    });
});
describe('Permission gate and cancellable DNS', () => {
    it('blocks both sources before DNS or HTTPS', () => {
        for (const url of [productUrl, 'https://www.backmarket.es/product/1']) {
            assert.throws(
                () => createAuthorizedRequestDependencies(validateProductUrl(url)),
                /pendientes|autorización/,
            );
        }
    });
    it('rejects mixed public/private answers from a DNS double', async () => {
        const lookup = ((_host: string, _options: unknown, cb: Function) =>
            cb(null, [
                { address: '8.8.8.8', family: 4 },
                { address: '127.0.0.1', family: 4 },
            ])) as never;
        await assert.rejects(
            () => resolvePublicHostname('www.cnxieku.com', new AbortController().signal, lookup),
            /no pública/,
        );
    });
    it('ignores late DNS results after abort', async () => {
        let done!: Function;
        const lookup = ((_host: string, _options: unknown, cb: Function) => {
            done = cb;
        }) as never;
        const controller = new AbortController();
        const task = resolvePublicHostname('www.cnxieku.com', controller.signal, lookup);
        controller.abort();
        await assert.rejects(() => task, /detenida/);
        done(null, [{ address: '8.8.8.8', family: 4 }]);
    });
    it('sanitizes DNS errors', async () => {
        const lookup = ((_host: string, _options: unknown, cb: Function) => cb(new Error('private resolver'))) as never;
        await assert.rejects(
            () => resolvePublicHostname('www.cnxieku.com', new AbortController().signal, lookup),
            (error: unknown) =>
                error instanceof HttpTransportError && error.code === 'DNS_ERROR' && !error.message.includes('private'),
        );
    });
});
