import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWebhookUrl, HttpRequestError, postBody } from './index';

let server: Server;
let base = '';
const received: { body: string; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      received.push({ body, headers: request.headers });
      if (request.url === '/slow') {
        // Answers one byte at a time, never finishing within the deadline.
        response.writeHead(200);
        const timer = setInterval(() => response.write('.'), 20);
        response.on('close', () => clearInterval(timer));
        return;
      }
      response.writeHead(request.url === '/gone' ? 410 : 204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('postBody', () => {
  it('sends exactly the given text with the given headers', async () => {
    const text = '{"b":1,"a":"ب"}';
    const result = await postBody(`${base}/hook`, text, {
      allowPrivateNetwork: true,
      userAgent: 'BusinessOS-Webhooks/1',
      headers: { 'businessos-signature': 't=1,v1=abc' },
    });
    expect(result.status).toBe(204);
    const last = received.at(-1);
    expect(last?.body).toBe(text);
    expect(last?.headers['user-agent']).toBe('BusinessOS-Webhooks/1');
    expect(last?.headers['businessos-signature']).toBe('t=1,v1=abc');
  });

  it('reports non-2xx answers and bounds the whole exchange', async () => {
    const gone = await postBody(`${base}/gone`, '{}', { allowPrivateNetwork: true }).catch(
      (caught: unknown) => caught,
    );
    expect(gone).toBeInstanceOf(HttpRequestError);
    expect((gone as HttpRequestError).status).toBe(410);
    expect((gone as HttpRequestError).retryable).toBe(false);

    const started = Date.now();
    const slow = await postBody(`${base}/slow`, '{}', {
      allowPrivateNetwork: true,
      timeoutMs: 300,
    }).catch((caught: unknown) => caught);
    expect(slow).toBeInstanceOf(HttpRequestError);
    expect((slow as HttpRequestError).retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses private destinations unless explicitly allowed', () => {
    expect(() => checkWebhookUrl(`${base}/hook`)).toThrow(HttpRequestError);
    expect(() => checkWebhookUrl('https://10.0.0.5/hook')).toThrow(HttpRequestError);
    expect(() =>
      checkWebhookUrl('https://api.businessos.example/x', false, ['api.businessos.example']),
    ).toThrow('This URL points at BusinessOS itself');
  });
});
