// Counting mentions (occurrences) rather than documents.
//
// Elasticsearch has no aggregation for term frequencies, and the term vectors API is blocked by
// the search proxy. The annotated highlighter, however, marks every matching span with
// `_hit_term=…`. With tiny fragments it returns just the matches (about 5% of the full text) and
// the marker count equals Lucene's term frequency (checked against `explain` freq, also on the
// largest document of 2.9M characters). A phrase counts once per occurrence; an entity id
// (placeId:…) counts each tagged span.

import { esSearch, type EsQuery } from './es.ts';

/** Highlight settings that return only the matching spans. */
export function mentionHighlight(highlightQuery: EsQuery) {
  return {
    fields: {
      annotatedText: {
        type: 'annotated',
        fragment_size: 1,
        number_of_fragments: 10_000,
        highlight_query: highlightQuery,
      },
    },
  };
}

export interface MentionTally {
  total: number;
  /** Per query term that matched (as Elasticsearch reports it), e.g. "timmerman", "placeId:GLOB2_937". */
  byTerm: Map<string, number>;
  /** Per surface form as written in the text, lowercased: the actual spellings found. */
  bySurface: Map<string, number>;
}

export const emptyTally = (): MentionTally => ({ total: 0, byTerm: new Map(), bySurface: new Map() });

const MARKER_RE = /\[([^\]]*)\]\(_hit_term=([^&)]*)/g;

function decodeTerm(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).replace(/^annotatedText:/, '');
  } catch {
    return raw;
  }
}

export function tallyFragments(fragments: string[], into: MentionTally = emptyTally()): MentionTally {
  for (const fragment of fragments) {
    for (const match of fragment.matchAll(MARKER_RE)) {
      into.total += 1;
      const term = decodeTerm(match[2]);
      into.byTerm.set(term, (into.byTerm.get(term) ?? 0) + 1);
      const surface = match[1].replace(/\s+/g, ' ').trim().toLowerCase();
      into.bySurface.set(surface, (into.bySurface.get(surface) ?? 0) + 1);
    }
  }
  return into;
}

export function mergeTally(into: MentionTally, from: MentionTally): MentionTally {
  into.total += from.total;
  for (const [k, v] of from.byTerm) into.byTerm.set(k, (into.byTerm.get(k) ?? 0) + v);
  for (const [k, v] of from.bySurface) into.bySurface.set(k, (into.bySurface.get(k) ?? 0) + v);
  return into;
}

export const topEntries = (map: Map<string, number>, n: number) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));

/** Mention tallies for specific documents (by persistent URI) under a query. */
export async function mentionsForDocuments(query: EsQuery, highlightQuery: EsQuery, uris: string[]): Promise<Map<string, MentionTally>> {
  const out = new Map<string, MentionTally>();
  if (!uris.length) return out;
  const data = await esSearch<{ id: string }>('documents', {
    size: uris.length,
    _source: ['id'],
    query: { bool: { must: [query], filter: [{ terms: { id: uris } }] } },
    highlight: mentionHighlight(highlightQuery),
  });
  for (const hit of data.hits.hits) out.set(hit._source.id, tallyFragments(hit.highlight?.annotatedText ?? []));
  return out;
}

export interface CountedDocument {
  id: string;
  identifier: string;
  title?: string;
  startDate?: string;
  settlement?: string;
  mentions: number;
}

export interface CorpusCount {
  mode: 'exact' | 'estimate';
  documents: number;
  /** Exact total, or the point estimate. */
  mentions: number;
  /** 95% confidence interval (estimate mode only). */
  interval?: [number, number];
  documentsCounted: number;
  tally: MentionTally;
  perDocument: CountedDocument[];
}

const SOURCE = ['id', 'identifier', 'title', 'startDate', 'settlement'];

/** Counts every matching document, in batches (search_after on the id keyword). */
export async function countExact(query: EsQuery, highlightQuery: EsQuery, documents: number, batch = 100): Promise<CorpusCount> {
  const tally = emptyTally();
  const perDocument: CountedDocument[] = [];
  let after: unknown[] | undefined;
  for (;;) {
    const data = await esSearch<Record<string, string>>('documents', {
      size: batch,
      _source: SOURCE,
      query,
      sort: [{ id: 'asc' }],
      ...(after ? { search_after: after } : {}),
      highlight: mentionHighlight(highlightQuery),
    });
    const hits = data.hits.hits as Array<(typeof data.hits.hits)[number] & { sort?: unknown[] }>;
    for (const hit of hits) {
      const docTally = tallyFragments(hit.highlight?.annotatedText ?? []);
      mergeTally(tally, docTally);
      perDocument.push({ ...pick(hit._source), mentions: docTally.total });
    }
    if (hits.length < batch) break;
    after = hits.at(-1)?.sort;
    if (!after) break;
  }
  return { mode: 'exact', documents, mentions: tally.total, documentsCounted: perDocument.length, tally, perDocument };
}

/**
 * Estimates the total from a random sample of matching documents: mean mentions per document
 * times the number of documents, with a normal-approximation 95% interval (finite population
 * corrected). Mention counts are skewed (a few long registers mention a term hundreds of times),
 * so the interval is approximate.
 */
export async function countEstimate(query: EsQuery, highlightQuery: EsQuery, documents: number, sampleSize: number, seed = 20_250_101): Promise<CorpusCount> {
  const data = await esSearch<Record<string, string>>('documents', {
    size: sampleSize,
    _source: SOURCE,
    query: { function_score: { query, random_score: { seed, field: '_seq_no' }, boost_mode: 'replace' } },
    highlight: mentionHighlight(highlightQuery),
  });
  const tally = emptyTally();
  const perDocument: CountedDocument[] = [];
  for (const hit of data.hits.hits) {
    const docTally = tallyFragments(hit.highlight?.annotatedText ?? []);
    mergeTally(tally, docTally);
    perDocument.push({ ...pick(hit._source), mentions: docTally.total });
  }
  const n = perDocument.length;
  const mean = n ? tally.total / n : 0;
  const variance = n > 1 ? perDocument.reduce((s, d) => s + (d.mentions - mean) ** 2, 0) / (n - 1) : 0;
  const fpc = documents > 1 ? Math.sqrt(Math.max(0, documents - n) / (documents - 1)) : 0;
  const half = 1.96 * documents * Math.sqrt(variance / Math.max(n, 1)) * fpc;
  const point = Math.round(mean * documents);
  return {
    mode: 'estimate',
    documents,
    mentions: point,
    interval: [Math.max(tally.total, Math.round(point - half)), Math.round(point + half)],
    documentsCounted: n,
    tally,
    perDocument,
  };
}

function pick(source: Record<string, string>): Omit<CountedDocument, 'mentions'> {
  return { id: source.id, identifier: source.identifier, title: source.title, startDate: source.startDate, settlement: source.settlement || undefined };
}
