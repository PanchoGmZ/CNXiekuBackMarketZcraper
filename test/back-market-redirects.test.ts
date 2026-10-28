import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Actor } from 'apify';

import { HttpTransportError } from '../src/http-error.js';
import { MAX_RESPONSE_BYTES } from '../src/limits.js';
import { processProduct, type ProcessTimings } from '../src/process-product.js';
import { createAuthorizedRequestDependencies } from '../src/real-request.js';
import {
    limitsForTarget,
    requestLimits,
    requestSingleProduct,
    RequestTimeout,
    type ProductResponse,
    type RequestHop,
} from '../src/request.js';
import { runActor } from '../src/run.js';
import { validateProductUrl } from '../src/url-policy.js';
import { assertSchema, fakeRequest, json } from './helpers.js';

const url = json('examples/input.product.back-market-us.json').url as string;
const target = validateProductUrl(url);
const next = url.replace('iphone-13-128-gb-green-fully-unlocked-gsm-cdma', 'iphone-13-canonical');
const final = next + '?condition=good';
const grant = JSON.stringify(json('config/back-market.example.json'));
const html = (pageUrl: string) =>
    '<html><script type="application/ld+json">' +
    JSON.stringify({
        '@type': 'Product',
        url: pageUrl,
        name: 'Synthetic test product',
        sku: 'test-sku',
        offers: { '@type': 'Offer', price: '123.45', priceCurrency: 'USD' },
    }) +
    '</script></html>';

