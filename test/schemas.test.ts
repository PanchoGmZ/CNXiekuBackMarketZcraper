import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mockScenarios } from '../src/input.js';
import { processProduct } from '../src/process-product.js';
import { normalizeProduct } from '../src/product.js';
import { resultStatuses } from '../src/result.js';
import { assertSchema, json, mockInput, productUrl } from './helpers.js';

describe('Product and result schema contracts', () => {
    const actor = json('.actor/actor.json');
    const dataset = json('.actor/dataset_schema.json');
    const canonical = dataset.fields.oneOf[0];
    const productSchema = json('schemas/product.schema.json');
    it('references the input, output and storage schemas without changing the template identity', () => {
        assert.ok(actor.meta.generatedBy);
        assert.equal(actor.meta.templateId, 'ts-crawlee-cheerio');
        assert.equal(actor.storages.dataset, './dataset_schema.json');
        assert.equal(actor.storages.keyValueStore, './key_value_store_schema.json');
        assert.equal(actor.outputSchema, './output_schema.json');
    });
    it('retains all ten product reference fields with nullable absent values', () => {
        const fields = [
            'url',
            'title',
            'price',
            'moq',
            'weight',
            'dimensions',
            'images',
            'characteristics',
            'variations',
            'productId',
        ];
        assert.deepEqual(Object.keys(productSchema.properties), fields);
        assert.deepEqual([...productSchema.required].sort(), [...fields].sort());
        const { $schema, ...contract } = productSchema;
        assert.ok($schema);
        assert.deepEqual(canonical.properties.product, contract);
        assertSchema(productSchema, normalizeProduct({}));
        for (const property of Object.values(productSchema.properties) as { type: string[] }[])
            assert.ok(property.type.includes('null'));
    });
    it('matches every emitted result and nested product against the schemas', async () => {
        for (const mockScenario of mockScenarios.filter((scenario) => scenario !== 'timeout')) {
            const result = await processProduct({ ...mockInput, mockScenario });
            assertSchema(dataset.fields, result);
            assertSchema(productSchema, result.product);
        }
        for (const raw of [null, { url: productUrl }, { url: 'https://127.0.0.1/p' }]) {
            assertSchema(dataset.fields, await processProduct(raw));
        }
        assert.deepEqual(canonical.properties.status.enum, [...resultStatuses]);
    });
    it('requires every result key including failures and documents the Console view', async () => {
        const result = await processProduct(mockInput);
        const keys = Object.keys(result).sort();
        assert.deepEqual([...canonical.required].sort(), keys);
        assert.deepEqual([...dataset.views.overview.transformation.fields].sort(), keys);
        assert.equal(canonical.additionalProperties, false);
        const broken = { ...result };
        delete (broken as Partial<typeof result>).product;
        assert.throws(() => assertSchema(dataset.fields, broken));
    });
    it('documents one URL and every runtime input with a default or prefill', () => {
        const input = json('.actor/input_schema.json');
        assert.deepEqual(Object.keys(input.properties).sort(), [
            'html',
            'maxResponseBytes',
            'maxResults',
            'mockScenario',
            'mode',
            'outputFormat',
            'query',
            'source',
            'timeoutSecs',
            'url',
        ]);
        assert.deepEqual(input.required, []); // Conditional url/query requirements are enforced at runtime.
        assert.equal(input.properties.url.type, 'string');
        assert.equal(input.properties.mode.default, 'product');
        assert.equal(input.properties.outputFormat.default, 'canonical');
        assert.deepEqual(input.properties.outputFormat.enum, ['canonical', 'reference1688']);
        for (const property of Object.values(input.properties) as Record<string, unknown>[]) {
            for (const key of ['title', 'type', 'description']) assert.ok(property[key]);
            assert.ok('default' in property || 'prefill' in property);
        }
    });
    it('checks output templates and the state schema explicitly', () => {
        const output = json('.actor/output_schema.json');
        assert.equal(output.actorOutputSchemaVersion, 1);
        assert.equal(output.properties.results.template, '{{links.apiDefaultDatasetUrl}}/items');
        assert.equal(output.properties.runState.template, '{{links.apiDefaultKeyValueStoreUrl}}/records/RUN_STATE');
        const kv = json('.actor/key_value_store_schema.json');
        assert.equal(kv.collections.runState.key, 'RUN_STATE');
        assertSchema(kv.collections.runState.jsonSchema, {
            source: 'cnxieku',
            status: 'completed',
            savedResults: 1,
            resultStatus: 'blocked',
        });
        assert.throws(() =>
            assertSchema(kv.collections.runState.jsonSchema, {
                source: 'cnxieku',
                status: 'completed',
                savedResults: 2,
                resultStatus: 'success',
            }),
        );
    });
});
