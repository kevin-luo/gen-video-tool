import path from 'node:path';

import {
  spawnManagedProcess,
  type ManagedProcess,
} from '../process/run-process.js';

type JsonRpcId = number;

type JsonRpcSuccess = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type WanGPMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type WanGPMcpServerInfo = {
  name?: string;
  version?: string;
  protocolVersion?: string;
};

/** Narrow transport contract so providers and tests never depend on process internals. */
export interface WanGPMcpClient {
  readonly endpointDescription: string;
  readonly serverInfo: Readonly<WanGPMcpServerInfo>;
  connect(): Promise<void>;
  listTools(): Promise<WanGPMcpTool[]>;
  callTool<T = unknown>(name: string, arguments_?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export type WanGPStdioTransportOptions = {
  kind: 'stdio';
  /** Directory containing the official WanGP wgp.py entry point. */
  wanGpDirectory: string;
  pythonExecutable?: string;
  entrypoint?: string;
  extraArguments?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  log?: (level: 'debug' | 'warn' | 'error', message: string, details?: unknown) => void;
};

export type WanGPHttpTransportOptions = {
  kind: 'streamable-http';
  /** Exact MCP URL, normally http://127.0.0.1:7866/mcp. */
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  log?: (level: 'debug' | 'warn' | 'error', message: string, details?: unknown) => void;
};

export type WanGPMcpTransportOptions = WanGPStdioTransportOptions | WanGPHttpTransportOptions;

export class WanGPMcpError extends Error {
  readonly rpcCode?: number;
  readonly data?: unknown;
  readonly cause?: unknown;

  constructor(message: string, options: { rpcCode?: number; data?: unknown; cause?: unknown } = {}) {
    super(message);
    this.name = 'WanGPMcpError';
    if (options.rpcCode !== undefined) {
      this.rpcCode = options.rpcCode;
    }
    if (options.data !== undefined) {
      this.data = options.data;
    }
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

const LOOPBACK_MCP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Keep the transport local even when it is used outside the desktop wrapper.
 * This package intentionally has no remote MCP/API mode or credential flow.
 */
export const normalizeLocalWanGPMcpEndpoint = (endpoint: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new WanGPMcpError('WANGP_MCP_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new WanGPMcpError('WANGP_MCP_URL_INVALID_PROTOCOL');
  }
  if (parsed.username || parsed.password) {
    throw new WanGPMcpError('WANGP_MCP_URL_CREDENTIALS_FORBIDDEN');
  }
  if (!LOOPBACK_MCP_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new WanGPMcpError('WANGP_REMOTE_ENDPOINT_FORBIDDEN');
  }
  return parsed.toString();
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

const CLIENT_NAME = 'gen-video-tool';
const CLIENT_VERSION = '0.1.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveWanGPEntrypoint(options: WanGPStdioTransportOptions): string {
  if (options.entrypoint === undefined) {
    return path.resolve(options.wanGpDirectory, 'wgp.py');
  }
  return path.isAbsolute(options.entrypoint)
    ? path.resolve(options.entrypoint)
    : path.resolve(options.wanGpDirectory, options.entrypoint);
}

function parseJsonRpcResponse(value: unknown): JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !('id' in value)) {
    throw new WanGPMcpError('WanGP returned an invalid JSON-RPC response', { data: value });
  }
  if ('error' in value && isRecord(value.error)) {
    const rpcCode = typeof value.error.code === 'number' ? value.error.code : -32603;
    const message =
      typeof value.error.message === 'string' ? value.error.message : 'Unknown WanGP MCP error';
    return {
      jsonrpc: '2.0',
      id: typeof value.id === 'number' ? value.id : null,
      error: {
        code: rpcCode,
        message,
        ...('data' in value.error ? { data: value.error.data } : {}),
      },
    };
  }
  if (typeof value.id !== 'number' || !('result' in value)) {
    throw new WanGPMcpError('WanGP returned an incomplete JSON-RPC response', { data: value });
  }
  return { jsonrpc: '2.0', id: value.id, result: value.result };
}

function parseSseJson(text: string, expectedId: number): unknown {
  const candidates: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '' || data === '[DONE]') {
      continue;
    }
    try {
      candidates.push(JSON.parse(data) as unknown);
    } catch {
      // A keepalive or an unrelated SSE event is not a JSON-RPC response.
    }
  }
  const matched = candidates.find(
    (candidate) => isRecord(candidate) && candidate.id === expectedId,
  );
  if (matched !== undefined) {
    return matched;
  }
  const first = candidates[0];
  if (first !== undefined) {
    return first;
  }
  throw new WanGPMcpError('WanGP MCP returned an empty streamable-HTTP response');
}

function unwrapToolResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }
  if (result.isError === true) {
    const text = Array.isArray(result.content)
      ? result.content
          .filter(isRecord)
          .map((item) => (typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
      : '';
    throw new WanGPMcpError(text || 'WanGP MCP tool call failed', { data: result });
  }

  if (isRecord(result.structuredContent)) {
    const keys = Object.keys(result.structuredContent);
    if (keys.length === 1 && keys[0] === 'result') {
      return result.structuredContent.result;
    }
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    const texts = result.content
      .filter(isRecord)
      .map((item) => (typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean);
    if (texts.length === 1) {
      const only = texts[0];
      if (only !== undefined) {
        try {
          return JSON.parse(only) as unknown;
        } catch {
          return only;
        }
      }
    }
    if (texts.length > 1) {
      return texts.join('\n');
    }
  }
  return result;
}

/**
 * Dependency-free MCP client for the two transports officially exposed by WanGP.
 * It intentionally has no REST compatibility mode: WanGP does not publish a
 * stable /health, /jobs or Gradio HTTP contract.
 */
export class WanGPMcpTransport implements WanGPMcpClient {
  readonly options: WanGPMcpTransportOptions;

  #managedProcess: ManagedProcess | undefined;
  #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #connected = false;
  #connecting: Promise<void> | undefined;
  #httpSessionId: string | undefined;
  #stderrTail = '';
  #serverInfo: WanGPMcpServerInfo = {};

  constructor(options: WanGPMcpTransportOptions) {
    this.options = options.kind === 'streamable-http'
      ? {...options, endpoint: normalizeLocalWanGPMcpEndpoint(options.endpoint)}
      : options;
  }

  get endpointDescription(): string {
    if (this.options.kind === 'streamable-http') {
      return this.options.endpoint;
    }
    return `stdio:${resolveWanGPEntrypoint(this.options)}`;
  }

  get serverInfo(): Readonly<WanGPMcpServerInfo> {
    return { ...this.#serverInfo };
  }

  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    if (this.#connecting !== undefined) {
      return this.#connecting;
    }
    this.#connecting = this.#initialize()
      .catch(async (cause: unknown) => {
        this.#connected = false;
        this.#serverInfo = {};
        this.#httpSessionId = undefined;
        const failedProcess = this.#managedProcess;
        this.#managedProcess = undefined;
        if (failedProcess !== undefined) {
          failedProcess.endInput();
          await failedProcess.terminate().catch(() => undefined);
        }
        this.#rejectAll(new WanGPMcpError('WanGP MCP initialization failed', { cause }));
        throw cause;
      })
      .finally(() => {
        this.#connecting = undefined;
      });
    return this.#connecting;
  }

  async listTools(): Promise<WanGPMcpTool[]> {
    await this.connect();
    const tools: WanGPMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.#request('tools/list', cursor === undefined ? {} : { cursor });
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new WanGPMcpError('WanGP returned an invalid tools/list result', { data: result });
      }
      for (const item of result.tools) {
        if (!isRecord(item) || typeof item.name !== 'string') {
          continue;
        }
        tools.push({
          name: item.name,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...('inputSchema' in item ? { inputSchema: item.inputSchema } : {}),
        });
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool<T = unknown>(name: string, arguments_: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const result = await this.#request('tools/call', { name, arguments: arguments_ });
    return unwrapToolResult(result) as T;
  }

  async close(): Promise<void> {
    this.#connected = false;
    this.#connecting = undefined;
    this.#httpSessionId = undefined;
    this.#serverInfo = {};
    const processToStop = this.#managedProcess;
    this.#managedProcess = undefined;
    if (processToStop !== undefined) {
      processToStop.endInput();
      await processToStop.terminate();
    }
    this.#rejectAll(new WanGPMcpError('WanGP MCP transport was closed'));
  }

  async #initialize(): Promise<void> {
    if (this.options.kind === 'stdio') {
      this.#startStdioProcess();
    }
    const timeoutMs = this.options.connectTimeoutMs ?? 30_000;
    const result = await this.#requestRaw(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
      timeoutMs,
    );
    if (!isRecord(result)) {
      throw new WanGPMcpError('WanGP returned an invalid initialize result', { data: result });
    }
    const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : {};
    this.#serverInfo = {
      ...(typeof serverInfo.name === 'string' ? { name: serverInfo.name } : {}),
      ...(typeof serverInfo.version === 'string' ? { version: serverInfo.version } : {}),
      ...(typeof result.protocolVersion === 'string'
        ? { protocolVersion: result.protocolVersion }
        : {}),
    };
    await this.#notify('notifications/initialized', {});
    this.#connected = true;
  }

  #startStdioProcess(): void {
    if (this.options.kind !== 'stdio' || this.#managedProcess !== undefined) {
      return;
    }
    const entrypoint = resolveWanGPEntrypoint(this.options);
    const args = [
      entrypoint,
      '--mcp',
      '--mcp-transport',
      'stdio',
      ...(this.options.extraArguments ?? []),
    ];
    const managed = spawnManagedProcess(this.options.pythonExecutable ?? 'python', args, {
      cwd: path.resolve(this.options.wanGpDirectory),
      ...(this.options.environment === undefined ? {} : { env: this.options.environment }),
      onStdoutLine: (line) => this.#handleStdioLine(line),
      onStderrLine: (line) => {
        this.#stderrTail = `${this.#stderrTail}\n${line}`.slice(-16_384);
        this.options.log?.('debug', 'WanGP MCP stderr', line);
      },
    });
    this.#managedProcess = managed;
    void managed.exited.then(
      (exit) => {
        if (this.#managedProcess !== managed) {
          return;
        }
        this.#managedProcess = undefined;
        this.#connected = false;
        this.#rejectAll(
          new WanGPMcpError(
            `WanGP MCP process exited (code ${String(exit.exitCode)}, signal ${String(exit.signal)})`,
            { data: { ...exit, stderr: this.#stderrTail } },
          ),
        );
      },
      (cause) => {
        if (this.#managedProcess === managed) {
          this.#managedProcess = undefined;
          this.#connected = false;
        }
        this.#rejectAll(new WanGPMcpError('WanGP MCP process failed', { cause }));
      },
    );
  }

  #handleStdioLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      this.options.log?.('warn', 'Ignored non-JSON output on WanGP MCP stdout', trimmed);
      return;
    }
    let response: JsonRpcResponse;
    try {
      response = parseJsonRpcResponse(raw);
    } catch (cause) {
      this.options.log?.('warn', 'Ignored invalid WanGP MCP message', cause);
      return;
    }
    if (response.id === null) {
      this.options.log?.(
        'warn',
        'WanGP MCP returned an error without a request id',
        'error' in response ? response.error : response,
      );
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if ('error' in response) {
      pending.reject(
        new WanGPMcpError(response.error.message, {
          rpcCode: response.error.code,
          ...('data' in response.error ? { data: response.error.data } : {}),
        }),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.#requestRaw(method, params, this.options.requestTimeoutMs ?? 120_000);
  }

  async #requestRaw(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this.#nextRequestId++;
    if (this.options.kind === 'streamable-http') {
      return this.#httpRequest({ jsonrpc: '2.0', id, method, params }, id, timeoutMs);
    }
    const managed = this.#managedProcess;
    if (managed === undefined) {
      throw new WanGPMcpError('WanGP MCP stdio process is not running');
    }

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WanGPMcpError(`WanGP MCP request timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await managed.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (cause) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new WanGPMcpError('Unable to write to WanGP MCP process', { cause }));
      }
    }
    return response;
  }

  async #notify(method: string, params: Record<string, unknown>): Promise<void> {
    const payload = { jsonrpc: '2.0', method, params };
    if (this.options.kind === 'streamable-http') {
      await this.#httpNotification(payload, this.options.requestTimeoutMs ?? 120_000);
      return;
    }
    if (this.#managedProcess === undefined) {
      throw new WanGPMcpError('WanGP MCP stdio process is not running');
    }
    await this.#managedProcess.write(`${JSON.stringify(payload)}\n`);
  }

  async #httpRequest(
    payload: Record<string, unknown>,
    expectedId: number,
    timeoutMs: number,
  ): Promise<unknown> {
    const response = await this.#fetchHttp(payload, timeoutMs);
    const text = await response.text();
    let raw: unknown;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    try {
      raw = contentType.includes('text/event-stream')
        ? parseSseJson(text, expectedId)
        : (JSON.parse(text) as unknown);
    } catch (cause) {
      if (cause instanceof WanGPMcpError) {
        throw cause;
      }
      throw new WanGPMcpError('WanGP MCP returned an unreadable HTTP response', {
        data: text.slice(0, 4_096),
        cause,
      });
    }
    const rpc = parseJsonRpcResponse(raw);
    if ('error' in rpc) {
      throw new WanGPMcpError(rpc.error.message, {
        rpcCode: rpc.error.code,
        ...('data' in rpc.error ? { data: rpc.error.data } : {}),
      });
    }
    return rpc.result;
  }

  async #httpNotification(payload: Record<string, unknown>, timeoutMs: number): Promise<void> {
    const response = await this.#fetchHttp(payload, timeoutMs);
    // Notifications conventionally return 202 with no body.  Some MCP servers
    // return an empty 200; both mean the notification was accepted.
    await response.arrayBuffer();
  }

  async #fetchHttp(payload: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    if (this.options.kind !== 'streamable-http') {
      throw new WanGPMcpError('Internal transport mismatch');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...this.options.headers,
          ...(this.#httpSessionId === undefined
            ? {}
            : { 'mcp-session-id': this.#httpSessionId }),
          ...(this.#serverInfo.protocolVersion === undefined
            ? {}
            : { 'mcp-protocol-version': this.#serverInfo.protocolVersion }),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId !== null && sessionId !== '') {
        this.#httpSessionId = sessionId;
      }
      if (!response.ok) {
        const body = await response.text();
        throw new WanGPMcpError(
          `WanGP MCP HTTP request failed (${response.status} ${response.statusText})`,
          { data: body.slice(0, 4_096) },
        );
      }
      return response;
    } catch (cause) {
      if (cause instanceof WanGPMcpError) {
        throw cause;
      }
      const timedOut = controller.signal.aborted;
      throw new WanGPMcpError(
        timedOut
          ? `WanGP MCP HTTP request timed out after ${timeoutMs} ms`
          : `Unable to reach WanGP MCP at ${this.options.endpoint}: ${errorMessage(cause)}`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #rejectAll(error: WanGPMcpError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function createWanGPMcpTransport(options: WanGPMcpTransportOptions): WanGPMcpTransport {
  return new WanGPMcpTransport(options);
}
