import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProductResponse, RequestDependencies, SingleRequest } from '../src/request.js';

export const productUrl = 'https://www.cnxieku.com/product/MOCK-001';
export const mockInput = { mode: 'mock', url: productUrl };
export function fakeRequest(response: ProductResponse | ((request: SingleRequest) => Promise<ProductResponse>)) {
    const calls: SingleRequest[] = [];
    const resolutions: string[] = [];
    const dependencies: RequestDependencies = {
        async resolve(hostname) {
            resolutions.push(hostname);
            return [{ address: '93.184.216.34', family: 4 }];
        },
        async transport(request) {
            calls.push(request);
            return typeof response === 'function' ? response(request) : response;
        },
    };
    return { dependencies, calls, resolutions };
}
export function json(path: string) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

/** Assert only the JSON Schema keywords used by our contracts; not a general schema engine. */
export function assertSchema(schema: any, value: any, path = '$'): void {
    if (schema.oneOf) {
        const matches = schema.oneOf.filter((branch: any) => {
            try {
                assertSchema(branch, value, path);
                return true;
            } catch (error) {
                if (error instanceof assert.AssertionError) return false;
                throw error;
            }
        });
        assert.equal(matches.length, 1, path + ': exactly one schema branch must match');
    }
    if (schema.type === undefined) return;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    assert.ok(
        types.includes(actual) || (actual === 'number' && Number.isInteger(value) && types.includes('integer')),
        path + ': type',
    );
    if (schema.enum) assert.ok(schema.enum.includes(value), path + ': enum');
    if (value === null) return;
    if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), path);
        if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, path + ': minimum');
        if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, path + ': maximum');
    }
    if (typeof value === 'string') {
        if (schema.minLength) assert.ok(value.length >= schema.minLength, path + ': length');
        if (schema.pattern) assert.match(value, new RegExp(schema.pattern), path + ': pattern');
        if (schema.format === 'uri') assert.ok(new URL(value).protocol, path + ': uri');
    }
    if (Array.isArray(value)) {
        if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, path + ': maxItems');
        value.forEach((item, index) => assertSchema(schema.items, item, path + '[' + index + ']'));
    } else if (typeof value === 'object') {
        for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), path + '.' + key + ': required');
        for (const [key, member] of Object.entries(value)) {
            if (schema.additionalProperties === false)
                assert.ok(Object.hasOwn(schema.properties, key), path + '.' + key + ': unknown');
            if (schema.properties?.[key]) assertSchema(schema.properties[key], member, path + '.' + key);
        }
    }
}
