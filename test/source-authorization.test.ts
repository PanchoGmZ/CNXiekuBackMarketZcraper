import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { processProduct } from '../src/process-product.js';
import { createAuthorizedRequestDependencies } from '../src/real-request.js';
import { validateProductUrl } from '../src/url-policy.js';
import { fakeRequest, json } from './helpers.js';

describe('Exact-domain business authorization declared by project, not independently reviewed', () => {
    let previous: string | undefined;
    beforeEach(() => {
        previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
    });
    afterEach(() => {
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
    });
    const entry = {
        permissionBasis: 'project-declared',
        agreementReviewed: false,
        allowProductGet: true,
        robotsException: true,
    };
    const target = validateProductUrl('https://www.cnxieku.com/item/19928');
    it('permits one exact-domain product GET with explicit robots exception', async () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ 'www.cnxieku.com': entry });
        const fake = fakeRequest({ statusCode: 404, headers: {}, body: null });
        const result = await processProduct({ mode: 'product', url: target.url }, fake);
        assert.equal(result.status, 'not_found');
        assert.equal(result.httpStatus, 404);
        assert.equal(fake.calls.length, 1);
        assert.equal(fake.resolutions.length, 1);
    });
    for (const domain of ['*', '*.cnxieku.com', 'cnxieku.com', 'www.cnxieku.com.evil.invalid']) {
        it(`does not match the unrelated or wildcard declaration ${domain}`, () => {
            process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ [domain]: entry });
            assert.throws(() => createAuthorizedRequestDependencies(target), /dominio/);
        });
    }
    it('requires the robots exception separately from product GET permission', () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({
            'www.cnxieku.com': { ...entry, robotsException: false },
        });
        assert.throws(() => createAuthorizedRequestDependencies(target), /robots/);
    });
    it('limits the declared exception to individual CNXieku item pages', () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ 'www.cnxieku.com': entry });
        assert.throws(
            () => createAuthorizedRequestDependencies(validateProductUrl('https://www.cnxieku.com/catalogue')),
            /fichas/,
        );
    });
    it('rejects malformed administrative JSON before any network stage', () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = '{bad}';
        assert.throws(() => createAuthorizedRequestDependencies(target), /JSON/);
    });
    it('keeps Back Market disabled without an explicitly confirmed region and locale', () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ 'www.backmarket.es': entry });
        assert.throws(
            () => createAuthorizedRequestDependencies(validateProductUrl('https://www.backmarket.es/product/1')),
            /autorización/,
        );
    });
    it('rechecks revocation after dependencies have been created', async () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ 'www.cnxieku.com': entry });
        const fake = fakeRequest({ statusCode: 404, headers: {}, body: null });
        const dependencies = createAuthorizedRequestDependencies(target, fake.dependencies);
        delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        await assert.rejects(() => dependencies.resolve(target.hostname, new AbortController().signal), /dominio/);
        await assert.rejects(() => dependencies.transport({ url: target.url } as never), /dominio/);
        assert.equal(fake.calls.length, 0);
        assert.equal(fake.resolutions.length, 0);
    });
    it('retains public-IP validation with permission and robots exception enabled', async () => {
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify({ 'www.cnxieku.com': entry });
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: null });
        fake.dependencies.resolve = async () => [{ address: '127.0.0.1', family: 4 }];
        const result = await processProduct({ mode: 'product', url: target.url }, fake);
        assert.equal(result.error?.code, 'UNSAFE_ADDRESS');
        assert.equal(fake.calls.length, 0);
    });
    it('records an unreviewed project declaration and enables only the named CNXieku host', () => {
        const config = json('config/cnxieku.example.json');
        assert.deepEqual(Object.keys(config), ['www.cnxieku.com']);
        assert.equal(config['www.cnxieku.com'].agreementReviewed, false);
        assert.equal(config['www.cnxieku.com'].permissionBasis, 'project-declared');
    });
});
