import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { esSearch } from '../globalise/es.ts';
import { labelsFor } from '../globalise/lookup.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';
import { buildFromArgs, documentFilterShape, type DocumentFilterArgs } from './documentFilters.ts';

const DIMENSIONS = ['decade', 'year', 'settlement', 'document_type', 'profession', 'archive_series'] as const;
type Dimension = (typeof DIMENSIONS)[number];

type Args = DocumentFilterArgs & { dimensions?: Dimension[]; top?: number; archive_depth?: number };

function aggsFor(dimensions: Dimension[], top: number, archiveDepth: number): Record<string, unknown> {
  const aggs: Record<string, unknown> = {};
  for (const dim of dimensions) {
    if (dim === 'decade' || dim === 'year') aggs.years = { date_histogram: { field: 'startDate', calendar_interval: 'year', min_doc_count: 1 } };
    if (dim === 'settlement') aggs.settlement = { terms: { field: 'settlement', size: top, missing: '' } };
    if (dim === 'document_type') aggs.document_type = { terms: { field: 'documentTypeIdPaths.tree', size: top } };
    // Skip the broadest levels of the profession hierarchy ("Beroepen" tells nobody much).
    if (dim === 'profession') aggs.profession = { terms: { field: 'professionIdPaths.tree', size: top, include: '([^|]+\\|){2,}[^|]+' } };
    if (dim === 'archive_series') {
      aggs.archive_series = {
        terms: { field: 'eadIdPaths.tree', size: top, include: `([^|]+\\|){${archiveDepth - 1}}[^|]+` },
        aggs: { sample: { top_hits: { size: 1, _source: ['archiveDescription', 'eadIdPaths'] } } },
      };
    }
  }
  return aggs;
}

interface Bucket {
  key: string;
  label: string;
  count: number;
  corpus_count: number;
  per_1000_corpus_documents: number;
}

const rate = (count: number, corpus: number) => (corpus ? Math.round((count / corpus) * 10_000) / 10 : 0);

