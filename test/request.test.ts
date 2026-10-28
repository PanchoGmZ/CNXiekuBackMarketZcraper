import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestLimits, requestSingleProduct, RequestTimeout } from '../src/request.js';
import { validateProductUrl } from '../src/url-policy.js';
import { fakeRequest, productUrl } from './helpers.js';

describe('Enforced request limits and DNS guard', () => {
    const target = validateProductUrl(productUrl);
    it('performs one GET with a public pinned address, manual redirects and fixed limits', async () => {
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: {} });
        await requestSingleProduct(target, 30, fake.dependencies);
        assert.equal(fake.calls.length, 1);
        assert.deepEqual(fake.resolutions, ['www.cnxieku.com']);
        assert.equal(fake.calls[0].redirect, 'manual');
        assert.equal(fake.calls[0].method, 'GET');
        assert.deepEqual(fake.calls[0].pinnedAddress, { address: '93.184.216.34', family: 4 });
        assert.deepEqual(requestLimits, {
            maxRequests: 1,
            maxConcurrency: 1,
            maxRetries: 0,
            maxRedirects: 0,
            maxAdditionalRequests: 0,
        });
        assert.ok(Object.isFrozen(requestLimits));
    });
    it('blocks private resolution before the transport runs', async () => {
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: {} });
        fake.dependencies.resolve = async () => [{ address: '127.0.0.1', family: 4 }];
        await assert.rejects(() => requestSingleProduct(target, 30, fake.dependencies), /no pública/);
        assert.equal(fake.calls.length, 0);
    });
    it('revalidates the target before resolving even if a caller supplies a forged target', async () => {
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: {} });
        await assert.rejects(() =>
            requestSingleProduct({ ...target, url: 'https://127.0.0.1/p' }, 30, fake.dependencies),
        );
        assert.equal(fake.resolutions.length, 0);
    });
    it('bounds DNS time and refuses to send a late request after timeout', async () => {
        const fake = fakeRequest({ statusCode: 200, headers: {}, body: {} });
        let release!: (value: { address: string; family: 4 }[]) => void;
        fake.dependencies.resolve = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        await assert.rejects(() => requestSingleProduct(target, 1, fake.dependencies), RequestTimeout);
        release([{ address: '8.8.8.8', family: 4 }]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fake.calls.length, 0);
    });
    it('cancels a pending transport on external abort', async () => {
        const controller = new AbortController();
        let started!: () => void;
        const waiting = new Promise<void>((resolve) => {
            started = resolve;
        });
        const fake = fakeRequest(async (request) => {
            started();
            return new Promise((_resolve, reject) =>
                request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
            );
        });
        const task = requestSingleProduct(target, 30, fake.dependencies, controller.signal);
        await waiting;
        controller.abort();
        await assert.rejects(() => task, /detenida/);
        assert.equal(fake.calls.length, 1);
        assert.ok(fake.calls[0].signal.aborted);
    });
});
