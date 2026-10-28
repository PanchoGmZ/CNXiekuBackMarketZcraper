import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Actor } from 'apify';
import type { ProductResult } from '../src/result.js';
import { runActor } from '../src/run.js';
import { mockInput, productUrl } from './helpers.js';

describe('One dataset result per invocation', () => {
    let input: unknown;
    let abort: (() => Promise<void>) | undefined;
    let saved: ProductResult[];
    let states: unknown[];
    let exited: boolean;
    beforeEach(() => {
        input = mockInput;
        abort = undefined;
        saved = [];
        states = [];
        exited = false;
        mock.method(Actor, 'getInput', async () => input as never);
        mock.method(Actor, 'pushData', async (data: unknown) => {
            saved.push(data as ProductResult);
            return undefined as never;
        });
        mock.method(Actor, 'setValue', async (_key: string, value: unknown) => {
            states.push(value);
        });
        mock.method(Actor, 'on', (_event: string, handler: () => Promise<void>) => {
            abort = handler;
        });
        mock.method(Actor, 'off', () => undefined);
        mock.method(Actor, 'exit', async () => {
            exited = true;
        });
    });
    afterEach(() => mock.restoreAll());
    for (const [scenario, status] of [
        ['complete', 'success'],
        ['partial', 'partial'],
        ['timeout', 'timeout'],
    ] as const) {
        it('writes exactly one result for scenario ' + scenario, async () => {
            input = { ...mockInput, mockScenario: scenario, timeoutSecs: 1 };
            assert.equal(await runActor(), 'completed');
            assert.equal(saved.length, 1);
            assert.equal(saved[0].status, status);
            assert.deepEqual(states.at(-1), {
                source: 'cnxieku',
                status: 'completed',
                savedResults: 1,
                resultStatus: status,
            });
        });
    }
    it('stores a blocked result for the real connector without failing the Actor run', async () => {
        input = { mode: 'product', url: productUrl };
        await runActor();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'blocked');
        assert.equal(saved[0].httpStatus, null);
    });
    it('stores one unsupported result for an unknown domain', async () => {
        input = { mode: 'product', url: 'https://unknown.invalid/p' };
        await runActor();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'unsupported');
    });
    it('does not retry a failed dataset write or claim it succeeded', async () => {
        let attempts = 0;
        mock.method(Actor, 'pushData', async () => {
            attempts++;
            throw new Error('Storage unavailable');
        });
        await assert.rejects(runActor, /Storage unavailable/);
        assert.equal(attempts, 1);
        assert.deepEqual(states.at(-1), {
            source: 'cnxieku',
            status: 'failed',
            savedResults: 0,
            resultStatus: 'success',
        });
    });
    it('saves one structured result even when the input is malformed', async () => {
        input = { source: 'mock', mockProducts: [] };
        await runActor();
        assert.equal(saved.length, 1);
        assert.equal(saved[0].error?.code, 'INVALID_INPUT');
    });
    it('on abort finishes an in-flight dataset write and persists before exit', async () => {
        let release!: () => void;
        let started!: () => void;
        const writing = new Promise<void>((resolve) => {
            started = resolve;
        });
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        mock.method(Actor, 'pushData', async (data: unknown) => {
            started();
            await pending;
            saved.push(data as ProductResult);
            return undefined as never;
        });
        mock.method(Actor, 'exit', async () => {
            assert.deepEqual(states.at(-1), {
                source: 'cnxieku',
                status: 'aborted',
                savedResults: 1,
                resultStatus: 'success',
            });
            exited = true;
        });
        const running = runActor();
        await writing;
        assert.ok(abort);
        const aborting = abort();
        assert.equal(exited, false);
        release();
        assert.equal(await running, 'aborted');
        await aborting;
        assert.equal(saved.length, 1);
        assert.equal(exited, true);
    });
    it('on abort cancels pending extraction and still stores one failure result', async () => {
        input = { ...mockInput, mockScenario: 'timeout', timeoutSecs: 30 };
        const running = runActor();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(abort);
        const aborting = abort();
        assert.equal(await running, 'aborted');
        await aborting;
        assert.equal(saved.length, 1);
        assert.equal(saved[0].status, 'error');
        assert.equal(saved[0].error?.code, 'RUN_ABORTED');
        assert.deepEqual(states.at(-1), {
            source: 'cnxieku',
            status: 'aborted',
            savedResults: 1,
            resultStatus: 'error',
        });
        assert.equal(exited, true);
    });
});
