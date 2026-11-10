import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, INDICES, type IndexKey } from '../config.ts';
import { countBody, countOf, esMsearch, esSearch, splitTitles } from '../globalise/es.ts';
import { objectCardUrl, uriFor, type EntityKind } from '../globalise/ids.ts';
import { labelsFor } from '../globalise/lookup.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';

const KINDS = {
  persons: { index: 'persons', kind: 'person' },
  places: { index: 'places', kind: 'place' },
  ships: { index: 'ships', kind: 'ship' },
  organisations: { index: 'organisations', kind: 'group' },
  polities: { index: 'polities', kind: 'polity' },
  concepts: { index: 'concepts', kind: 'thesaurus' },
} as const satisfies Record<string, { index: IndexKey; kind: EntityKind }>;

type KindKey = keyof typeof KINDS;

type Args = {
  query: string;
  kinds?: KindKey[];
  limit?: number;
  occupation?: string;
  status?: string;
  identity?: string;
  count_mentions?: boolean;
};

const escapeWildcard = (value: string) => value.replace(/([\\*?])/g, '\\$1');

function objectQuery(text: string) {
  if (/[*?]/.test(text)) return { query_string: { query: text, default_field: 'title', default_operator: 'AND' } };
  return {
    bool: {
      should: [
        { match: { title: { query: text, operator: 'and', boost: 3 } } },
        { match_phrase_prefix: { title: { query: text, max_expansions: 200 } } },
        { match: { title: { query: text, fuzziness: 'AUTO', operator: 'and' } } },
      ],
      minimum_should_match: 1,
    },
  };
}

function personQuery(text: string, args: Args) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const must: Record<string, unknown>[] = words.map((word) => ({
    wildcard: { titles: { value: /[*?]/.test(word) ? word : `*${escapeWildcard(word)}*`, case_insensitive: true } },
  }));
  if (args.occupation) must.push({ match_phrase: { occupationIdPaths: args.occupation } });
  if (args.status) must.push({ match_phrase: { statusIdPaths: args.status } });
  if (args.identity) must.push({ match_phrase: { identityIdPaths: args.identity } });
  return { bool: { must, should: words.length ? [{ wildcard: { titles: { value: `${escapeWildcard(words[0])}*`, case_insensitive: true, boost: 2 } } }] : [] } };
}

/** Which place ids is a spelling actually tagged with in the corpus? Place titles are often period spellings. */
async function attestedPlaceIds(text: string): Promise<Map<string, { surface: string; seen: number }>> {
  const pattern = `${text.toLowerCase().replace(/[*?\\]/g, '')}*`;
  if (pattern.length < 4) return new Map();
  const data = await esSearch('documents', {
    size: 25,
    _source: false,
    query: { span_within: { big: { span_term: { annotatedText: 'type:Place' } }, little: { span_multi: { match: { wildcard: { annotatedText: { value: pattern } } } } } } },
    highlight: { fields: { annotatedText: { type: 'annotated', number_of_fragments: 8, fragment_size: 80 } } },
  });
  const seen = new Map<string, { surface: string; seen: number }>();
  for (const hit of data.hits.hits) {
    for (const fragment of hit.highlight?.annotatedText ?? []) {
      for (const match of fragment.matchAll(/\[([^\]]+)\]\(([^)]*_hit_term[^)]*)\)/g)) {
        const id = /placeId%3A([^&)]+)/.exec(match[2])?.[1];
        if (!id) continue;
        const entry = seen.get(id) ?? { surface: match[1].trim(), seen: 0 };
        entry.seen += 1;
        seen.set(id, entry);
      }
    }
  }
  return seen;
}

