// Corpus-wide statistics, computed live from the search indices (nothing is hard-coded), so the
// figures follow every re-index.
//
// MAINTENANCE: the Globalise search indices are still being developed. When fields are added,
// renamed or removed, update the definitions below (DOCUMENT_COUNTS, REFERENCE_INDICES,
// PERSON_COUNTS, MENTION_ESTIMATES, placeFigures) and the NOT_AVAILABLE list, which tells the model what cannot
// be computed yet. Remove an entry from NOT_AVAILABLE once a figure becomes computable.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, INDICES, type IndexKey } from '../config.ts';
import { conceptSchemes } from '../globalise/concepts.ts';
import { countBody, countOf, esMsearch, esSearch, type EsQuery } from '../globalise/es.ts';
import { countEstimate } from '../globalise/mentions.ts';
import { placeGraph } from '../globalise/places.ts';
import { ANNOTATION_TYPES } from '../globalise/query.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';

const TEXT = 'annotatedText';

/** Documents index: number of documents with … */
const DOCUMENT_COUNTS: Record<string, EsQuery> = {
  // Documents without a place of writing have settlement "" rather than no value.
  with_place_of_writing: { bool: { filter: { exists: { field: 'settlement' } }, must_not: { term: { settlement: '' } } } },
  with_document_type: { exists: { field: 'documentTypeIdPaths' } },
  with_profession: { exists: { field: 'professionIdPaths' } },
  with_place_tag: { term: { [TEXT]: 'type:Place' } },
  with_linked_place: { prefix: { [TEXT]: 'placeId:' } },
  with_person_tag: { term: { [TEXT]: 'type:Person' } },
  with_role_concept: { prefix: { [TEXT]: 'personId:' } },
};

/** Reference indices counted as "records". */
const REFERENCE_INDICES: Array<[string, IndexKey]> = [
  ['persons', 'persons'],
  ['places', 'places'],
  ['ships', 'ships'],
  ['organisations', 'organisations'],
  ['polities', 'polities'],
  ['thesaurus_concepts', 'concepts'],
];

/** Persons index: number of person records with … */
const PERSON_COUNTS: Record<string, EsQuery> = {
  with_occupation: { exists: { field: 'occupations' } },
  with_status: { exists: { field: 'statuses' } },
  with_identity: { exists: { field: 'identities' } },
  with_dates: { bool: { should: [{ exists: { field: 'start' } }, { exists: { field: 'end' } }], minimum_should_match: 1 } },
};

/** Mention-level figures (each tagged span), estimated from a random sample of documents. */
const MENTION_ESTIMATES: Record<string, { query: EsQuery; description: string }> = {
  place_tags: { query: { term: { [TEXT]: 'type:Place' } }, description: 'spans tagged as Place' },
  linked_place_tags: { query: { prefix: { [TEXT]: 'placeId:' } }, description: 'Place spans linked to a place record' },
  person_tags: { query: { term: { [TEXT]: 'type:Person' } }, description: 'spans tagged as Person' },
  role_concept_tags: { query: { prefix: { [TEXT]: 'personId:' } }, description: 'Person spans with a role/profession concept' },
};

/** What the indices cannot answer yet, and why. Keep this in step with the indices. */
const NOT_AVAILABLE = [
  'Most-used roles across the corpus: tags are stored inside the text field, which cannot be aggregated. Count one concept at a time with count_mentions or search_reference_data. (Places can be ranked, because their ids are known in advance: see place_records.most_mentioned and analyze_distribution dimension "place".)',
  'Places mentioned in the text that have no record in the place index: their mentions cannot be ranked or put on a map.',
  'Linked mentions of persons, ships, organisations and polities: these are not linked by id in the text yet (only matched by spelling).',
  'Pages and languages per page: the index holds documents with a scan count, not pages with language.',
  'Person records over time: the persons index has no dates yet (see persons.with_dates).',
];

