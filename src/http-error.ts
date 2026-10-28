/** Public messages are static; never include URLs, HTML, certificate data or raw socket errors. */
export class HttpTransportError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly httpStatus: number | null = null,
    ) {
        super(message);
        this.name = 'HttpTransportError';
    }
}
