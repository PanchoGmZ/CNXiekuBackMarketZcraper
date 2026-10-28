import { HttpTransportError } from './http-error.js';
import { MAX_RESPONSE_BYTES, validResponseLimit } from './limits.js';
import {
    backMarketProductId,
    PolicyError,
    type ProductTarget,
    type ResolvedAddress,
    validateBackMarketRedirect,
    validateProductUrl,
    validateResolvedAddresses,
} from './url-policy.js';

export const requestLimits = Object.freeze({
    maxRequests: 1,
    maxConcurrency: 1,
    maxRetries: 0,
    maxRedirects: 0,
    maxAdditionalRequests: 0,
});
const backMarketRequestLimits = Object.freeze({ ...requestLimits, maxRedirects: 2 } as const);
export function limitsForTarget(target: ProductTarget): typeof requestLimits | typeof backMarketRequestLimits {
    return backMarketProductId(target) ? backMarketRequestLimits : requestLimits;
}
export interface RequestHop {
    url: string;
    startedAt: string;
    httpStatus: number | null;
    location: string | null;
    destination: string | null;
    followed: boolean;
    decision: string;
    dnsMs: number | null;
    requestMs: number | null;
    totalMs: number;
    errorCode: string | null;
}
export interface ProductResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    protectionDetected?: boolean;
    finalUrl?: string;
}
export interface SingleRequest {
    url: string;
    hostname: string;
    pinnedAddress: ResolvedAddress;
    method: 'GET';
    redirect: 'manual';
    signal: AbortSignal;
    limits: ReturnType<typeof limitsForTarget>;
    timeoutSecs: number;
    maxResponseBytes: number;
}
export interface RequestDependencies {
    resolve(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>;
    transport(request: SingleRequest): Promise<ProductResponse>;
}
export class RequestTimeout extends Error {}

/** A single operation: public DNS validation, pinned socket and total deadline. */
export async function requestSingleProduct(
    target: ProductTarget,
    timeoutSecs: number,
    dependencies: RequestDependencies,
    parentSignal?: AbortSignal,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    trace?: RequestHop[],
): Promise<ProductResponse> {
    const validated = validateProductUrl(target.url);
    if (!validResponseLimit(maxResponseBytes))
        throw new PolicyError('INVALID_SIZE_LIMIT', 'El límite de tamaño no está admitido.');
    if (!Number.isInteger(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 60) {
        throw new PolicyError('INVALID_TIMEOUT', 'El límite de tiempo debe estar entre 1 y 60 segundos.');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: (reason: Error) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const abort = (): void => {
        rejectCancellation(new PolicyError('RUN_ABORTED', 'La ejecución fue detenida antes de completar el producto.'));
        controller.abort();
    };
    parentSignal?.addEventListener('abort', abort, { once: true });
    const work = async (): Promise<ProductResponse> => {
        if (parentSignal?.aborted) throw new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.');
        const limits = limitsForTarget(validated);
        const visited = new Set([validated.url]);
        let current = validated;
        let pendingRedirect: RequestHop | undefined;
        // One product operation, with at most two validated Back Market redirects. No retries/resources.
        for (let redirects = 0; ; redirects++) {
            controller.signal.throwIfAborted();
            const started = performance.now();
            const hop: RequestHop = {
                url: current.url,
                startedAt: new Date().toISOString(),
                httpStatus: null,
                location: null,
                destination: null,
                followed: false,
                decision: 'requesting',
                dnsMs: null,
                requestMs: null,
                totalMs: 0,
                errorCode: null,
            };
            trace?.push(hop);
            let phaseStarted = performance.now();
            let phase: 'dnsMs' | 'requestMs' = 'dnsMs';
            try {
                const addresses = await dependencies.resolve(current.hostname, controller.signal);
                const pinnedAddress = validateResolvedAddresses(addresses);
                hop.dnsMs = performance.now() - phaseStarted;
                controller.signal.throwIfAborted();
                phase = 'requestMs';
                phaseStarted = performance.now();
                if (pendingRedirect) pendingRedirect.followed = true;
                const response = await dependencies.transport({
                    url: current.url,
                    hostname: current.hostname,
                    pinnedAddress,
                    method: 'GET',
                    redirect: 'manual',
                    signal: controller.signal,
                    limits,
                    timeoutSecs,
                    maxResponseBytes,
                });
                hop.requestMs = performance.now() - phaseStarted;
                // Keep CNXieku's single-response contract and its zero-redirect behavior unchanged.
                if (!limits.maxRedirects) return response;
                if (
                    !response ||
                    !Number.isInteger(response.statusCode) ||
                    response.statusCode < 100 ||
                    response.statusCode > 599 ||
                    !response.headers ||
                    typeof response.headers !== 'object' ||
                    Array.isArray(response.headers)
                ) {
                    hop.decision = 'invalid-response';
                    return response;
                }
                hop.httpStatus = response.statusCode;
                const header = (name: string): string | null =>
                    Object.entries(response.headers).find(
                        ([key, value]) => key.toLowerCase() === name && typeof value === 'string',
                    )?.[1] ?? null;
                hop.location = header('location');
                if (hop.location) {
                    try {
                        hop.destination = new URL(hop.location, current.url).href;
                    } catch {
                        /* Invalid Location is recorded and refused. */
                    }
                }
                if (
                    response.statusCode < 300 ||
                    response.statusCode >= 400 ||
                    header('cf-mitigated') === 'challenge' ||
                    response.protectionDetected === true
                ) {
                    hop.decision = 'final-response';
                    return { ...response, finalUrl: current.url };
                }
                if (![301, 302, 307, 308].includes(response.statusCode))
                    throw new HttpTransportError(
                        'UNAUTHORIZED_REDIRECT',
                        'El estado HTTP no admite seguimiento de redirección.',
                        response.statusCode,
                    );
                let next: ProductTarget;
                try {
                    next = validateBackMarketRedirect(hop.location, current, validated);
                } catch (error) {
                    if (error instanceof PolicyError)
                        throw new HttpTransportError(error.code, error.message, response.statusCode);
                    throw error;
                }
                if (visited.has(next.url))
                    throw new HttpTransportError(
                        'REDIRECT_CYCLE',
                        'La redirección forma un ciclo; no se abrió otra conexión.',
                        response.statusCode,
                    );
                if (redirects >= limits.maxRedirects)
                    throw new HttpTransportError(
                        'REDIRECT_LIMIT',
                        'Back Market admite como máximo dos redirecciones para la misma ficha.',
                        response.statusCode,
                    );
                visited.add(next.url);
                current = next;
                hop.decision = 'validated-redirect';
                pendingRedirect = hop;
            } catch (error) {
                hop[phase] ??= performance.now() - phaseStarted;
                hop.httpStatus ??= error instanceof HttpTransportError ? error.httpStatus : null;
                hop.errorCode = 'REQUEST_FAILED';
                if (error instanceof HttpTransportError || error instanceof PolicyError) hop.errorCode = error.code;
                else if (error instanceof RequestTimeout) hop.errorCode = 'REQUEST_TIMEOUT';
                hop.decision = 'stopped';
                throw error;
            } finally {
                hop.totalMs = performance.now() - started;
            }
        }
    };
    try {
        timer = setTimeout(() => {
            rejectCancellation(new RequestTimeout('Se agotó el tiempo de la operación.'));
            controller.abort();
        }, timeoutSecs * 1000);
        return await Promise.race([cancelled, work()]);
    } finally {
        if (timer) clearTimeout(timer);
        parentSignal?.removeEventListener('abort', abort);
    }
}
