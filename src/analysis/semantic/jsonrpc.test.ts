import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  encodeMessage,
  ErrorCodes,
  JsonRpcConnection,
  type JsonRpcMessage,
  MAX_MESSAGE_BYTES,
  MessageReader,
  RpcError,
} from './jsonrpc.ts';

describe('MessageReader', () => {
  it('reassembles messages split across chunks and several messages in one chunk', () => {
    const reader = new MessageReader();
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'é' }); // multi-byte body
    const b = encodeMessage({ jsonrpc: '2.0', method: 'x' });
    const all = Buffer.concat([a, b]);
    const out: JsonRpcMessage[] = [];
    for (let i = 0; i < all.length; i += 7) out.push(...reader.push(all.subarray(i, i + 7)));
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'é' },
      { jsonrpc: '2.0', method: 'x' },
    ]);
  });

  it('accepts extra headers and any header case', () => {
    const body = '{"jsonrpc":"2.0","id":2,"result":null}';
    const raw = `content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n${body}`;
    expect(new MessageReader().push(Buffer.from(raw))).toEqual([
      { jsonrpc: '2.0', id: 2, result: null },
    ]);
  });

  it('rejects a header without Content-Length', () => {
    expect(() => new MessageReader().push(Buffer.from('X: 1\r\n\r\n{}'))).toThrow(/Content-Length/);
  });

  it('rejects a message over the size cap before reading its body', () => {
    const header = `Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`;
    expect(() => new MessageReader().push(Buffer.from(header))).toThrow(/over/);
    const endless = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 'x');
    expect(() => new MessageReader().push(endless)).toThrow(/header too long/);
  });
});

/** A connection wired to a scripted peer that sees what the client sends. */
function pair() {
  const toClient = new PassThrough();
  const toPeer = new PassThrough();
  const connection = new JsonRpcConnection(toClient, toPeer);
  const reader = new MessageReader();
  const received: JsonRpcMessage[] = [];
  toPeer.on('data', (chunk: Buffer) => received.push(...reader.push(chunk)));
  const send = (m: JsonRpcMessage) => toClient.write(encodeMessage(m));
  return { connection, received, send, toClient };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('JsonRpcConnection', () => {
  it('matches responses to requests by id', async () => {
    const { connection, received, send } = pair();
    const first = connection.request('a', { n: 1 }, 1000);
    const second = connection.request('b', null, 1000);
    await tick();
    expect(received.map((m) => [m.id, m.method])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    send({ jsonrpc: '2.0', id: 2, result: 'B' });
    send({ jsonrpc: '2.0', id: 1, result: 'A' });
    await expect(first).resolves.toBe('A');
    await expect(second).resolves.toBe('B');
  });

  it('rejects with the error code from an error response', async () => {
    const { connection, send } = pair();
    const request = connection.request('textDocument/references', {}, 1000);
    send({ jsonrpc: '2.0', id: 1, error: { code: ErrorCodes.ContentModified, message: 'busy' } });
    const err = (await request.catch((e: unknown) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(ErrorCodes.ContentModified);
  });

  it('times out a request that gets no answer', async () => {
    const { connection } = pair();
    await expect(connection.request('slow', null, 20)).rejects.toThrow(/timed out/);
  });

  it('rejects pending requests when the peer closes its output', async () => {
    const { connection, toClient } = pair();
    const request = connection.request('x', null, 1000);
    toClient.end();
    await expect(request).rejects.toThrow(/closed its output/);
    await expect(connection.request('y', null, 1000)).rejects.toThrow(/closed/);
  });

  it('answers server requests, and MethodNotFound when unhandled', async () => {
    const { connection, received, send } = pair();
    connection.onRequest('workspace/configuration', () => [{}]);
    send({ jsonrpc: '2.0', id: 'c1', method: 'workspace/configuration', params: {} });
    send({ jsonrpc: '2.0', id: 'c2', method: 'unknown/method', params: {} });
    await tick();
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 'c1', result: [{}] },
      {
        jsonrpc: '2.0',
        id: 'c2',
        error: { code: ErrorCodes.MethodNotFound, message: 'Unhandled method unknown/method' },
      },
    ]);
  });

  it('delivers notifications to their handler', async () => {
    const { connection, send } = pair();
    const seen: unknown[] = [];
    connection.onNotification('$/progress', (p) => seen.push(p));
    send({ jsonrpc: '2.0', method: '$/progress', params: { token: 1 } });
    await tick();
    expect(seen).toEqual([{ token: 1 }]);
  });
});
