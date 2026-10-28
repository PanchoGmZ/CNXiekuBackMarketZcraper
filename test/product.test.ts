import assert from 'node:assert/strict';
import { it } from 'node:test';

import { extractCnxiekuProduct } from '../src/extractors/cnxieku.js';
import { extractBackMarketProduct } from '../src/extractors/back-market.js';
import { backMarketHtml } from '../src/fixtures/html.js';
import { processProduct } from '../src/process-product.js';
import { normalizeProduct } from '../src/product.js';
import { adapt1688Reference, export1688Product } from '../src/reference-1688.js';
import { toDatasetItem } from '../src/result.js';
import type { ProductResponse } from '../src/request.js';
import { assertSchema, fakeRequest, json, mockInput } from './helpers.js';
import { productHtml, savedProductUrl } from './samples.js';

it('extracts a saved authentic CNXieku product by URL with one GET and exports eleven fields', async () => {
    const previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
    process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify(json('config/cnxieku.example.json'));
    try {
        const fake = fakeRequest({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: productHtml() });
        const result = await processProduct({ url: savedProductUrl }, fake);
        assert.equal(result.status, 'partial');
        assert.equal(result.httpStatus, 200);
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.calls[0].url, savedProductUrl);
        const product = result.product;
        assert.equal(product.productId, '20274');
        assert.deepEqual(product.price, { amount: 78, currency: null });
        assert.equal(product.images!.length, 33);
        assert.equal(new Set(product.images).size, 33);
        assert.equal(product.variations!.length, 65);
        assert.equal(new Set(product.variations!.map(v => v!.images![0])).size, 5);
        assert.ok(product.characteristics!.length > 0);
        assertSchema(json('schemas/product.schema.json'), product);
        const output = toDatasetItem(result, { outputFormat: 'reference1688' });
        assert.equal(Object.keys(output).length, 11);
        assertSchema(json('schemas/reference1688-product.schema.json'), output);
        assert.equal(toDatasetItem(result, {}), result);
    } finally {
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
    }
});

it('keeps gallery/SKU relationships and leaves unavailable pictures null', () => {
    const pool = json('test/fixtures/cnxieku-20274.nuxt.json');
    const product = extractCnxiekuProduct(productHtml(pool), savedProductUrl);
    for (const [index, color] of ['黑色', '桔色', '荧光绿', '棉花糖', '薄荷绿'].entries()) {
        const group = product.variations!.slice(index * 13, (index + 1) * 13);
        assert.ok(group.every(v => v!.title!.includes(color)));
        assert.equal(new Set(group.map(v => v!.images![0])).size, 1);
    }
    const withoutOneImage = structuredClone(pool);
    withoutOneImage.find((value: any) => value && !Array.isArray(value) && pool[value.skuId] === 615885).productUrl = -1;
    const missing = extractCnxiekuProduct(productHtml(withoutOneImage), savedProductUrl);
    assert.equal(missing.variations![0]!.images, null);
    assert.equal(missing.variations!.filter(v => v!.images).length, 64);
    assert.equal(extractCnxiekuProduct(productHtml(pool), 'https://www.cnxieku.com/item/20354').images, null);
    assert.equal(product.moq, null);
    assert.equal(product.weight, null);
    assert.equal(product.dimensions, null);
});

it('classifies HTTP, challenge and redirect failures without retries or product export', async () => {
    for (const [httpStatus, expected] of [[403, 'blocked'], [429, 'blocked'], [404, 'not_found'],
        [410, 'not_found'], [408, 'timeout'], [504, 'timeout'], [500, 'error']] as const) {
        const fake = fakeRequest({ statusCode: httpStatus, headers: { 'retry-after': '120' }, body: null });
        const result = await processProduct(mockInput, fake);
        assert.equal(result.status, expected, String(httpStatus));
        assert.equal(result.httpStatus, httpStatus);
        assert.equal(fake.calls.length, 1);
        assert.equal(result.product.title, null);
        assert.equal(toDatasetItem(result, { outputFormat: 'reference1688' }), result);
    }
    for (const response of [
        { statusCode: 200, headers: { 'cf-mitigated': 'challenge' }, body: productHtml() },
        { statusCode: 302, headers: { location: '/item/1' }, body: null },
    ] as ProductResponse[]) {
        const fake = fakeRequest(response);
        const result = await processProduct(mockInput, fake);
        assert.equal(result.status, 'blocked');
        assert.equal(fake.calls.length, 1);
    }
});

it('keeps Back Market structured selection independent from CNXieku and recommendations', () => {
    const url = 'https://www.backmarket.es/product/MOCK-HTML-002';
    const product = extractBackMarketProduct(backMarketHtml, url);
    assert.equal(product.productId, 'BM-HTML-002');
    assert.deepEqual(product.price, { amount: 299.9, currency: 'EUR' });
    assert.equal(product.variations![0]!.productId, 'BM-BLUE');
    assert.deepEqual(product.variations![0]!.price, { amount: 309.9, currency: null });
    assert.throws(() => extractCnxiekuProduct(backMarketHtml, url), TypeError);
});

it('preserves the 1688 adapter and nulls without copying a parent offer into variants', () => {
    const reference = json('test/fixtures/1688.reference.json');
    const imported = adapt1688Reference(reference);
    assertSchema(json('schemas/product.schema.json'), imported.product);
    assert.equal(imported.product.variations!.length, 10);
    const output = export1688Product(normalizeProduct({ productId: '000123', price: { amount: 65 }, variations: [{ title: 'A' }] }));
    assert.equal(output.productId, '000123');
    assert.equal(output.variations![0].variants[0].price, null);
    assert.equal(output.variations![0].variants[0].image, null);
    assertSchema(json('schemas/reference1688-product.schema.json'), output);
    assert.throws(() => assertSchema(json('schemas/reference1688-product.schema.json'), { ...output, status: 'partial' }));
});
