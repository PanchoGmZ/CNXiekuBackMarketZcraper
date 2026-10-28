import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { it } from 'node:test';

import { createHttpsTransport, type HttpsRequester } from '../src/https-transport.js';
import { processProduct } from '../src/process-product.js';
import { json } from './helpers.js';
import { productHtml, savedProductUrl } from './samples.js';

it('verifies real loopback TLS with a fresh test certificate and rejects an untrusted certificate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tucumpa-tls-'));
    const previous = process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
    let server: ReturnType<typeof createServer> | undefined;
    try {
        const gitOpenSsl = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe');
        const openssl = process.env.OPENSSL_BIN ?? (process.platform === 'win32' && existsSync(gitOpenSsl) ? gitOpenSsl : 'openssl');
        const keyPath = join(directory, 'key.pem');
        const certPath = join(directory, 'cert.pem');
        const configPath = join(directory, 'openssl.cnf');
        await writeFile(configPath, '[req]\ndistinguished_name=dn\n[dn]\nCN=www.cnxieku.com\n');
        execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', keyPath, '-out', certPath, '-subj', '/CN=www.cnxieku.com',
            '-config', configPath, '-addext', 'subjectAltName=DNS:www.cnxieku.com'],
        { stdio: 'ignore', timeout: 15000, env: { ...process.env, OPENSSL_CONF: configPath } });
        const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
        let received = 0;
        server = createServer({ key, cert }, (_req, res) => {
            received++;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(productHtml());
        });
        await new Promise<void>((done, reject) => {
            server!.once('error', reject);
            server!.listen(0, '127.0.0.1', done);
        });
        const port = (server.address() as AddressInfo).port;
        const requester = (trust: boolean): HttpsRequester => (url, options, callback) => request(url, {
            ...options, hostname: '127.0.0.1', port, lookup: undefined, ...(trust ? { ca: cert } : {}),
        }, (incoming) => {
            assert.equal(incoming.socket.remoteAddress, '127.0.0.1');
            assert.ok('authorized' in incoming.socket && incoming.socket.authorized);
            // Only the injected test requester projects a public peer; all sockets are loopback.
            Object.defineProperty(incoming.socket, 'remoteAddress', { value: '93.184.216.34', configurable: true });
            callback(incoming);
        });
        process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = JSON.stringify(json('config/cnxieku.example.json'));
        const run = (trust: boolean) => processProduct({ url: savedProductUrl }, {
            dependencies: {
                resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                transport: createHttpsTransport(requester(trust)),
            },
        });
        const valid = await run(true);
        assert.equal(valid.httpStatus, 200);
        assert.equal(valid.product.productId, '20274');
        const untrusted = await run(false);
        assert.equal(untrusted.status, 'error');
        assert.ok(untrusted.error);
        assert.equal(received, 1);
    } finally {
        if (server?.listening) {
            server.closeAllConnections();
            await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
        }
        if (previous === undefined) delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
        else process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS = previous;
        assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'tucumpa-tls-'));
        await rm(directory, { recursive: true, force: true });
    }
});
