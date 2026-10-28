import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { log } from 'apify';

import { decodeHtmlBytes } from '../html-bytes.js';
import { type OutputFormat,parseInput } from '../input.js';
import { MAX_RESPONSE_BYTES } from '../limits.js';

/** Local CLI only. The Actor never accepts a filesystem path from its JSON input. */
export async function prepareHtmlInput(
    file: string,
    url: string,
    workspace = process.cwd(),
    outputFormat: OutputFormat = 'canonical',
): Promise<string> {
    const source = await open(file, 'r');
    let bytes: Buffer;
    try {
        const info = await source.stat();
        if (!info.isFile() || info.size > MAX_RESPONSE_BYTES)
            throw new Error('Expected an HTML file of at most 2 MiB.');
        bytes = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
        let used = 0;
        while (used < bytes.length) {
            const read = await source.read(bytes, used, bytes.length - used, null);
            if (!read.bytesRead) break;
            used += read.bytesRead;
        }
        bytes = bytes.subarray(0, used);
    } finally {
        await source.close();
    }
    const html = decodeHtmlBytes(bytes);
    const input = { mode: 'html', outputFormat, url, timeoutSecs: 30, maxResponseBytes: MAX_RESPONSE_BYTES, html };
    parseInput(input);
    const store = resolve(workspace, 'storage/key_value_stores/default');
    await mkdir(store, { recursive: true });
    const output = resolve(store, 'INPUT.json');
    try {
        await copyFile(output, resolve(store, `INPUT.before-html-file.${randomUUID()}.json`));
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await writeFile(output, `${JSON.stringify(input, null, 4)}\n`, 'utf8');
    return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    if (
        ![4, 6].includes(args.length) ||
        args[0] !== '--file' ||
        args[2] !== '--url' ||
        (args.length === 6 && args[4] !== '--output-format')
    ) {
        log.error(
            'Usage: npm run prepare:html -- --file <legitimate-html-file> --url <single-product-url> [--output-format canonical|reference1688]',
        );
        process.exitCode = 1;
    } else {
        try {
            const output = await prepareHtmlInput(
                args[1],
                args[3],
                process.cwd(),
                (args[5] ?? 'canonical') as OutputFormat,
            );
            log.info('HTML input prepared. Run: apify run --no-purge', { output });
        } catch {
            log.error('Could not prepare the supplied HTML. Check the file, URL, encoding and 2 MiB limit.');
            process.exitCode = 1;
        }
    }
}