export function registerSearchReferenceData(server: McpServer) {
  server.registerTool(
    'search_reference_data',
    {
      title: 'Find persons, places, ships, organisations, polities, concepts',
      description:
        'Searches the GLOBALISE reference data by name (any recorded spelling): persons, places, ships, organisations (e.g. VOC), polities (e.g. Mataram) and thesaurus concepts (professions, ranks, statuses, identities, document types, commodities). Returns ids to use in search_documents (entities, or place:/role:/concept: fields) and get_record, with the number of documents that mention each (when count_mentions is on).',
      inputSchema: {
        query: z.string().min(1).max(200).describe('Name or term, any spelling; wildcards allowed (e.g. "Coroman*", "koopman", "Pieter Both").'),
        kinds: z.array(z.enum(Object.keys(KINDS) as [KindKey, ...KindKey[]])).optional().describe('Which kinds of record to search (default: all).'),
        limit: z.number().int().min(1).max(25).default(8).describe('Results per kind.'),
        occupation: z.string().optional().describe('Persons only: thesaurus concept id of an occupation (includes narrower).'),
        status: z.string().optional().describe('Persons only: thesaurus concept id of a status.'),
        identity: z.string().optional().describe('Persons only: thesaurus concept id of an identity.'),
        count_mentions: z.boolean().default(true).describe('Count documents mentioning places (by id), concepts (as role/profession/document type) and named records (by spelling).'),
      },
      annotations: { ...READ_ONLY, title: 'Search reference data' },
    },
    safe(async (args: Args) => {
      const kinds = args.kinds?.length ? args.kinds : (Object.keys(KINDS) as KindKey[]);
      const limit = args.limit ?? 8;
      const text = args.query.trim();
      const out: Record<string, unknown[]> = {};
      const versions: string[] = [];

      await Promise.all(
        kinds.map(async (key) => {
          const { index, kind } = KINDS[key];
          const query = key === 'persons' ? personQuery(text, args) : objectQuery(text);
          const data = await esSearch<Record<string, any>>(index, { size: limit, query });
          versions.push(...data.hits.hits.map((h) => h._index));

          const items = data.hits.hits.map((hit) => {
            const names = splitTitles(key === 'persons' ? hit._source.titles : hit._source.title);
            return {
              id: hit._id,
              names,
              uri: uriFor(kind, hit._id),
              object_card_url: objectCardUrl(uriFor(kind, hit._id)),
              ...(key === 'persons'
                ? { occupations: hit._source.occupations ?? [], statuses: hit._source.statuses ?? [], identities: hit._source.identities ?? [], relations: (hit._source.relations ?? []).length }
                : {}),
            } as Record<string, any>;
          });

          if (key === 'places') {
            // Add places that the corpus tags with this spelling, even if the record title differs.
            const attested = await attestedPlaceIds(text).catch(() => new Map());
            const missing = [...attested.keys()].filter((id) => !items.some((item) => item.id === id));
            const labels = await labelsFor('places', missing);
            for (const id of missing.slice(0, limit)) {
              items.push({
                id,
                names: [labels.get(id) ?? id],
                uri: uriFor('place', id),
                object_card_url: objectCardUrl(uriFor('place', id)),
                note: `the corpus tags the spelling "${attested.get(id)?.surface}" with this place`,
              });
            }
          }

          if (key === 'persons') {
            const conceptIds = items.flatMap((i) => [...i.occupations, ...i.statuses, ...i.identities]);
            const labels = await labelsFor('concepts', conceptIds);
            for (const item of items) {
              for (const field of ['occupations', 'statuses', 'identities']) item[field] = item[field].map((id: string) => `${labels.get(id) ?? '?'} (${id})`);
            }
          }

          if (args.count_mentions !== false && items.length) await addMentionCounts(key, items);
          out[key] = items;
        }),
      );

      return json({
        query: text,
        results: out,
        how_to_use:
          'Pass ids to search_documents via entities=[…] (places and concepts match by id; persons/ships/organisations/polities by every recorded spelling), or open a record with get_record.',
        provenance: provenance(
          kinds.map((k) => `${config.searchBase}/${INDICES[KINDS[k].index]}/_search`),
          [CAVEATS.referenceData, CAVEATS.names, 'Mention counts are numbers of documents, not of mentions.'],
          versions.length ? versions : [await indexVersion('documents')],
        ),
      });
    }),
  );
}

async function addMentionCounts(key: KindKey, items: Array<Record<string, any>>) {
  const searches = items.map((item) => {
    if (key === 'places') return { index: 'documents' as const, body: countBody({ term: { annotatedText: `placeId:${item.id}` } }) };
    if (key === 'concepts') {
      return {
        index: 'documents' as const,
        body: countBody({
          bool: {
            should: [
              { term: { annotatedText: `personId:${item.id}` } },
              { match_phrase: { professionIdPaths: item.id } },
              { match_phrase: { documentTypeIdPaths: item.id } },
            ],
            minimum_should_match: 1,
          },
        }),
      };
    }
    const names: string[] = item.names.filter((n: string) => n.length > 2).slice(0, 20);
    return {
      index: 'documents' as const,
      body: countBody(names.length ? { bool: { should: names.map((n) => ({ match_phrase: { annotatedText: n } })), minimum_should_match: 1 } } : { match_none: {} }),
    };
  });
  const responses = await esMsearch(searches);
  items.forEach((item, i) => {
    item.documents_mentioning = countOf(responses[i]);
    item.count_method = key === 'places' ? 'documents with a place tag linked to this id' : key === 'concepts' ? 'documents using this concept as role tag, profession or document type' : 'documents containing any recorded name as a phrase (approximate; homonyms included)';
  });
}
