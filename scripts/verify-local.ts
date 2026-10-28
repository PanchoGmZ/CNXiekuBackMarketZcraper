import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { log } from 'apify';

import { processProduct } from '../src/process-product.js';
import { toDatasetItem } from '../src/result.js';
import { parseSearchInput } from '../src/search.js';
import { validateProductUrl } from '../src/url-policy.js';
import { assertSchema, json } from '../test/helpers.js';

// Run immediately after an execution with examples/input.mock.json; historical records remain intact.
const root = process.env.APIFY_LOCAL_STORAGE_DIR ?? process.env.CRAWLEE_STORAGE_DIR ?? 'storage';
const datasetDir = resolve(root, 'datasets/default');
const files = (await readdir(datasetDir)).filter((name) => /^\d+\.json$/.test(name)).sort();
assert.ok(files.length, 'Expected a saved product result.');
const latest = files[files.length - 1];
const actual = JSON.parse(await readFile(resolve(datasetDir, latest), 'utf8'));
const input = JSON.parse(await readFile(process.argv[2] ?? 'examples/input.mock.json', 'utf8'));
const state = JSON.parse(await readFile(resolve(root, 'key_value_stores/default/RUN_STATE.json'), 'utf8'));
if (input.mode === 'search') {
    assertSchema(json('schemas/search-result.schema.json'), actual);
    assertSchema(json('.actor/dataset_schema.json').fields, actual);
    const parsedSearch = parseSearchInput(input);
    assert.equal(actual.query, parsedSearch.query);
    assert.equal(actual.maxResults, parsedSearch.maxResults);
    assert.ok(actual.results.length <= parsedSearch.maxResults);
    assert.deepEqual(state, { source: 'cnxieku', status: 'completed', savedResults: 1, resultStatus: actual.status });
    const timings = JSON.parse(await readFile(resolve(root, 'key_value_stores/default/TIMINGS.json'), 'utf8'));
    assertSchema(json('.actor/key_value_store_schema.json').collections.timings.jsonSchema, timings);
    assert.equal(timings.environment, actual.searchPerformed ? 'public-https' : 'authorization-gate');
    assert.equal(timings.mode, 'search');
    assert.equal(timings.searchPerformed, actual.searchPerformed);
    if (actual.searchPerformed) assert.ok(timings.searchMs >= 0);
    else assert.equal(timings.searchMs, null);
    assert.equal(timings.httpStatus, actual.httpStatus);
} else if ((input.mode ?? 'product') === 'product') {
    // A live verification must NEVER issue a second GET. Validate the saved output and reports offline.
    const target = validateProductUrl(input.url);
    assertSchema(json('.actor/dataset_schema.json').fields, actual);
    assert.equal(actual.requestedUrl ?? actual.url, target.url);
    assert.deepEqual(state, {
        source: target.source,
        status: 'completed',
        savedResults: 1,
        resultStatus: actual.status ?? state.resultStatus,
    });
    const timings = JSON.parse(await readFile(resolve(root, 'key_value_stores/default/TIMINGS.json'), 'utf8'));
    assertSchema(json('.actor/key_value_store_schema.json').collections.timings.jsonSchema, timings);
    assert.equal(timings.environment, 'public-https');
    assert.equal(timings.requestedUrl, target.url);
    assert.equal(timings.resultStatus, state.resultStatus);
    if ('status' in actual) assert.equal(timings.httpStatus, actual.httpStatus);
    else {
        assert.ok(['success', 'partial'].includes(state.resultStatus));
        assert.ok(timings.httpStatus >= 200 && timings.httpStatus < 300);
        assertSchema(json('schemas/reference1688-product.schema.json'), actual);
    }
    log.info('Live product result verified offline; no additional request.', {
        file: latest,
        status: state.resultStatus,
        httpStatus: timings.httpStatus,
    });
} else {
    const result = await processProduct(input);
    const expected = toDatasetItem(result, input);
    assert.deepEqual(actual, expected);
    assert.deepEqual(state, {
        source: result.source,
        status: 'completed',
        savedResults: 1,
        resultStatus: 'status' in expected ? expected.status : result.status,
    });
}
log.info('Single product dataset result verified.', {
    file: latest,
    status: state.resultStatus,
    outputFormat: input.outputFormat ?? 'canonical',
});
