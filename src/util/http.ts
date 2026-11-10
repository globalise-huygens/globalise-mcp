import { config } from '../config.ts';
import { LruCache } from './cache.ts';
import { Semaphore } from './semaphore.ts';

export class UpstreamError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

const upstream = new Semaphore(config.maxConcurrentUpstream);

/** Runs any other upstream call (e.g. image downloads) under the same concurrency cap. */
export const withUpstreamSlot = <T>(task: () => Promise<T>): Promise<T> => upstream.run(task);
const cache = new LruCache<unknown>(config.cacheEntries, config.cacheTtlMs);

interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  /** Skip the response cache (POST requests are cached by body unless this is set). */
  noCache?: boolean;
  maxBytes?: number;
}

/**
 * Fetches JSON from a GLOBALISE service. Always asks for JSON-LD: the persistent identifiers
 * content-negotiate, and without this header thesaurus URIs redirect to an HTML page.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const key = `${method} ${url} ${options.body ?? ''}`;
  const load = () => upstream.run(() => doFetch<T>(url, method, options));
  if (options.noCache) return load();
  return cache.getOrCompute(key, load) as Promise<T>;
}

async function doFetch<T>(url: string, method: string, options: FetchJsonOptions): Promise<T> {
  const headers: Record<string, string> = {
    // Must be exactly this: thesaurus URIs only redirect to JSON-LD for this value, any other
    // Accept header (even one that includes it with a weight) lands on the Skosmos HTML page.
    Accept: 'application/ld+json',
    'User-Agent': config.userAgent,
  };
  if (options.contentType) headers['Content-Type'] = options.contentType;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(`Could not reach ${new URL(url).host}: ${reason}`, 0, url);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new UpstreamError(`${response.status} ${response.statusText} from ${url}${detail ? `: ${detail}` : ''}`, response.status, url);
  }

  const maxBytes = options.maxBytes ?? config.maxRecordBytes;
  const declared = Number(response.headers.get('content-length') ?? 0);
  // content-length is the compressed size when gzip is used; this is only a cheap early check.
  if (declared > maxBytes) {
    throw new UpstreamError(`Response from ${url} is too large (${declared} bytes)`, 413, url);
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new UpstreamError(`Response from ${url} is too large (${text.length} characters)`, 413, url);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError(`Expected JSON from ${url} but got: ${text.slice(0, 120)}`, 502, url);
  }
}
