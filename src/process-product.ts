import { getConnector } from './connectors/index.js';
import { createMockDependencies } from './connectors/mock.js';
import { HttpTransportError } from './http-error.js';
import { parseInput } from './input.js';
import { isRecord, normalizeProduct } from './product.js';
import { createAuthorizedRequestDependencies } from './real-request.js';
import {
    type ProductResponse,
    type RequestDependencies,
    type RequestHop,
    requestSingleProduct,
    RequestTimeout,
} from './request.js';
import { emptyResult, missingProductFields, type ProductResult, type ResultStatus } from './result.js';
import { PolicyError, rejectRedirect } from './url-policy.js';

function fail(
    result: ProductResult,
    status: ResultStatus,
    code: string,
    message: string,
    serverRetryAfter: string | null = null,
): ProductResult {
    return { ...result, status, error: { code, message, retryAfter: serverRetryAfter } };
}
function header(response: ProductResponse, name: string): string | null {
    for (const [key, value] of Object.entries(response.headers)) {
        if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
    return null;
}
function retryAfter(response: ProductResponse): string | null {
    const value = header(response, 'retry-after')?.trim();
    // Preserve valid server instructions verbatim. No retry or invented duration.
    if (!value || value.length > 128) return null;
    return /^\d+$/.test(value) ||
        (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) &&
            Number.isFinite(Date.parse(value)))
        ? value
        : null;
}
function protectedHtml(body: unknown): boolean {
    return (
        typeof body === 'string' &&
        /id=["']challenge-form["']|\/cdn-cgi\/challenge-platform\/|class=["'][^"']*(?:g-recaptcha|h-captcha)/i.test(
            body,
        )
    );
}
function protection(response: ProductResponse): boolean {
    return (
        response.protectionDetected === true ||
        header(response, 'cf-mitigated') === 'challenge' ||
        protectedHtml(response.body)
    );
}
export interface ProcessTimings {
    /** DNS + TLS + headers/body and decoding. null means this stage was not entered. */
    downloadMs: number | null;
    analysisMs: number | null;
    requests?: RequestHop[];
}
/** Exactly one business result; injected transports are for offline tests only. */
export async function processProduct(
    raw: unknown,
    options: { dependencies?: RequestDependencies; signal?: AbortSignal; timings?: ProcessTimings } = {},
): Promise<ProductResult> {
    let result = emptyResult();
    const { timings } = options;
    const analyze = (html: string, source: ProductResult['source'], url: string) => {
        const started = performance.now();
        try {
            return getConnector(source!).parseHtml(html, url);
        } finally {
            if (timings) timings.analysisMs = performance.now() - started;
        }
    };
    try {
        const input = parseInput(raw);
        result = {
            ...result,
            mode: input.mode,
            requestedUrl: input.target.url,
            source: input.target.source,
            product: normalizeProduct({ url: input.target.url }),
        };
        result.missingFields = missingProductFields(result.product);
        if (options.signal?.aborted) throw new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.');
        if (input.mode === 'html') {
            if (protectedHtml(input.html))
                return fail(
                    result,
                    'blocked',
                    'ACCESS_BLOCKED',
                    'El HTML suministrado contiene una protección de acceso.',
                );
            result.product = analyze(input.html!, input.target.source, input.target.url);
            result.missingFields = missingProductFields(result.product);
            return { ...result, status: result.missingFields.length ? 'partial' : 'success' };
        }
        const dependencies =
            input.mode === 'product'
                ? createAuthorizedRequestDependencies(input.target, options.dependencies)
                : (options.dependencies ?? createMockDependencies(input));
        const started = performance.now();
        const trace: RequestHop[] | undefined = input.target.source === 'back-market' ? [] : undefined;
        if (timings && trace) timings.requests = trace;
        let response: ProductResponse;
        try {
            response = await requestSingleProduct(
                input.target,
                input.timeoutSecs,
                dependencies,
                options.signal,
                input.maxResponseBytes,
                trace,
            );
        } finally {
            if (timings) timings.downloadMs = performance.now() - started;
        }
        if (
            !isRecord(response) ||
            !Number.isInteger(response.statusCode) ||
            response.statusCode < 100 ||
            response.statusCode > 599 ||
            !isRecord(response.headers)
        ) {
            return fail(result, 'error', 'INVALID_RESPONSE', 'La respuesta no cumple el contrato del conector.');
        }
        result.httpStatus = response.statusCode;
        if (response.statusCode === 429)
            return fail(
                result,
                'blocked',
                'RATE_LIMITED',
                'El servidor limita las solicitudes. No se reintentó.',
                retryAfter(response),
            );
        if ([401, 403].includes(response.statusCode) || protection(response)) {
            return fail(
                result,
                'blocked',
                'ACCESS_BLOCKED',
                'El acceso está restringido o protegido. La extracción se detuvo.',
            );
        }
        if ([404, 410].includes(response.statusCode))
            return fail(result, 'not_found', 'PRODUCT_NOT_FOUND', 'El producto no está disponible.');
        if ([408, 504].includes(response.statusCode))
            return fail(result, 'timeout', 'HTTP_TIMEOUT', 'El servidor agotó el tiempo de respuesta.');
        if (response.statusCode >= 300 && response.statusCode < 400)
            rejectRedirect(header(response, 'location'), input.target);
        if (response.statusCode < 200 || response.statusCode >= 300)
            return fail(result, 'error', 'HTTP_ERROR', 'El servidor devolvió un error HTTP.', retryAfter(response));
        if (typeof response.body === 'string' && Buffer.byteLength(response.body, 'utf8') > input.maxResponseBytes) {
            throw new HttpTransportError(
                'RESPONSE_TOO_LARGE',
                'El HTML excede el límite de tamaño.',
                result.httpStatus,
            );
        }
        const contentType = header(response, 'content-type')?.split(';')[0].trim().toLowerCase();
        if (typeof response.body === 'string' && ['text/html', 'application/xhtml+xml'].includes(contentType ?? '')) {
            result.product = analyze(response.body, input.target.source, response.finalUrl ?? input.target.url);
            if (response.finalUrl && response.finalUrl !== input.target.url)
                result.product = normalizeProduct({ ...result.product, url: input.target.url });
        } else if (isRecord(response.body)) {
            result.product = normalizeProduct({ ...response.body, url: input.target.url });
        } else {
            return fail(result, 'error', 'INVALID_PRODUCT_DATA', 'La respuesta no contiene un objeto de producto.');
        }
        result.missingFields = missingProductFields(result.product);
        return { ...result, status: result.missingFields.length ? 'partial' : 'success' };
    } catch (error) {
        if (error instanceof HttpTransportError) {
            result.httpStatus = error.httpStatus;
            const blocked = ['UNSAFE_ADDRESS', 'UNAUTHORIZED_REDIRECT', 'REDIRECT_LIMIT', 'REDIRECT_CYCLE'].includes(
                error.code,
            );
            return fail(result, blocked ? 'blocked' : 'error', error.code, error.message);
        }
        if (
            error instanceof RequestTimeout ||
            (isRecord(error) &&
                (error.name === 'TimeoutError' || ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(String(error.code))))
        ) {
            return fail(result, 'timeout', 'REQUEST_TIMEOUT', 'Se agotó el tiempo de la operación.');
        }
        if (error instanceof PolicyError) {
            let status: ResultStatus = result.requestedUrl ? 'blocked' : 'unsupported';
            if (error.code === 'RUN_ABORTED') status = 'error';
            return fail(result, status, error.code, error.message);
        }
        return fail(result, 'error', 'CONNECTOR_ERROR', 'No fue posible procesar el producto.');
    }
}
