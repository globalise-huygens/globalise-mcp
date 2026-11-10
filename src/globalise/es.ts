import { config, INDICES, type IndexKey } from '../config.ts';
import { fetchJson } from '../util/http.ts';

export interface EsHit<S = Record<string, unknown>> {
  _index: string;
  _id: string;
  _score: number | null;
  _source: S;
  highlight?: Record<string, string[]>;
}

export interface EsResponse<S = Record<string, unknown>> {
  took: number;
  hits: { total: { value: number; relation: 'eq' | 'gte' }; hits: EsHit<S>[] };
  aggregations?: Record<string, any>;
}

export type EsQuery = Record<string, unknown>;

export async function esSearch<S = Record<string, unknown>>(index: IndexKey, body: Record<string, unknown>): Promise<EsResponse<S>> {
  return fetchJson<EsResponse<S>>(`${config.searchBase}/${INDICES[index]}/_search`, {
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
  });
}

export async function esMsearch(searches: Array<{ index: IndexKey; body: Record<string, unknown> }>): Promise<Array<EsResponse | { error: unknown }>> {
  if (!searches.length) return [];
  const ndjson = `${searches.flatMap(({ index, body }) => [JSON.stringify({ index: INDICES[index] }), JSON.stringify(body)]).join('\n')}\n`;
  const data = await fetchJson<{ responses: Array<EsResponse | { error: unknown }> }>(`${config.searchBase}/_msearch`, {
    method: 'POST',
    body: ndjson,
    contentType: 'application/x-ndjson',
  });
  return data.responses ?? [];
}

export const countOf = (response: unknown): number => Number((response as EsResponse)?.hits?.total?.value ?? 0);

export const countBody = (query: EsQuery) => ({ size: 0, track_total_hits: true, query });

/** Titles in the object indices sometimes pack several spellings into one string with "|". */
export function splitTitles(titles: unknown): string[] {
  const list = Array.isArray(titles) ? titles : titles ? [titles] : [];
  return [...new Set(list.flatMap((title) => String(title).split('|')).map((title) => title.trim()).filter(Boolean))];
}

/** The concrete, dated index name behind an alias (e.g. annotated-documents.2026.11.05), for citations. */
export function indexVersions(response: EsResponse): string[] {
  return [...new Set(response.hits.hits.map((hit) => hit._index))];
}
