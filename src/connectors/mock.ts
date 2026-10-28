import { backMarketHtml, cnxiekuHtml } from '../fixtures/html.js';
import { mockProducts } from '../fixtures/products.js';
import type { Input } from '../input.js';
import type { RequestDependencies } from '../request.js';

/** Synthetic resolution and response only. Never resolves DNS or opens a connection. */
export function createMockDependencies(input: Input): RequestDependencies {
    return {
        async resolve() {
            return [{ address: '93.184.216.34', family: 4 }];
        },
        async transport() {
            switch (input.mockScenario) {
                case 'html':
                    return {
                        statusCode: 200,
                        headers: { 'content-type': 'text/html; charset=utf-8' },
                        body: input.target.source === 'cnxieku' ? cnxiekuHtml : backMarketHtml,
                    };
                case 'forbidden':
                    return { statusCode: 403, headers: {}, body: null };
                case 'not_found':
                    return { statusCode: 404, headers: {}, body: null };
                case 'rate_limited':
                    return { statusCode: 429, headers: { 'retry-after': '120' }, body: null };
                case 'protected':
                    return { statusCode: 200, headers: { 'cf-mitigated': 'challenge' }, body: null };
                case 'redirect':
                    return { statusCode: 302, headers: { location: 'https://unapproved.invalid/product' }, body: null };
                case 'timeout':
                    return new Promise(() => {
                        /* The request deadline ends this scenario. */
                    });
                case 'error':
                    throw new Error('Synthetic transport error');
                default:
                    return {
                        statusCode: 200,
                        headers: {},
                        body: { ...mockProducts[input.mockScenario === 'partial' ? 1 : 0], url: input.target.url },
                    };
            }
        },
    };
}
