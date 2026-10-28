import {
    buildCnxiekuSearchDataUrl,
    createCnxiekuSearchDependencies,
    validateCnxiekuSearchUrl,
} from './cnxieku-search-request.js';
import { analyzeCnxiekuSearchData, analyzeCnxiekuSearchPage } from './extractors/cnxieku-search.js';
import { HttpTransportError } from './http-error.js';
import { MAX_RESPONSE_BYTES, validResponseLimit } from './limits.js';
import { isRecord } from './product.js';
import { type ProductResponse, type RequestDependencies, requestSingleProduct, RequestTimeout } from './request.js';
import { PolicyError } from './url-policy.js';

export interface SearchInput {
    mode: 'search';
    source: 'cnxieku';
    query: string;
    maxResults: number;
    timeoutSecs: number;
    maxResponseBytes: number;
}
export interface SearchCandidate {
    productId: string | null;
    title: string;
    url: string;
    price: { amount: number | null; currency: string | null } | null;
    image: string | null;
    source: 'cnxieku';
}
export interface SearchResult {
    mode: 'search';
    source: 'cnxieku';
    requestedUrl: string | null;
    query: string | null;
    maxResults: number | null;
    status: 'success' | 'partial' | 'blocked' | 'error' | 'timeout' | 'not_found';
    searchPerformed: boolean;
    httpStatus: number | null;
    results: SearchCandidate[];
    error: { code: string; message: string; retryAfter: string | null } | null;
}
export interface SearchTimings {
    downloadMs: number | null;
    analysisMs: number | null;
    searchMs?: number | null;
    searchPerformed?: boolean;
    searchRequests?: { url: string; httpStatus: number | null; downloadMs: number; errorCode: string | null }[];
}

