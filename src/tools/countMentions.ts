import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { esSearch } from '../globalise/es.ts';
import { viewerUrlForDocument } from '../globalise/ids.ts';
import { countEstimate, countExact, topEntries, type CorpusCount } from '../globalise/mentions.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';
import { buildFromArgs, documentFilterShape, type DocumentFilterArgs } from './documentFilters.ts';

type Args = DocumentFilterArgs & { max_exact_documents?: number; sample_size?: number; top_documents?: number };

const WHAT_COUNTS =
  'A mention is one occurrence of a matching word, phrase or tagged entity in the transcription (a phrase counts once; place:<id> counts each tagged span). Counts come from the search highlighter and equal Elasticsearch term frequencies.';

export function registerCountMentions(server: McpServer) {
  server.registerTool(
    'count_mentions',
    {
      title: 'Count mentions (not documents)',
      description:
        'Counts how often the search terms occur in the transcriptions in total (search_documents and analyze_distribution count documents). Same filters as search_documents; the query or entities must contain something that occurs in the text (words, phrases, place ids, role/annotation tags). Returns the total, the spellings actually matched (useful with wildcards), mentions per decade normalised by corpus size, and the documents with most mentions. Exact up to max_exact_documents matching documents, otherwise estimated from a random sample with a 95% interval.',
      inputSchema: {
        ...documentFilterShape,
        max_exact_documents: z.number().int().min(10).max(2000).default(500).describe('Count every document when the search matches at most this many; otherwise estimate from a sample.'),
        sample_size: z.number().int().min(50).max(500).default(300).describe('Documents in the random sample for estimates.'),
        top_documents: z.number().int().min(0).max(25).default(10),
      },
      annotations: { ...READ_ONLY, title: 'Count mentions' },
    },
    safe(async (args: Args) => {
      const built = await buildFromArgs(args);
      if (!built.highlight) {
        throw new Error('Nothing in this search occurs in the text (only filters such as year, settlement or document type). Add words, a phrase, an entity id or an annotation type to count mentions of.');
      }

      const total = await esSearch('documents', { size: 0, track_total_hits: true, query: built.query });
      const documents = total.hits.total.value;
      const maxExact = args.max_exact_documents ?? 500;
      const result: CorpusCount = documents === 0
        ? { mode: 'exact', documents: 0, mentions: 0, documentsCounted: 0, tally: { total: 0, byTerm: new Map(), bySurface: new Map() }, perDocument: [] }
        : documents <= maxExact
          ? await countExact(built.query, built.highlight, documents)
          : await countEstimate(built.query, built.highlight, documents, Math.min(args.sample_size ?? 300, documents));

      const counts = result.perDocument.map((d) => d.mentions).sort((a, b) => a - b);
      const exact = result.mode === 'exact';

      return json({
        documents_matching: documents,
        mentions: exact
          ? { mode: 'exact', total: result.mentions }
          : {
              mode: 'estimate',
              estimate: result.mentions,
              interval_95: result.interval,
              sample_documents: result.documentsCounted,
              sample_mentions: result.tally.total,
              note: `Estimated from a random sample of ${result.documentsCounted} of ${documents} documents. Raise max_exact_documents (up to 2000) or narrow the search for an exact count.`,
            },
        per_document: counts.length
          ? { mean: round(result.tally.total / counts.length), median: counts[Math.floor(counts.length / 2)], max: counts.at(-1), ...(exact ? {} : { based_on: 'sample' }) }
          : null,
        by_query_term: topEntries(result.tally.byTerm, 20).map((e) => ({ term: e.key, mentions: e.count })),
        spellings_found: topEntries(result.tally.bySurface, 40).map((e) => ({ spelling: e.key, mentions: e.count })),
        ...(exact && documents ? { by_decade: await byDecade(result) } : {}),
        top_documents: [...result.perDocument]
          .sort((a, b) => b.mentions - a.mentions)
          .slice(0, args.top_documents ?? 10)
          .map((d) => ({ document_id: d.identifier, title: d.title, date: d.startDate, settlement: d.settlement ?? null, mentions: d.mentions, viewer_url: viewerUrlForDocument(d.identifier) })),
        ...(exact ? {} : { breakdowns_note: 'by_query_term, spellings_found and top_documents are based on the sample.' }),
        what_counts: WHAT_COUNTS,
        query_interpretation: built.resolutions,
        provenance: provenance(
          [`${config.searchBase}/documents/_search`],
          [...built.caveats, 'HTR errors hide some occurrences; long registers and lists can dominate totals, so also look at per-document figures and top_documents.'],
          [await indexVersion('documents')],
        ),
      });
    }),
  );
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Mentions per decade, next to the corpus size of that decade (documents), to normalise. */
async function byDecade(result: CorpusCount) {
  const corpus = await esSearch('documents', {
    size: 0,
    query: { match_all: {} },
    aggs: { years: { date_histogram: { field: 'startDate', calendar_interval: 'year', min_doc_count: 1 } } },
  });
  const corpusByDecade = new Map<number, number>();
  for (const b of corpus.aggregations?.years?.buckets ?? []) {
    const decade = Math.floor(new Date(b.key).getUTCFullYear() / 10) * 10;
    corpusByDecade.set(decade, (corpusByDecade.get(decade) ?? 0) + b.doc_count);
  }
  const mentions = new Map<number, { mentions: number; documents: number }>();
  for (const d of result.perDocument) {
    const year = Number(d.startDate?.slice(0, 4));
    if (!Number.isFinite(year)) continue;
    const decade = Math.floor(year / 10) * 10;
    const entry = mentions.get(decade) ?? { mentions: 0, documents: 0 };
    entry.mentions += d.mentions;
    entry.documents += 1;
    mentions.set(decade, entry);
  }
  return [...mentions.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, v]) => {
      const corpusDocs = corpusByDecade.get(decade) ?? 0;
      return {
        decade: `${decade}s`,
        mentions: v.mentions,
        documents: v.documents,
        corpus_documents: corpusDocs,
        mentions_per_1000_corpus_documents: corpusDocs ? round((v.mentions / corpusDocs) * 1000) : null,
      };
    });
}
