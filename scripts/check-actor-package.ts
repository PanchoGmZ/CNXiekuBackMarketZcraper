import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { log } from 'apify';

const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
interface Manifest {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
}
const actor = json<{
    actorSpecification: number;
    meta: { generatedBy: string };
    inputSchema: string;
    outputSchema: string;
    storages: { dataset: string; keyValueStore: string };
}>('.actor/actor.json');
assert.equal(actor.actorSpecification, 1);
assert.ok(actor.meta.generatedBy);
for (const path of [actor.inputSchema, actor.outputSchema, actor.storages.dataset, actor.storages.keyValueStore]) {
    assert.ok(existsSync(resolve('.actor', path)), 'Missing Actor schema reference.');
}
const manifest = json<Manifest>('package.json');
const lock = json<{ packages: Record<string, Manifest> }>('package-lock.json');
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
const dockerfile = readFileSync('Dockerfile', 'utf8');
assert.match(dockerfile, /FROM apify\/actor-node:24/);
assert.match(dockerfile, /CMD \["node", "dist\/main.js"\]/);
const ignore = readFileSync('.dockerignore', 'utf8').split(/\r?\n/);
for (const path of ['node_modules', 'storage', 'dist', '.test-dist', 'local-html'])
    assert.ok(ignore.includes(path), `Missing build-context exclusion: ${path}`);
for (const path of [
    'main.js',
    'run.js',
    'reference-1688.js',
    'https-transport.js',
    'real-request.js',
    'search.js',
    'cnxieku-search-request.js',
    'extractors/cnxieku-search.js',
    'cli/prepare-html-input.js',
])
    assert.ok(existsSync(`dist/${path}`), `Missing compiled module: ${path}`);
const dataset = json<{ fields: { oneOf: unknown[] } }>('.actor/dataset_schema.json');
assert.equal(dataset.fields.oneOf.length, 3);
const reference = json<{ required: string[] }>('schemas/reference1688-product.schema.json');
assert.equal(reference.required.length, 11);
const require = createRequire(resolve('package.json'));
for (const dependency of Object.keys(manifest.dependencies)) assert.ok(require.resolve(dependency));
log.info('Actor package static checks passed. Docker image build was not executed.');