/** Separate contract: search never turns a query into an assumed product ID or URL. */
export function parseSearchInput(raw: unknown): SearchInput {
    if (
        !isRecord(raw) ||
        Object.keys(raw).some(
            (key) =>
                !['mode', 'source', 'query', 'maxResults', 'timeoutSecs', 'maxResponseBytes', 'outputFormat'].includes(
                    key,
                ),
        )
    )
        throw new PolicyError(
            'INVALID_INPUT',
            'La búsqueda acepta source, query, maxResults y límites; no acepta url, html ni opciones de crawling.',
        );
    if (raw.mode !== 'search' || (raw.source !== undefined && raw.source !== 'cnxieku'))
        throw new PolicyError('INVALID_SEARCH_SOURCE', 'mode=search solo admite source=cnxieku.');
    // Apify can apply the global canonical default even for a search input.
    if (raw.outputFormat !== undefined && raw.outputFormat !== 'canonical')
        throw new PolicyError(
            'INVALID_OUTPUT_FORMAT',
            'reference1688 solo se admite para fichas; la búsqueda devuelve una lista de candidatos.',
        );
    if (
        typeof raw.query !== 'string' ||
        !raw.query.trim() ||
        Array.from(raw.query.trim()).length > 200 ||
        Array.from(raw.query).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
        throw new PolicyError('INVALID_QUERY', 'query debe contener entre 1 y 200 caracteres de texto, sin controles.');
    const maxResults = raw.maxResults === undefined ? 10 : raw.maxResults;
    if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20)
        throw new PolicyError(
            'INVALID_MAX_RESULTS',
            'maxResults debe ser un entero entre 1 y 20; el valor predeterminado es 10.',
        );
    const timeoutSecs = raw.timeoutSecs === undefined ? 30 : raw.timeoutSecs;
    if (typeof timeoutSecs !== 'number' || !Number.isInteger(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 60)
        throw new PolicyError('INVALID_TIMEOUT', 'timeoutSecs debe ser un entero entre 1 y 60.');
    const maxResponseBytes = raw.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : raw.maxResponseBytes;
    if (!validResponseLimit(maxResponseBytes))
        throw new PolicyError('INVALID_SIZE_LIMIT', 'maxResponseBytes debe estar entre 1024 y 2097152.');
    return { mode: 'search', source: 'cnxieku', query: raw.query.trim(), maxResults, timeoutSecs, maxResponseBytes };
}

/** Official page + one observed data GET; one total deadline, no retries, redirects, pagination or item downloads. */
export async function processSearch(
    raw: unknown,
    signal?: AbortSignal,
    options: {
        dependencies?: RequestDependencies;
        timings?: SearchTimings;
    } = {},
): Promise<SearchResult> {
    const result: SearchResult = {
        mode: 'search',
        source: 'cnxieku',
        requestedUrl: null,
        query: null,
        maxResults: null,
        status: 'blocked',
        searchPerformed: false,
        httpStatus: null,
        results: [],
        error: null,
    };
    const { timings } = options;
    if (timings) {
        timings.searchMs = null;
        timings.searchPerformed = false;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let started: number | undefined;
    signal?.addEventListener('abort', abort, { once: true });
    try {
        const input = parseSearchInput(raw);
        result.query = input.query;
        result.maxResults = input.maxResults;
        if (signal?.aborted) throw new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.');
        const url = new URL('https://www.cnxieku.com/search/');
        url.searchParams.set('keyword', input.query);
        url.searchParams.set('searchType', '1');
        const pageTarget = validateCnxiekuSearchUrl(url.href);
        const dataTarget = buildCnxiekuSearchDataUrl(input.query, input.maxResults);
        result.requestedUrl = pageTarget.url;
        // Validate both permissions before any DNS or socket.
        const pageDependencies = createCnxiekuSearchDependencies(pageTarget, options.dependencies);
        const dataDependencies = createCnxiekuSearchDependencies(dataTarget, options.dependencies);
        started = performance.now();
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, input.timeoutSecs * 1000);
        result.searchPerformed = true;
        if (timings) timings.searchPerformed = true;
        const download = async (
            target: typeof pageTarget,
            dependencies: RequestDependencies,
        ): Promise<ProductResponse> => {
            const began = performance.now();
            const requestReport = {
                url: target.url,
                httpStatus: null as number | null,
                downloadMs: 0,
                errorCode: null as string | null,
            };
            if (timings) (timings.searchRequests ??= []).push(requestReport);
            try {
                const response = await requestSingleProduct(
                    target,
                    input.timeoutSecs,
                    dependencies,
                    controller.signal,
                    input.maxResponseBytes,
                );
                requestReport.httpStatus = response.statusCode;
                return response;
            } catch (error) {
                if (error instanceof HttpTransportError) requestReport.httpStatus = error.httpStatus;
                requestReport.errorCode = 'REQUEST_FAILED';
                if (error instanceof HttpTransportError || error instanceof PolicyError)
                    requestReport.errorCode = error.code;
                if (timedOut) requestReport.errorCode = 'REQUEST_TIMEOUT';
                throw error;
            } finally {
                requestReport.downloadMs = performance.now() - began;
                if (timings) timings.downloadMs = (timings.downloadMs ?? 0) + requestReport.downloadMs;
            }
        };
        const checkResponse = (response: ProductResponse): string => {
            result.httpStatus = response.statusCode;
            if (response.statusCode === 429)
                throw new PolicyError('RATE_LIMITED', 'El servidor limita las solicitudes; no se reintentó.');
            if (
                [401, 403].includes(response.statusCode) ||
                response.protectionDetected ||
                response.headers['cf-mitigated'] === 'challenge' ||
                (typeof response.body === 'string' &&
                    /id=["']challenge-form["']|\/cdn-cgi\/challenge-platform\/|class=["'][^"']*(?:g-recaptcha|h-captcha)/i.test(
                        response.body,
                    ))
            )
                throw new PolicyError(
                    'ACCESS_BLOCKED',
                    'La búsqueda está restringida o protegida; la operación se detuvo.',
                );
            if (response.statusCode < 200 || response.statusCode >= 300)
                throw new PolicyError('SEARCH_HTTP_ERROR', 'La búsqueda devolvió un HTTP no satisfactorio.');
            if (typeof response.body !== 'string' || Buffer.byteLength(response.body) > input.maxResponseBytes)
                throw new PolicyError(
                    'INVALID_SEARCH_DATA',
                    'La respuesta no contiene texto dentro del límite autorizado.',
                );
            return response.body;
        };
        const page = checkResponse(await download(pageTarget, pageDependencies));
        let analysisStarted = performance.now();
        const { storageUrl } = analyzeCnxiekuSearchPage(page, pageTarget.url);
        if (timings) timings.analysisMs = performance.now() - analysisStarted;
        controller.signal.throwIfAborted();
        const data = checkResponse(await download(dataTarget, dataDependencies));
        analysisStarted = performance.now();
        let body: unknown;
        try {
            body = JSON.parse(data);
        } catch {
            throw new PolicyError('INVALID_SEARCH_DATA', 'La API no devolvió JSON válido.');
        }
        if (isRecord(body) && body.code !== 0) {
            if (Number(body.code) === 429)
                throw new PolicyError('RATE_LIMITED', 'La API limita las solicitudes; no se reintentó.');
            if ([401, 403, 429].includes(Number(body.code)))
                throw new PolicyError('ACCESS_BLOCKED', 'La API rechazó el acceso; no se reintentó.');
            throw new PolicyError('SEARCH_API_ERROR', 'La API respondió con un error de negocio; no se reintentó.');
        }
        const parsed = analyzeCnxiekuSearchData(body, input.maxResults, storageUrl);
        if (timings) timings.analysisMs = (timings.analysisMs ?? 0) + performance.now() - analysisStarted;
        result.results = parsed.results;
        result.status = parsed.skippedRows ? 'partial' : 'success';
        return result;
    } catch (error) {
        if (error instanceof HttpTransportError) result.httpStatus = error.httpStatus;
        result.status =
            timedOut || error instanceof RequestTimeout || [408, 504].includes(result.httpStatus ?? 0)
                ? 'timeout'
                : 'error';
        const code = error instanceof PolicyError || error instanceof HttpTransportError ? error.code : 'SEARCH_ERROR';
        if (
            !timedOut &&
            [
                'SEARCH_SCOPE_NOT_AUTHORIZED',
                'SEARCH_DATA_NOT_AUTHORIZED',
                'ACCESS_BLOCKED',
                'RATE_LIMITED',
                'UNSAFE_ADDRESS',
                'UNAUTHORIZED_REDIRECT',
                'REDIRECT_LIMIT',
            ].includes(code)
        )
            result.status = 'blocked';
        if ([404, 410].includes(result.httpStatus ?? 0)) result.status = 'not_found';
        let message = 'No fue posible procesar la búsqueda.';
        if (error instanceof PolicyError || error instanceof HttpTransportError) message = error.message;
        if (timedOut) message = 'Se agotó el plazo total de la búsqueda.';
        result.error = {
            code: timedOut || error instanceof RequestTimeout ? 'REQUEST_TIMEOUT' : code,
            message,
            retryAfter: null,
        };
        return result;
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (timings && started !== undefined) timings.searchMs = performance.now() - started;
    }
}
