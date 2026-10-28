import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Actor } from 'apify';

import { runActor } from '../src/run.js';
import { parseSearchInput, processSearch } from '../src/search.js';
import {
    buildCnxiekuSearchDataUrl,
    validateCnxiekuSearchDataUrl,
    validateCnxiekuSearchUrl,
} from '../src/cnxieku-search-request.js';
import { analyzeCnxiekuSearchData } from '../src/extractors/cnxieku-search.js';
import { assertSchema, fakeRequest, json } from './helpers.js';

describe('CNXieku search contract and explicit authorization block', () => {
    afterEach(() => mock.restoreAll());
    it('preserves Chinese, names, numeric codes and special characters and blocks without the scoped permission', async () => {
        for (const query of ['运动鞋', '5553', '女鞋 & 男鞋 + "型号" / ?x=1', ' Café 👟 ']) {
            const input = parseSearchInput({ mode: 'search', source: 'cnxieku', query });
            assert.equal(input.query, query.trim());
            assert.equal(input.maxResults, 10);
            assert.equal(input.timeoutSecs, 30);
            const result = await processSearch({ ...input });
            assert.equal(result.searchPerformed, false);
            assert.equal(result.status, 'blocked');
            assert.equal(result.query, query.trim());
            assert.equal(new URL(result.requestedUrl!).searchParams.get('keyword'), query.trim());
            assert.equal(result.httpStatus, null);
            assert.equal(result.error?.code, 'SEARCH_SCOPE_NOT_AUTHORIZED');
            assert.deepEqual(result.results, []);
            assertSchema(json('schemas/search-result.schema.json'), result);
            assertSchema(json('.actor/dataset_schema.json').fields, result);
        }
        assert.equal(
            parseSearchInput({ mode: 'search', query: '鞋', maxResults: 20, outputFormat: 'canonical' }).maxResults,
            20,
        );
    });
    it('rejects empty queries, invalid bounds and mixed product/search inputs with clear structured errors', async () => {
        const valid = { mode: 'search', query: '鞋' };
        for (const [extra, code] of [
            [{ query: '' }, 'INVALID_QUERY'],
            [{ query: '   ' }, 'INVALID_QUERY'],
            [{ query: 19928 }, 'INVALID_QUERY'],
            [{ query: 'x'.repeat(201) }, 'INVALID_QUERY'],
            [{ query: '鞋\n' }, 'INVALID_QUERY'],
            [{ maxResults: 21 }, 'INVALID_MAX_RESULTS'],
            [{ maxResults: 0 }, 'INVALID_MAX_RESULTS'],
            [{ maxResults: 1.5 }, 'INVALID_MAX_RESULTS'],
            [{ maxResults: '10' }, 'INVALID_MAX_RESULTS'],
            [{ source: 'back-market' }, 'INVALID_SEARCH_SOURCE'],
            [{ url: 'https://www.cnxieku.com/item/19928' }, 'INVALID_INPUT'],
            [{ outputFormat: 'reference1688' }, 'INVALID_OUTPUT_FORMAT'],
            [{ html: '<html/>' }, 'INVALID_INPUT'],
            [{ timeoutSecs: 61 }, 'INVALID_TIMEOUT'],
            [{ maxResponseBytes: 2097153 }, 'INVALID_SIZE_LIMIT'],
        ] as const) {
            const result = await processSearch({ ...valid, ...extra });
            assert.equal(result.status, 'error');
            assert.equal(result.error?.code, code);
            assertSchema(json('schemas/search-result.schema.json'), result);
        }
    });
    it('writes one blocked search record and truthful timings, without invoking product DNS/HTTPS', async () => {
        const records: unknown[] = [];
        const values: Record<string, any> = {};
        mock.method(Actor, 'getInput', async () => json('examples/input.search.cnxieku.json'));
        mock.method(Actor, 'pushData', async (item: unknown) => {
            records.push(item);
            return undefined as never;
        });
        mock.method(Actor, 'setValue', async (key: string, value: unknown) => {
            values[key] = value;
        });
        mock.method(Actor, 'on', () => undefined);
        mock.method(Actor, 'off', () => undefined);
        const forbidden = async (): Promise<never> => {
            assert.fail('Search must never invoke DNS or product transport');
        };
        await runActor({ dependencies: { resolve: forbidden, transport: forbidden } });
        assert.equal(records.length, 1);
        assertSchema(json('.actor/dataset_schema.json').fields, records[0]);
        assert.deepEqual(values.RUN_STATE, {
            source: 'cnxieku',
            status: 'completed',
            savedResults: 1,
            resultStatus: 'blocked',
        });
        assertSchema(json('.actor/key_value_store_schema.json').collections.timings.jsonSchema, values.TIMINGS);
        assert.equal(values.TIMINGS.environment, 'authorization-gate');
        assert.equal(values.TIMINGS.searchPerformed, false);
        assert.equal(values.TIMINGS.searchMs, null);
        assert.equal(values.TIMINGS.downloadMs, null);
        assert.equal(values.TIMINGS.analysisMs, null);
        assert.equal(values.TIMINGS.httpStatus, null);
    });
    it('does not enable search from an unverified administrative grant and honors abort', async () => {
        const previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        try {
            process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({
                'www.cnxieku.com': { allowSearchGet: true },
            });
            assert.equal(
                (await processSearch({ mode: 'search', query: '鞋' })).error?.code,
                'SEARCH_SCOPE_NOT_AUTHORIZED',
            );
            const controller = new AbortController();
            controller.abort();
            const result = await processSearch({ mode: 'search', query: '鞋' }, controller.signal);
            assert.equal(result.status, 'error');
            assert.equal(result.error?.code, 'RUN_ABORTED');
        } finally {
            if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
            else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
        }
    });
});

