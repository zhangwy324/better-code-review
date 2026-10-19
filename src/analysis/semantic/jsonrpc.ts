// JSON-RPC 2.0 over a byte stream with LSP's `Content-Length` framing (ADR 0001: our own client,
// no dependencies). Transport only: it knows nothing about LSP methods.
import type { Readable, Writable } from 'node:stream';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error codes the client acts on. */
export const ErrorCodes = { MethodNotFound: -32601, ContentModified: -32801 } as const;

/** An error response from the server, or a local failure (timeout, closed connection). */
export class RpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** Splits a byte stream into framed messages. Tolerates chunks that split headers or bodies. */
export class MessageReader {
  #buffer: Buffer = Buffer.alloc(0);

  /** Appends a chunk and returns every message it completed. Throws on a malformed header. */
  push(chunk: Buffer): JsonRpcMessage[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return messages;
      const header = this.#buffer.subarray(0, headerEnd).toString('ascii');
      const match = /^content-length: *(\d+)$/im.exec(header);
      if (!match) throw new Error(`LSP message without Content-Length: ${JSON.stringify(header)}`);
      const start = headerEnd + 4;
      const end = start + Number(match[1]);
      if (this.#buffer.length < end) return messages;
      messages.push(
        JSON.parse(this.#buffer.subarray(start, end).toString('utf8')) as JsonRpcMessage,
      );
      this.#buffer = this.#buffer.subarray(end);
    }
  }
}

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

type RequestHandler = (params: unknown) => unknown;
type NotificationHandler = (params: unknown) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One JSON-RPC peer. Requests time out individually; closing the connection rejects every
 * pending request, so a crashed server never leaves a caller waiting.
 */
export class JsonRpcConnection {
  readonly #output: Writable;
  readonly #reader = new MessageReader();
  readonly #pending = new Map<number, Pending>();
  readonly #requestHandlers = new Map<string, RequestHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();
  #nextId = 1;
  #closed: string | null = null;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    input.on('data', (chunk: Buffer) => {
      let messages: JsonRpcMessage[];
      try {
        messages = this.#reader.push(chunk);
      } catch (err) {
        this.close(`protocol error: ${(err as Error).message}`);
        return;
      }
      for (const message of messages) this.#dispatch(message);
    });
    input.on('end', () => this.close('the server closed its output'));
    // Writing to a dead process fails asynchronously; the exit handler reports the cause.
    output.on('error', (err) => this.close(`write failed: ${err.message}`));
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Handles a server-to-client request. Unhandled ones get a `MethodNotFound` error. */
  onRequest(method: string, handler: RequestHandler): void {
    this.#requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.#notificationHandlers.set(method, handler);
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.#closed !== null) return Promise.reject(new RpcError(`${method}: ${this.#closed}`));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed === null) this.#write({ jsonrpc: '2.0', method, params });
  }

  /** Rejects all pending requests with `reason`. Idempotent. */
  close(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(`${pending.method}: ${reason}`));
      this.#pending.delete(id);
    }
  }

  #write(message: JsonRpcMessage): void {
    this.#output.write(encodeMessage(message));
  }

  #dispatch(message: JsonRpcMessage): void {
    if (message.method === undefined) {
      const pending = typeof message.id === 'number' ? this.#pending.get(message.id) : undefined;
      if (!pending) return;
      this.#pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new RpcError(`${pending.method}: ${message.error.message}`, message.error.code),
        );
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }
    if (message.id === undefined || message.id === null) {
      this.#notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    const handler = this.#requestHandlers.get(message.method);
    if (!handler) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: ErrorCodes.MethodNotFound, message: `Unhandled method ${message.method}` },
      });
      return;
    }
    let result: unknown;
    try {
      result = handler(message.params);
    } catch (err) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: (err as Error).message },
      });
      return;
    }
    this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
  }
}