describe('Back Market redirects stay within a single authorized US product', () => {
    let previous: string | undefined;
    beforeEach(() => {
        previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = grant;
    });
    afterEach(() => {
        mock.restoreAll();
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
    });
    for (const statusCode of [301, 302, 307, 308]) {
        it(`follows HTTP ${statusCode} only after validation, records Location, parses final URL and preserves original URL`, async () => {
            const fake = fakeRequest(async (request): Promise<ProductResponse> =>
                request.url === url
                    ? { statusCode, headers: { Location: new URL(next).pathname }, body: null }
                    : { statusCode: 200, headers: { 'content-type': 'text/html' }, body: html(next) },
            );
            const timings: ProcessTimings = { downloadMs: null, analysisMs: null };
            const result = await processProduct({ mode: 'product', url }, { ...fake, timings });
            assert.equal(result.httpStatus, 200);
            assert.equal(result.product.price?.amount, 123.45);
            assert.equal(result.requestedUrl, url);
            assert.equal(result.product.url, url);
            assert.deepEqual(
                fake.calls.map((call) => call.url),
                [url, next],
            );
            assert.equal(fake.resolutions.length, 2);
            assert.equal(timings.requests?.[0].location, new URL(next).pathname);
            assert.equal(timings.requests?.[0].destination, next);
            assert.equal(timings.requests?.[0].followed, true);
            assert.equal(timings.requests?.[1].httpStatus, 200);
            for (const hop of timings.requests!) {
                assert.ok(hop.dnsMs! >= 0 && hop.requestMs! >= 0 && hop.totalMs >= 0);
            }
            for (const call of fake.calls) {
                assert.deepEqual(call.limits, { ...requestLimits, maxRedirects: 2 });
                assert.equal(call.timeoutSecs, 30);
                assert.equal(call.maxResponseBytes, MAX_RESPONSE_BYTES);
                assert.equal(call.method, 'GET');
                assert.equal(call.redirect, 'manual');
            }
        });
    }
    it('follows exactly two redirects and writes exactly one eleven-key dataset result', async () => {
        const fake = fakeRequest(async (request): Promise<ProductResponse> =>
            request.url === final
                ? { statusCode: 200, headers: { 'content-type': 'text/html' }, body: html(final) }
                : {
                      statusCode: 308,
                      headers: { location: request.url === url ? next : '?condition=good' },
                      body: null,
                  },
        );
        const items: any[] = [];
        const values: Record<string, any> = {};
        mock.method(Actor, 'getInput', async () => ({ mode: 'product', outputFormat: 'reference1688', url }) as never);
        mock.method(Actor, 'pushData', async (item: unknown) => {
            items.push(item);
            return undefined as never;
        });
        mock.method(Actor, 'setValue', async (key: string, value: unknown) => {
            values[key] = value;
        });
        mock.method(Actor, 'on', () => undefined);
        mock.method(Actor, 'off', () => undefined);
        await runActor(fake);
        assert.equal(fake.calls.length, 3);
        assert.equal(items.length, 1);
        assertSchema(json('schemas/reference1688-product.schema.json'), items[0]);
        assert.equal(Object.keys(items[0]).length, 11);
        assert.equal(items[0].price, '123.45');
        assert.equal(items[0].url, url);
        assert.equal(values.RUN_STATE.savedResults, 1);
        assertSchema(json('.actor/key_value_store_schema.json').collections.timings.jsonSchema, values.TIMINGS);
        assert.equal(values.TIMINGS.requests.filter((hop: RequestHop) => hop.followed).length, 2);
    });
    it('refuses a third redirect without DNS or a fourth connection', async () => {
        const fake = fakeRequest(async (request) => ({
            statusCode: 301,
            headers: { location: request.url === url ? next : request.url === next ? final : final + '&extra=1' },
            body: null,
        }));
        const trace: RequestHop[] = [];
        await assert.rejects(
            () => requestSingleProduct(target, 30, fake.dependencies, undefined, MAX_RESPONSE_BYTES, trace),
            (error: unknown) =>
                error instanceof HttpTransportError && error.code === 'REDIRECT_LIMIT' && error.httpStatus === 301,
        );
        assert.equal(fake.calls.length, 3);
        assert.equal(fake.resolutions.length, 3);
        assert.equal(trace[2].followed, false);
        assert.equal(trace[2].errorCode, 'REDIRECT_LIMIT');
    });
    const forbidden = [
        '/testchallengepage?next=' + encodeURIComponent(url),
        'http://www.backmarket.com' + new URL(next).pathname,
        next.replace('www.backmarket.com', 'backmarket.com'),
        next.replace('www.backmarket.com', 'www.backmarket.es'),
        next.replace('www.backmarket.com', 'www.cnxieku.com'),
        next.replace('www.backmarket.com', 'www.backmarket.com.evil.invalid'),
        next.replace('/en-us/', '/es-es/'),
        next.replace('117a572b', '117a572c'),
        '/en-us/l/iphone/anything',
        '/en-us/p/iphone/not-a-uuid',
        next.replace('https://', 'https://user:pass@'),
        next.replace('.com/', '.com:8443/'),
        next + '#fragment',
        'https://127.0.0.1/product',
        '\\evil.invalid\\product',
        next + '\r\n',
        '',
    ];
    for (const location of forbidden) {
        it(`refuses forbidden Location before another DNS/transport: ${JSON.stringify(location)}`, async () => {
            const fake = fakeRequest({ statusCode: 301, headers: { location }, body: null });
            const timings: ProcessTimings = { downloadMs: null, analysisMs: null };
            const result = await processProduct({ mode: 'product', url }, { ...fake, timings });
            assert.equal(result.error?.code, 'UNAUTHORIZED_REDIRECT');
            assert.equal(result.httpStatus, 301);
            assert.equal(result.status, 'blocked');
            assert.equal(result.product.price, null);
            assert.equal(timings.analysisMs, null);
            assert.equal(timings.requests?.[0].location, location);
            assert.equal(timings.requests?.[0].followed, false);
            assert.equal(fake.calls.length, 1);
            assert.equal(fake.resolutions.length, 1);
        });
    }
    it('refuses missing Location and unsupported 3xx status', async () => {
        for (const statusCode of [301, 303, 304, 305, 300]) {
            const fake = fakeRequest({ statusCode, headers: statusCode === 301 ? {} : { location: next }, body: null });
            const result = await processProduct({ mode: 'product', url }, fake);
            assert.equal(result.error?.code, 'UNAUTHORIZED_REDIRECT');
            assert.equal(fake.calls.length, 1);
        }
    });
    it('rejects immediate and multi-hop cycles before reconnecting to a visited URL', async () => {
        for (const immediate of [true, false]) {
            const fake = fakeRequest(async (request) => ({
                statusCode: 302,
                headers: { location: immediate || request.url === next ? url : next },
                body: null,
            }));
            const result = await processProduct({ mode: 'product', url }, fake);
            assert.equal(result.error?.code, 'REDIRECT_CYCLE');
            assert.equal(result.status, 'blocked');
            assert.equal(fake.calls.length, immediate ? 1 : 2);
            assert.equal(fake.resolutions.length, fake.calls.length);
        }
    });
    it('revalidates all DNS answers on the redirect and never connects to a private or mixed answer', async () => {
        for (const mixed of [true, false]) {
            const fake = fakeRequest({ statusCode: 301, headers: { location: next }, body: null });
            let resolutions = 0;
            fake.dependencies.resolve = async () =>
                ++resolutions === 1
                    ? [{ address: '93.184.216.34', family: 4 }]
                    : [
                          ...(mixed ? [{ address: '93.184.216.34', family: 4 as const }] : []),
                          { address: '127.0.0.1', family: 4 },
                      ];
            const timings: ProcessTimings = { downloadMs: null, analysisMs: null };
            const result = await processProduct({ mode: 'product', url }, { ...fake, timings });
            assert.equal(result.error?.code, 'UNSAFE_ADDRESS');
            assert.equal(fake.calls.length, 1);
            assert.equal(resolutions, 2);
            assert.equal(timings.requests?.[0].followed, false);
        }
    });
    it('revalidates administrative authorization on every hop', async () => {
        const fake = fakeRequest(async () => {
            delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
            return { statusCode: 301, headers: { location: next }, body: null };
        });
        const result = await processProduct({ mode: 'product', url }, fake);
        assert.equal(result.error?.code, 'SOURCE_NOT_AUTHORIZED');
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.resolutions.length, 1);
    });
    it('the authorization wrapper independently refuses a different product before transport', async () => {
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: null });
        const dependencies = createAuthorizedRequestDependencies(target, fake.dependencies);
        await assert.rejects(() =>
            requestSingleProduct(validateProductUrl(next.replace('117a572b', '117a572c')), 30, dependencies),
        );
        assert.equal(fake.calls.length, 0);
    });
    for (const statusCode of [403, 429]) {
        it(`stops on final HTTP ${statusCode} without retries or HTML analysis`, async () => {
            const fake = fakeRequest(async (request): Promise<ProductResponse> =>
                request.url === url
                    ? { statusCode: 307, headers: { location: next }, body: null }
                    : { statusCode, headers: { location: final, 'retry-after': '120' }, body: html(next) },
            );
            const result = await processProduct({ mode: 'product', url }, fake);
            assert.equal(result.httpStatus, statusCode);
            assert.equal(result.status, 'blocked');
            assert.equal(result.product.price, null);
            assert.equal(fake.calls.length, 2);
        });
    }
    it('stops on a protection header even when it accompanies an otherwise valid redirect', async () => {
        const fake = fakeRequest({
            statusCode: 301,
            headers: { location: next, 'cf-mitigated': 'challenge' },
            body: null,
        });
        const result = await processProduct({ mode: 'product', url }, fake);
        assert.equal(result.error?.code, 'ACCESS_BLOCKED');
        assert.equal(fake.calls.length, 1);
    });
    it('uses one total deadline including DNS on the next hop', async () => {
        const fake = fakeRequest({ statusCode: 301, headers: { location: next }, body: null });
        let dnsCalls = 0;
        let release!: () => void;
        fake.dependencies.resolve = async () => {
            if (++dnsCalls === 2)
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            return [{ address: '93.184.216.34', family: 4 }];
        };
        await assert.rejects(() => requestSingleProduct(target, 1, fake.dependencies), RequestTimeout);
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].signal.aborted, true);
    });
    it('only Back Market US product routes get a different redirect cap', () => {
        assert.deepEqual(limitsForTarget(target), { ...requestLimits, maxRedirects: 2 });
        for (const other of [
            'https://www.cnxieku.com/item/20354',
            url.replace('www.backmarket.com', 'backmarket.com'),
            url.replace('/en-us/', '/es-es/'),
            'https://www.backmarket.com/testchallengepage',
        ])
            assert.equal(limitsForTarget(validateProductUrl(other)), requestLimits);
    });
});
