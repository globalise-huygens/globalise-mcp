import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IndexKey } from '../config.ts';
import { INDICES } from '../config.ts';
import { esSearch } from '../globalise/es.ts';
import { LruCache } from '../util/cache.ts';
import { UpstreamError } from '../util/http.ts';

/** What every answer carries, so users can see where data came from and how far to trust it. */
export interface Provenance {
  sources: string[];
  index_versions?: string[];
  retrieved_at: string;
  caveats: string[];
}

export function provenance(sources: string[], caveats: string[], indexVersions?: string[]): Provenance {
  return {
    sources: [...new Set(sources)],
    ...(indexVersions?.length ? { index_versions: [...new Set(indexVersions)] } : {}),
    retrieved_at: new Date().toISOString(),
    caveats,
  };
}

export const CAVEATS = {
  htr: 'Texts are uncorrected machine transcriptions (HTR) of 17th–18th-century Dutch: expect misreadings and spelling variation; a missing hit is weak evidence.',
  annotations: 'Entity and event tags are generated automatically and contain errors; only some place mentions are linked to place records.',
  names: 'Named persons, ships, organisations and polities are matched by spelling, not by id: homonyms cause false hits, unrecorded spellings cause misses.',
  roles: 'personId tags in the text are role/profession concepts (e.g. koopman), not links to person records.',
  coverage: 'The corpus is a colonial company archive with uneven coverage across time and places; compare against corpus totals before interpreting counts.',
  documents: 'Document boundaries, titles and dates are partly automatically derived; dates can be year-level approximations.',
  referenceData: 'Reference records are compiled from several sources and may be incomplete or undisambiguated; check the cited sources.',
  verify: 'Verify quotations, names and numbers on the scan (get_scan with quote=...) before relying on them.',
} as const;

const versionCache = new LruCache<string>(20, 60 * 60_000);

/** The concrete index name behind an alias (e.g. annotated-documents.2026.11.05), for citation. */
export async function indexVersion(index: IndexKey): Promise<string> {
  return versionCache.getOrCompute(index, async () => {
    const data = await esSearch(index, { size: 1, _source: false, query: { match_all: {} } });
    return data.hits.hits[0]?._index ?? INDICES[index];
  });
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof UpstreamError
    ? `GLOBALISE service error: ${error.message}${error.status === 429 || error.status >= 500 ? ' (the service may be busy; try again shortly or narrow the request)' : ''}`
    : error instanceof Error
      ? error.message
      : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wraps a tool handler so failures become readable tool errors instead of protocol errors. */
export function safe<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
