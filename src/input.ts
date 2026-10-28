import { MAX_RESPONSE_BYTES, validResponseLimit } from './limits.js';
import { isRecord } from './product.js';
import { PolicyError, type ProductTarget, validateProductUrl } from './url-policy.js';

export const mockScenarios = [
    'complete',
    'partial',
    'forbidden',
    'not_found',
    'rate_limited',
    'timeout',
    'protected',
    'redirect',
    'error',
    'html',
] as const;
export type MockScenario = (typeof mockScenarios)[number];
export type Mode = 'product' | 'mock' | 'html';
export type OutputFormat = 'canonical' | 'reference1688';
export interface Input {
    mode: Mode;
    outputFormat: OutputFormat;
    target: ProductTarget;
    timeoutSecs: number;
    mockScenario: MockScenario;
    maxResponseBytes: number;
    html?: string;
}
export function parseInput(raw: unknown): Input {
    if (
        !isRecord(raw) ||
        Object.keys(raw).some(
            (key) =>
                !['mode', 'outputFormat', 'url', 'timeoutSecs', 'mockScenario', 'maxResponseBytes', 'html'].includes(
                    key,
                ),
        )
    ) {
        throw new PolicyError('INVALID_INPUT', 'El input contiene campos no admitidos para un producto.');
    }
    const mode = raw.mode === undefined ? 'product' : raw.mode;
    if (mode !== 'product' && mode !== 'mock' && mode !== 'html')
        throw new PolicyError('INVALID_MODE', 'mode debe ser product, html o mock.');
    const outputFormat = raw.outputFormat === undefined ? 'canonical' : raw.outputFormat;
    if (outputFormat !== 'canonical' && outputFormat !== 'reference1688')
        throw new PolicyError('INVALID_OUTPUT_FORMAT', 'outputFormat debe ser canonical o reference1688.');
    const target = validateProductUrl(raw.url);
    const maxResponseBytes = raw.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : raw.maxResponseBytes;
    if (!validResponseLimit(maxResponseBytes))
        throw new PolicyError('INVALID_SIZE_LIMIT', 'maxResponseBytes debe estar entre 1024 y 2097152.');
    if (mode === 'html') {
        if (typeof raw.html !== 'string' || !raw.html.trim())
            throw new PolicyError('INVALID_HTML_INPUT', 'El modo html requiere un documento HTML suministrado.');
        if (Buffer.byteLength(raw.html, 'utf8') > maxResponseBytes)
            throw new PolicyError('HTML_TOO_LARGE', 'El HTML suministrado excede el límite de tamaño.');
    } else if (raw.html !== undefined) throw new PolicyError('INVALID_HTML_INPUT', 'html solo se admite en modo html.');
    const timeoutSecs = raw.timeoutSecs === undefined ? 30 : raw.timeoutSecs;
    if (typeof timeoutSecs !== 'number' || !Number.isInteger(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 60) {
        throw new PolicyError('INVALID_TIMEOUT', 'timeoutSecs debe ser un entero entre 1 y 60.');
    }
    const scenario = raw.mockScenario === undefined ? 'complete' : raw.mockScenario;
    if (!mockScenarios.some((value) => value === scenario) || (mode !== 'mock' && raw.mockScenario !== undefined)) {
        throw new PolicyError(
            'INVALID_SCENARIO',
            'mockScenario solo se acepta en modo mock y debe ser un escenario conocido.',
        );
    }
    return {
        mode,
        outputFormat,
        target,
        timeoutSecs,
        mockScenario: scenario as MockScenario,
        maxResponseBytes,
        html: raw.html as string | undefined,
    };
}