type Args = { annotation_types?: boolean; estimate_mentions?: boolean; sample_size?: number };

export function registerCorpusStatistics(server: McpServer) {
  server.registerTool(
    'corpus_statistics',
    {
      title: 'Statistics of the Globalise data',
      description:
        'Live overview figures of the whole dataset: documents, scans, inventories and date range; how many documents have a place of writing, document type, place tags, linked places and role concepts; the number of records per kind of reference data (persons, places, ships, organisations, polities, concepts per vocabulary); person records with occupation/status/identity. Optionally documents per annotation type, and sample-based estimates of the number of tagged and linked mentions. Also lists what cannot be computed yet. Use for "how much is in Globalise" questions and to put other counts in proportion.',
      inputSchema: {
        annotation_types: z.boolean().default(false).describe('Also count documents per annotation type (Place, Person, Payment, Attack, ...).'),
        estimate_mentions: z.boolean().default(false).describe('Also estimate the number of tagged and linked mentions (not documents) from a random sample; slower.'),
        sample_size: z.number().int().min(50).max(500).default(200).describe('Documents per sample for mention estimates.'),
      },
      annotations: { ...READ_ONLY, title: 'Corpus statistics' },
    },
    safe(async (args: Args) => {
      const documentKeys = Object.keys(DOCUMENT_COUNTS);
      const personKeys = Object.keys(PERSON_COUNTS);
      const types = args.annotation_types ? [...ANNOTATION_TYPES] : [];

      const [overview, counts, schemes, places] = await Promise.all([
        esSearch('documents', {
          size: 0,
          track_total_hits: true,
          aggs: {
            scans: { sum: { field: 'scanCount' } },
            inventories: { cardinality: { field: 'inventoryNumber', precision_threshold: 40_000 } },
            settlements: { filter: { bool: { must_not: { term: { settlement: '' } } } }, aggs: { distinct: { cardinality: { field: 'settlement', precision_threshold: 40_000 } } } },
            first: { min: { field: 'startDate', format: 'yyyy-MM-dd' } },
            last: { max: { field: 'endDate', format: 'yyyy-MM-dd' } },
          },
        }),
        esMsearch([
          ...documentKeys.map((key) => ({ index: 'documents' as const, body: countBody(DOCUMENT_COUNTS[key]) })),
          ...REFERENCE_INDICES.map(([, index]) => ({ index, body: countBody({ match_all: {} }) })),
          ...personKeys.map((key) => ({ index: 'persons' as const, body: countBody(PERSON_COUNTS[key]) })),
          ...types.map((type) => ({ index: 'documents' as const, body: countBody({ term: { [TEXT]: `type:${type}` } }) })),
        ]),
        conceptSchemes(),
        placeFigures().catch(() => null),
      ]);

      let i = 0;
      const next = () => {
        const response = counts[i++];
        if (!response || 'error' in response) return null;
        return countOf(response);
      };
      const documentsTotal = overview.hits.total.value;
      const share = (n: number | null, of: number) => (n === null || !of ? null : Math.round((n / of) * 1000) / 10);

      const documents: Record<string, unknown> = {};
      for (const key of documentKeys) {
        const n = next();
        documents[key] = { documents: n, percent_of_documents: share(n, documentsTotal) };
      }
      const reference: Record<string, number | null> = {};
      for (const [name] of REFERENCE_INDICES) reference[name] = next();
      const persons: Record<string, unknown> = {};
      for (const key of personKeys) {
        const n = next();
        persons[key] = { persons: n, percent_of_persons: share(n, reference.persons ?? 0) };
      }
      const byType = types.map((type) => ({ type, documents: next() })).filter((t) => t.documents);
      byType.sort((a, b) => (b.documents ?? 0) - (a.documents ?? 0));

      const aggs = overview.aggregations ?? {};
      const result: Record<string, unknown> = {
        corpus: {
          documents: documentsTotal,
          scans: Math.round(aggs.scans?.value ?? 0),
          inventories: aggs.inventories?.value ?? null,
          places_of_writing: aggs.settlements?.distinct?.value ?? null,
          date_range: [aggs.first?.value_as_string ?? null, aggs.last?.value_as_string ?? null],
        },
        documents,
        ...(byType.length ? { documents_per_annotation_type: byType } : {}),
        reference_records: reference,
        concepts_per_vocabulary: schemes.sort((a, b) => b.concepts - a.concepts).map((s) => ({ id: s.id, vocabulary: s.label, concepts: s.concepts })),
        person_records: persons,
        ...(places ? { place_records: places } : {}),
      };

      if (args.estimate_mentions) {
        const sampleSize = args.sample_size ?? 200;
        const estimates: Record<string, unknown> = {};
        for (const [key, def] of Object.entries(MENTION_ESTIMATES)) {
          const docs = countOf((await esMsearch([{ index: 'documents', body: countBody(def.query) }]))[0]);
          const estimate = docs ? await countEstimate(def.query, def.query, docs, sampleSize) : null;
          estimates[key] = {
            what: def.description,
            documents: docs,
            mentions_estimate: estimate?.mentions ?? 0,
            interval_95: estimate?.interval ?? null,
            sampled_documents: estimate?.documentsCounted ?? 0,
          };
        }
        result.mentions = {
          ...estimates,
          method: `Estimated per figure from a random sample of ${sampleSize} documents containing the tag (mean mentions per document × documents). Mention counts are skewed, so intervals are approximate. Ratios between figures (e.g. linked place tags ÷ place tags) are rough.`,
        };
      }

      const failed = counts.filter((r) => !r || 'error' in r).length;
      return json({
        ...result,
        not_available_yet: NOT_AVAILABLE,
        notes: [
          'All figures are computed live from the current indices and change when the data is re-indexed; cite the index versions below.',
          'Document counts count documents with at least one such tag, not the number of tags (see estimate_mentions).',
          'A document is a run of scans (pages) reconstructed automatically; scans = sum of scans over documents.',
          ...(failed ? [`${failed} count(s) failed and are shown as null.`] : []),
        ],
        provenance: provenance(
          [`${config.searchBase}/${INDICES.documents}/_search`, ...REFERENCE_INDICES.map(([, index]) => `${config.searchBase}/${INDICES[index]}/_search`)],
          [CAVEATS.coverage, CAVEATS.annotations, CAVEATS.referenceData],
          await Promise.all((['documents', ...REFERENCE_INDICES.map(([, index]) => index)] as IndexKey[]).map(indexVersion)),
        ),
      });
    }),
  );
}

/** Place records: coordinates, hierarchy and linking, from the place graph (exact, all records). */
async function placeFigures() {
  const graph = await placeGraph();
  const nodes = [...graph.nodes.values()];
  const indexed = nodes.filter((n) => n.indexed);
  const linked = indexed.filter((n) => n.documents > 0);
  return {
    records: indexed.length,
    with_coordinates: indexed.filter((n) => n.point).length,
    part_of_another_place: indexed.filter((n) => n.parents.length).length,
    overlapping_another_place: indexed.filter((n) => n.overlaps.length).length,
    regions_without_own_record: nodes.filter((n) => !n.indexed).length,
    linked_in_text: linked.length,
    linked_in_text_with_coordinates: linked.filter((n) => n.point).length,
    linked_in_text_part_of_another_place: linked.filter((n) => n.parents.length).length,
    most_mentioned: [...linked].sort((a, b) => b.documents - a.documents).slice(0, 10).map((n) => ({ id: n.id, label: n.label, documents: n.documents })),
    note: 'linked_in_text = records that at least one text mention is linked to (placeId). Regions without own record (modern administrative regions, NEW_ADMIN_…) are only known as parents.',
    index_version: graph.indexVersion,
  };
}