// Synthetic minimal Nuxt envelope. API commercial fields are an authentic, redacted public projection.
function page(query: string): string {
    const url = new URL('https://www.cnxieku.com/search/');
    url.searchParams.set('keyword', query);
    url.searchParams.set('searchType', '1');
    return (
        '<script id="__NUXT_DATA__" type="application/json" data-nuxt-data="nuxt-app">' +
        JSON.stringify([
            { pinia: 1, path: 4 },
            { common: 2 },
            { storageUrl: 3 },
            'https://oss.cnxieku.com/',
            url.pathname + url.search,
        ]) +
        '</script>'
    );
}
describe('Official CNXieku page and observed data endpoint', () => {
    let previous: string | undefined;
    beforeEach(() => {
        previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify(
            json('config/cnxieku.example.json'),
        );
    });
    afterEach(() => {
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
    });
    it('returns authentic projected candidates using only two GETs and associated prices, without visiting items', async () => {
        const data = json('test/fixtures/cnxieku-search-running.response.json');
        const fake = fakeRequest(async (request) => ({
            statusCode: 200,
            headers: {},
            body: new URL(request.url).pathname === '/search/' ? page('跑步鞋') : JSON.stringify(data),
        }));
        const timings = {
            downloadMs: null as number | null,
            analysisMs: null as number | null,
            searchMs: null as number | null,
        };
        const result = await processSearch({ mode: 'search', query: '跑步鞋', maxResults: 10 }, undefined, {
            dependencies: fake.dependencies,
            timings,
        });
        assert.equal(result.status, 'success');
        assert.equal(result.results.length, 10);
        assert.equal(result.results[0].productId, '20274');
        assert.equal(result.results[0].title, data.data.records[0].productName);
        assert.deepEqual(result.results[0].price, { amount: 78, currency: null });
        assert.equal(result.results[0].url, 'https://www.cnxieku.com/item/20274');
        assert.equal(result.results[0].image, 'https://oss.cnxieku.com/' + data.data.records[0].picThumb);
        assert.equal(fake.calls.length, 2);
        assert.equal(fake.resolutions.length, 2);
        assert.ok(fake.calls.every((call) => !call.url.includes('/item/') && call.limits.maxRedirects === 0));
        assert.ok(timings.searchMs! >= timings.downloadMs!);
        assertSchema(json('.actor/dataset_schema.json').fields, result);
        const duplicate = structuredClone(data);
        duplicate.data.records.push(duplicate.data.records[0]);
        duplicate.data.records[0].price = 999999;
        assert.equal(analyzeCnxiekuSearchData(duplicate, 20, null).results.length, 10);
        assert.equal(analyzeCnxiekuSearchData(duplicate, 20, null).results[0].price!.amount, 78);
    });
    it('distinguishes an authentic-shaped empty response from malformed/dynamic failures and stops on protection', async () => {
        for (const [response, expectedStatus] of [
            [{ code: 0, data: { records: [], total: 0 } }, 'success'],
            [{ code: 0, data: { records: [], total: 5 } }, 'error'],
            [{ code: 401 }, 'blocked'],
        ] as const) {
            const fake = fakeRequest(async (request) => ({
                statusCode: 200,
                headers: {},
                body: new URL(request.url).pathname === '/search/' ? page('测试') : JSON.stringify(response),
            }));
            const result = await processSearch({ mode: 'search', query: '测试' }, undefined, {
                dependencies: fake.dependencies,
            });
            assert.equal(result.status, expectedStatus);
            assert.deepEqual(result.results, []);
            assert.equal(fake.calls.length, 2);
        }
        const protectedPage = fakeRequest({ statusCode: 403, headers: {}, body: null });
        assert.equal(
            (
                await processSearch({ mode: 'search', query: '鞋' }, undefined, {
                    dependencies: protectedPage.dependencies,
                })
            ).status,
            'blocked',
        );
        assert.equal(protectedPage.calls.length, 1);
    });
    it('requires both exact-route permissions and refuses broader destinations/parameters before DNS', async () => {
        const config = json('config/cnxieku.example.json');
        config['www.cnxieku.com'].search.allowDataGet = false;
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify(config);
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: '' });
        assert.equal(
            (await processSearch({ mode: 'search', query: '鞋' }, undefined, { dependencies: fake.dependencies })).error
                ?.code,
            'SEARCH_DATA_NOT_AUTHORIZED',
        );
        assert.equal(fake.resolutions.length, 0);
        const valid = buildCnxiekuSearchDataUrl('鞋 & size=100', 20).url;
        assert.equal(new URL(valid).searchParams.get('keyword'), '鞋 & size=100');
        for (const url of [
            valid.replace('page=1', 'page=2'),
            valid.replace('size=20', 'size=21'),
            valid.replace('www.cnxieku.com', 'cnxieku.com'),
            valid + '&size=1',
            valid.replace('/list?', '/other?'),
        ])
            assert.throws(() => validateCnxiekuSearchDataUrl(url));
        assert.throws(() => validateCnxiekuSearchUrl('https://www.cnxieku.com/search/?keyword=x&searchType=2'));
    });
});
