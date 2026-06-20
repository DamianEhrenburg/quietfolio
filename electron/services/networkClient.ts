import { net } from "electron";
import http from "node:http";
import https from "node:https";

export interface FetchJsonOptions {
  timeoutMs: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Обход Chromium/net.fetch — полезно для api.fantlab.ru (Perl/Mojolicious). */
  preferNodeTransport?: boolean;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isSslOrTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /handshake|SSL|TLS|ERR_SSL|ERR_CERT|ERR_CONNECTION_CLOSED|CERT_|net_error -100|ECONNRESET|ERR_CONNECTION_RESET|connection reset|ERR_HTTP2|HTTP2_PING|http2/i.test(error.message);
}

function readableNetworkError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /aborted|timeout/i.test(error.message)) {
      return "Превышено время ожидания ответа";
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error.message)) {
      return "Не удалось разрешить адрес сервиса (ошибка DNS)";
    }
    if (/ECONNRESET|ERR_CONNECTION_RESET|connection reset/i.test(error.message)) {
      return "Соединение было разорвано";
    }
    if (/handshake|SSL|TLS|ERR_SSL|ERR_CERT|ERR_CONNECTION_CLOSED|CERT_/i.test(error.message)) {
      return "Ошибка защищённого соединения (SSL). Часто из‑за VPN или прокси";
    }
    if (/ERR_HTTP2|HTTP2_PING|http2/i.test(error.message)) {
      return "Ошибка HTTP/2-соединения";
    }
    if (/^net::ERR_/i.test(error.message)) {
      const code = error.message.replace(/^net::ERR_/i, "");
      if (/CONNECTION_RESET/i.test(code)) return "Соединение было разорвано";
      if (/HTTP2|PING/i.test(code)) return "Ошибка HTTP/2-соединения";
      if (/NAME_NOT_RESOLVED|DNS/i.test(code)) return "Не удалось разрешить адрес сервиса (ошибка DNS)";
      if (/TIMED_OUT|TIMEOUT/i.test(code)) return "Превышено время ожидания ответа";
      return `Сетевая ошибка: ${code.replace(/_/g, " ").toLowerCase()}`;
    }
    if (/ERR_PROXY|proxy/i.test(error.message)) {
      return "Ошибка прокси или VPN";
    }
    return error.message;
  }
  return String(error);
}

function shouldUseNodeFallback(error: unknown) {
  if (isSslOrTransportError(error)) return true;
  const message = readableNetworkError(error);
  return /HTTP\/2|ERR_HTTP2|HTTP2_PING|Соединение было разорвано|connection reset|ERR_CONNECTION_RESET|SSL|VPN|прокси/i.test(message);
}

function nodeFetchResponse(
  url: string,
  options: FetchJsonOptions
): Promise<{ status: number; statusText: string; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          ...options.headers,
          Connection: "close",
          "Accept-Encoding": "identity"
        },
        timeout: options.timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            body: Buffer.concat(chunks),
            headers: response.headers
          });
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("Превышено время ожидания ответа"));
    });
    request.on("error", reject);
    request.end();
  });
}

class NodeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  private readonly body: Buffer;

  constructor(
    status: number,
    statusText: string,
    body: Buffer,
    headers: http.IncomingHttpHeaders
  ) {
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.ok = status >= 200 && status < 300;
    this.headers = {
      get: (name: string) => {
        const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
        const value = key ? headers[key] : undefined;
        if (Array.isArray(value)) return value[0] ?? null;
        return value ?? null;
      }
    };
  }

  async arrayBuffer() {
    const copy = Buffer.from(this.body);
    return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
  }

  async text() {
    return this.body.toString("utf8");
  }

  async json() {
    return JSON.parse(this.body.toString("utf8")) as unknown;
  }
}

async function fetchWithNode(url: string, options: FetchJsonOptions): Promise<NodeFetchResponse> {
  const response = await nodeFetchResponse(url, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }
  return new NodeFetchResponse(response.status, response.statusText, response.body, response.headers);
}

export async function fetchResponse(
  url: string,
  options: FetchJsonOptions
): Promise<Response> {
  const retries = Math.max(0, options.retries ?? 2);
  let lastError: unknown = null;

  if (options.preferNodeTransport) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchWithNode(url, options) as unknown as Response;
      } catch (error) {
        lastError = error;
        if (attempt >= retries) break;
        await delay(400 * 2 ** attempt);
      }
    }
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await net.fetch(url, {
        method: "GET",
        headers: {
          ...options.headers,
          Connection: "close"
        },
        signal: controller.signal,
        cache: "no-store"
      });

      if (!response.ok) {
        if (attempt < retries && shouldRetryStatus(response.status)) {
          await delay(350 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries && isSslOrTransportError(error)) {
        try {
          const fallback = await fetchWithNode(url, options);
          return fallback as unknown as Response;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      } else if (attempt < retries && shouldUseNodeFallback(error)) {
        try {
          const fallback = await fetchWithNode(url, options);
          return fallback as unknown as Response;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
      if (attempt >= retries) break;
      await delay(350 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (shouldUseNodeFallback(lastError)) {
    try {
      const fallback = await fetchWithNode(url, options);
      return fallback as unknown as Response;
    } catch (fallbackError) {
      lastError = fallbackError;
    }
  }

  throw new Error(readableNetworkError(lastError));
}

export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions
): Promise<T> {
  const response = await fetchResponse(url, options);
  return (await response.json()) as T;
}

export function describeNetworkError(error: unknown) {
  return readableNetworkError(error);
}
