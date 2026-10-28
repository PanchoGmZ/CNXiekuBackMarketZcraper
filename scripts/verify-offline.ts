import assert from 'node:assert/strict';

import { log } from 'apify';

import { processProduct } from '../src/process-product.js';
import { toDatasetItem } from '../src/result.js';
import { processSearch } from '../src/search.js';
import { assertSchema, fakeRequest, json } from '../test/helpers.js';
import { productHtml, savedProductUrl, searchPage } from '../test/samples.js';

const previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
try {
    process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify(json('config/cnxieku.example.json'));
    const product = await processProduct({ mode: 'html', url: savedProductUrl, html: productHtml() });
    assert.equal(product.product.productId, '20274');
    const output = toDatasetItem(product, { outputFormat: 'reference1688' });
    assertSchema(json('schemas/reference1688-product.schema.json'), output);
    const data = json('test/fixtures/cnxieku-search-running.response.json');
    for (const query of ['跑步鞋', '1937']) {
        // This replays the same saved API sample for both inputs; it is not a new public result.
        const fake = fakeRequest(async request => ({
            statusCode: 200, headers: {},
            body: new URL(request.url).pathname === '/search/' ? searchPage(query) : JSON.stringify(data),
        }));
        const search = await processSearch({ mode: 'search', query, maxResults: 10 }, undefined, { dependencies: fake.dependencies });
        assert.equal(search.status, 'success');
        assert.equal(fake.calls.length, 2);
        assert.ok(fake.calls.every(call => !new URL(call.url).pathname.startsWith('/item/')));
        assertSchema(json('schemas/search-result.schema.json'), search);
        const selected = search.results.find(candidate => candidate.url === savedProductUrl)!;
        assert.equal(selected.productId, product.product.productId);
        assert.equal(selected.title, product.product.title);
        assert.equal(selected.price!.amount, product.product.price!.amount);
    }
    log.info('Offline search/product replay passed. No public DNS or HTTPS requests were made.', { productId: product.product.productId });
} finally {
    if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
    else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
}
