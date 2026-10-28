import assert from 'node:assert/strict';
import { it } from 'node:test';

import { parseInput } from '../src/input.js';
import { normalizeProduct } from '../src/product.js';
import { isPublicAddress, validateProductUrl, validateResolvedAddresses } from '../src/url-policy.js';

const url = 'https://www.cnxieku.com/item/20274';

it('validates one product input, defaults, formats and bounded options', () => {
    const input = parseInput({ url });
    assert.equal(input.mode, 'product');
    assert.equal(input.outputFormat, 'canonical');
    assert.equal(input.timeoutSecs, 30);
    assert.equal(parseInput({ url, outputFormat: 'reference1688' }).target.source, 'cnxieku');
    for (const invalid of [null, { urls: [url] }, { url, query: 'x' }, { url, timeoutSecs: 0 },
        { url, timeoutSecs: 61 }, { url, maxResponseBytes: 2097153 }, { url, outputFormat: 'unknown' },
        { url, mockScenario: 'complete' }, { url, mode: 'html' }, { url, html: '<html/>' }]) {
        assert.throws(() => parseInput(invalid), Error, JSON.stringify(invalid));
    }
});

it('accepts exact supported hosts and rejects unsafe URL forms', () => {
    assert.equal(validateProductUrl('https://WWW.CNXIEKU.COM:443/item/20274').url, url);
    assert.equal(validateProductUrl('https://www.backmarket.com/en-us/p/example').source, 'back-market');
    for (const invalid of ['http://www.cnxieku.com/item/1', 'https://www.cnxieku.com/',
        'https://www.cnxieku.com.evil.invalid/item/1', 'https://127.0.0.1/item/1',
        'https://[::1]/item/1', 'https://www.cnxieku.com:8443/item/1', url + '#x',
        url + '\n', 'https://www.cnxieku.com\\@evil.invalid/item/1']) {
        assert.throws(() => validateProductUrl(invalid), Error, invalid);
    }
    const withCredentials = new URL(url);
    withCredentials.username = 'synthetic';
    withCredentials.password = 'rejected-test-input';
    assert.throws(() => validateProductUrl(withCredentials.href));
});

it('rejects reserved IPv4/IPv6 and mixed DNS answers before connecting', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1',
        '192.168.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1',
        '::1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '2001:db8::1', '2002::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
        assert.equal(isPublicAddress(address), true, address);
    }
    assert.throws(() => validateResolvedAddresses([]));
    assert.throws(() => validateResolvedAddresses([{ address: '8.8.8.8', family: 6 }]));
    assert.throws(() => validateResolvedAddresses([
        { address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 },
    ]));
});

it('normalizes missing values without guessing currency, units or variant prices', () => {
    const product = normalizeProduct({ productId: '0001', price: { amount: 0 }, moq: 1.5,
        images: ['data:text/plain,unsafe'], variations: [{ title: 'A' }], ignored: 'unused' });
    assert.equal(product.productId, '0001');
    assert.deepEqual(product.price, { amount: 0, currency: null });
    assert.equal(product.moq, null);
    assert.equal(product.weight, null);
    assert.equal(product.dimensions, null);
    assert.equal(product.variations![0]!.price, null);
    assert.equal('ignored' in product, false);
    assert.deepEqual(normalizeProduct(JSON.parse(JSON.stringify(product))), product);
});