export function registerAnalyzeDistribution(server: McpServer) {
  server.registerTool(
    'analyze_distribution',
    {
      title: 'Analyse how results are distributed',
      description:
        'Shows how the documents matching a search (same filters as search_documents) are spread over decades/years, places of writing, document types, professions and archive series, next to the same breakdown for the whole corpus. per_1000_corpus_documents corrects for the very uneven coverage of the archive: use it, not raw counts, to compare periods or places.',
      inputSchema: {
        ...documentFilterShape,
        dimensions: z.array(z.enum(DIMENSIONS)).min(1).max(6).default(['decade', 'settlement']),
        top: z.number().int().min(3).max(50).default(15).describe('Buckets per dimension (time dimensions are always complete).'),
        archive_depth: z.number().int().min(2).max(7).default(5).describe('Level in the archive hierarchy for archive_series (5 = series such as "Overgekomen brieven en papieren"; 7 ≈ inventory).'),
      },
      annotations: { ...READ_ONLY, title: 'Analyse distribution' },
    },
    safe(async (args: Args) => {
      const dimensions: Dimension[] = [...new Set<Dimension>(args.dimensions ?? ['decade', 'settlement'])];
      const top = args.top ?? 15;
      const built = await buildFromArgs(args);
      const aggs = aggsFor(dimensions, top, args.archive_depth ?? 5);

      // The corpus baseline uses the same aggregations without the query (cached across calls).
      const [result, corpus] = await Promise.all([
        esSearch('documents', { size: 0, track_total_hits: true, query: built.query, aggs }),
        esSearch('documents', { size: 0, track_total_hits: true, query: { match_all: {} }, aggs: { ...aggs, ...termsForAllKeys(aggs) } }),
      ]);
      const r = result.aggregations ?? {};
      const c = corpus.aggregations ?? {};

      const corpusCount = (agg: string, key: string) => (c[agg]?.buckets ?? []).find((b: any) => String(b.key_as_string ?? b.key) === key)?.doc_count ?? 0;
      const out: Record<string, unknown> = {};

      if (dimensions.includes('year') || dimensions.includes('decade')) {
        const years = new Map<number, number>();
        const corpusYears = new Map<number, number>();
        for (const b of r.years?.buckets ?? []) years.set(new Date(b.key).getUTCFullYear(), b.doc_count);
        for (const b of c.years?.buckets ?? []) corpusYears.set(new Date(b.key).getUTCFullYear(), b.doc_count);
        const series = (bucketOf: (y: number) => number, label: (k: number) => string) => {
          const grouped = new Map<number, { count: number; corpus: number }>();
          for (const [year, corpusN] of corpusYears) {
            const k = bucketOf(year);
            const entry = grouped.get(k) ?? { count: 0, corpus: 0 };
            entry.corpus += corpusN;
            entry.count += years.get(year) ?? 0;
            grouped.set(k, entry);
          }
          return [...grouped.entries()]
            .sort((a, b) => a[0] - b[0])
            .filter(([, v]) => v.count > 0 || v.corpus > 0)
            .map(([k, v]) => ({ key: String(k), label: label(k), count: v.count, corpus_count: v.corpus, per_1000_corpus_documents: rate(v.count, v.corpus) }));
        };
        if (dimensions.includes('decade')) out.decade = series((y) => Math.floor(y / 10) * 10, (k) => `${k}s`).filter((b) => b.count > 0 || b.corpus_count > 50);
        if (dimensions.includes('year')) out.year = series((y) => y, String).filter((b) => b.count > 0);
      }

      if (dimensions.includes('settlement')) {
        out.settlement = (r.settlement?.buckets ?? []).map((b: any) => {
          const corpusN = corpusCount('settlement_all', b.key) || corpusCount('settlement', b.key);
          return { key: b.key, label: b.key || '(no settlement recorded)', count: b.doc_count, corpus_count: corpusN, per_1000_corpus_documents: rate(b.doc_count, corpusN) } satisfies Bucket;
        });
      }

      for (const dim of ['document_type', 'profession'] as const) {
        if (!dimensions.includes(dim)) continue;
        const buckets = r[dim]?.buckets ?? [];
        const ids = buckets.flatMap((b: any) => String(b.key).split('|'));
        const labels = await labelsFor('concepts', ids);
        out[dim] = buckets.map((b: any) => {
          const corpusN = corpusCount(`${dim}_all`, b.key) || corpusCount(dim, b.key);
          return {
            key: String(b.key).split('|').at(-1) ?? String(b.key),
            label: String(b.key).split('|').map((id) => labels.get(id) ?? id).join(' > '),
            count: b.doc_count,
            corpus_count: corpusN,
            per_1000_corpus_documents: rate(b.doc_count, corpusN),
          } satisfies Bucket;
        });
      }

      if (dimensions.includes('archive_series')) {
        out.archive_series = (r.archive_series?.buckets ?? []).map((b: any) => {
          const depth = String(b.key).split('|').length;
          const sample = b.sample?.hits?.hits?.[0]?._source;
          const label = String(sample?.archiveDescription ?? '').split(' • ').slice(1)[depth - 1] ?? 'archive section';
          const corpusN = corpusCount('archive_series_all', b.key) || corpusCount('archive_series', b.key);
          return { key: b.key, label, count: b.doc_count, corpus_count: corpusN, per_1000_corpus_documents: rate(b.doc_count, corpusN) } satisfies Bucket;
        });
      }

      const matched = result.hits.total.value;
      const corpusTotal = corpus.hits.total.value;
      return json({
        matching_documents: matched,
        corpus_documents: corpusTotal,
        share_of_corpus: `${rate(matched, corpusTotal)} per 1000`,
        query_interpretation: built.resolutions,
        distributions: out,
        how_to_read:
          'count = matching documents in the bucket; corpus_count = all documents in that bucket; per_1000_corpus_documents normalises for coverage. Small corpus_counts make rates unstable. Documents are counted by their start date.',
        provenance: provenance([`${config.searchBase}/documents/_search`], [...built.caveats, CAVEATS.coverage], [await indexVersion('documents')]),
      });
    }),
  );
}

/**
 * For terms dimensions, the corpus baseline must include the result's buckets even when they are
 * not among the corpus' top N. A large `size` on a copy of each terms agg covers that.
 */
function termsForAllKeys(aggs: Record<string, any>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [name, agg] of Object.entries(aggs)) {
    if (!agg.terms) continue;
    extra[`${name}_all`] = { terms: { ...agg.terms, size: 2000 } };
  }
  return extra;
}
