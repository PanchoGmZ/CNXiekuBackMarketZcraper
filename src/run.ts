import { Actor, log } from 'apify';

import { processProduct, type ProcessTimings } from './process-product.js';
import { isRecord } from './product.js';
import type { RequestDependencies } from './request.js';
import { type ProductResult, type ResultStatus, toDatasetItem } from './result.js';
import { processSearch, type SearchResult, type SearchTimings } from './search.js';
import type { Source } from './url-policy.js';

export interface RunState {
    source: Source | null;
    status: 'running' | 'completed' | 'aborted' | 'failed';
    savedResults: number;
    resultStatus: ResultStatus | null;
}
/** One input URL, one dataset write, including structured business failures. */
export async function runActor(options: { dependencies?: RequestDependencies } = {}): Promise<'completed' | 'aborted'> {
    const started = performance.now();
    const timings: ProcessTimings & SearchTimings = { downloadMs: null, analysisMs: null };
    let jsonGenerationMs: number | null = null;
    let result: ProductResult | SearchResult | undefined;
    const state: RunState = { source: null, status: 'running', savedResults: 0, resultStatus: null };
    const controller = new AbortController();
    let stopping = false;
    let task: Promise<void> | undefined;
    const persistState = async (): Promise<void> => {
        await Actor.setValue('RUN_STATE', { ...state });
    };
    const persistTimings = async (): Promise<void> => {
        let environment = options.dependencies ? 'controlled-https' : 'public-https';
        if (result?.mode === 'html') environment = 'supplied-html';
        if (result?.mode === 'mock') environment = 'simulated';
        if (result?.mode === 'search' && !result.searchPerformed) environment = 'authorization-gate';
        await Actor.setValue('TIMINGS', {
            environment,
            mode: result?.mode ?? null,
            requestedUrl: result?.requestedUrl ?? null,
            resultStatus: state.resultStatus,
            httpStatus: result?.httpStatus ?? null,
            ...timings,
            jsonGenerationMs,
            totalMs: performance.now() - started,
            totalScope:
                'runActor entry through dataset write; excludes Actor init/exit and TIMINGS/RUN_STATE persistence',
        });
    };
    const onAbort = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        controller.abort();
        await task?.catch(() => undefined);
        state.status = 'aborted';
        try {
            await persistTimings();
            await persistState();
        } finally {
            await Actor.exit();
        }
    };
    Actor.on('aborting', onAbort);
    try {
        task = (async () => {
            const raw = await Actor.getInput<unknown>();
            result =
                isRecord(raw) && raw.mode === 'search'
                    ? await processSearch(raw, controller.signal, { dependencies: options.dependencies, timings })
                    : await processProduct(raw, {
                          signal: controller.signal,
                          dependencies: options.dependencies,
                          timings,
                      });
            const jsonStarted = performance.now();
            const item = result.mode === 'search' ? result : toDatasetItem(result, raw);
            const json = JSON.stringify(item);
            jsonGenerationMs = performance.now() - jsonStarted;
            state.source = result.source;
            state.resultStatus = 'status' in item ? item.status : result.status;
            await Actor.pushData(JSON.parse(json));
            state.savedResults = 1;
        })();
        await task;
        if (stopping) return 'aborted';
        state.status = 'completed';
        await persistTimings();
        await persistState();
        log.info('Single product processed.', {
            source: state.source,
            resultStatus: state.resultStatus,
            savedResults: state.savedResults,
        });
        return 'completed';
    } catch (error) {
        if (stopping) return 'aborted';
        state.status = 'failed';
        await persistTimings();
        await persistState();
        throw error;
    } finally {
        if (!stopping) Actor.off('aborting', onAbort);
    }
}
