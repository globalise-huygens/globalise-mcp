import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, type IndexKey } from '../config.ts';
import { variantsFor } from '../globalise/lookup.ts';
import { countBody, countOf, esMsearch, esSearch } from '../globalise/es.ts';
import { manifestUri, objectCardUrl, parseId, uriFor, viewerUrlForDocument } from '../globalise/ids.ts';
import { recordProperty, summariseRecord } from '../globalise/linkedart.ts';
import { inventoryInfo } from '../globalise/scan.ts';
import { fetchJson } from '../util/http.ts';
import { CAVEATS, indexVersion, json, provenance, READ_ONLY, safe } from './common.ts';

type Args = { id: string; property?: string; offset?: number; limit?: number };

const INDEX_FOR_KIND: Partial<Record<string, IndexKey>> = {
  person: 'persons',
  place: 'places',
  ship: 'ships',
  group: 'organisations',
  polity: 'polities',
  thesaurus: 'concepts',
};

export function registerGetRecord(server: McpServer) {
  server.registerTool(
    'get_record',
    {
      title: 'Get a GLOBALISE record',
      description:
        'Fetches the full record behind any GLOBALISE id or URI: person, place, ship, voyage, organisation, polity, thesaurus concept, document or inventory. Returns a summary: names, classifications, dates, statuses, cited sources, every linked record (with its URI, to follow with get_record), and usage counts in the corpus. Large records are outlined; use property (+offset/limit) to page through one property in full.',
      inputSchema: {
        id: z.string().min(1).describe('Id or URI, e.g. GLOB2_937, Person_100901, gzm_ship0511, ORG_1, Polity_100, a thesaurus uuid, NL-HaNA_1.04.02_1968_0347-0350, inventory:1968, or https://data.globalise.huygens.knaw.nl/hdl:20.500.14722/…'),
        property: z.string().optional().describe('Return this top-level property in full (pruned JSON), e.g. moved_by, is_classificatory_subject_of, referred_to_by, narrower.'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { ...READ_ONLY, title: 'Get record' },
    },
    safe(async (args: Args) => {
      const parsed = parseId(args.id);
      if (!parsed) throw new Error(`Unrecognised GLOBALISE id: ${args.id}`);

      if (parsed.kind === 'scan') {
        return json({ note: `${parsed.id} is a scan (page image). Use get_scan for its transcription, annotations and image.`, uri: parsed.uri });
      }
      if (parsed.kind === 'inventory') return json(await inventorySummary(parsed.id));

      const record = await fetchJson<Record<string, any>>(parsed.uri);

      if (args.property) {
        const page = recordProperty(record, args.property, args.offset ?? 0, args.limit ?? 10);
        return json({
          uri: parsed.uri,
          property: args.property,
          total_items: page.count,
          offset: args.offset ?? 0,
          items: page.items,
          available_properties: Object.keys(record).filter((k) => !k.startsWith('@')),
        });
      }

      const summary = summariseRecord(record);
      // The Linked Art records label persons "Person Identified by …"; the real names (all
      // spellings) are in the search index, so merge those in.
      const index = INDEX_FOR_KIND[parsed.kind];
      const indexNames = index ? await variantsFor(index, parsed.id) : [];
      const names = [...new Set([...indexNames, ...summary.names.filter((n) => !/ Identified by |^(Person|GLOB|ORG|Polity|gzm)_/.test(n))])];
      const usage = await usageFor(parsed.kind, parsed.id, names);

      return json({
        kind: parsed.kind,
        ...summary,
        label: indexNames[0] ?? summary.label,
        names,
        ...(usage ? { corpus_usage: usage } : {}),
        links: {
          object_card: parsed.kind === 'document' ? undefined : objectCardUrl(parsed.uri),
          viewer: parsed.kind === 'document' ? viewerUrlForDocument(parsed.id) : undefined,
          json_ld: parsed.uri,
        },
        tip: 'Follow linkedEntities with get_record; use property=<name> to see a property in full.',
        provenance: provenance([parsed.uri], parsed.kind === 'document' ? [CAVEATS.documents] : [CAVEATS.referenceData]),
      });
    }),
  );
}

async function usageFor(kind: string, id: string, names: string[]): Promise<Record<string, unknown> | null> {
  if (kind === 'place') {
    const [r] = await esMsearch([{ index: 'documents', body: countBody({ term: { annotatedText: `placeId:${id}` } }) }]);
    return { documents_with_linked_place_tag: countOf(r), search_hint: `search_documents with entities=["${id}"]` };
  }
  if (kind === 'thesaurus') {
    const responses = await esMsearch([
      { index: 'documents', body: countBody({ term: { annotatedText: `personId:${id}` } }) },
      { index: 'documents', body: countBody({ match_phrase: { professionIdPaths: id } }) },
      { index: 'documents', body: countBody({ match_phrase: { documentTypeIdPaths: id } }) },
      { index: 'persons', body: countBody({ match_phrase: { occupationIdPaths: id } }) },
      { index: 'persons', body: countBody({ match_phrase: { statusIdPaths: id } }) },
      { index: 'persons', body: countBody({ match_phrase: { identityIdPaths: id } }) },
    ]);
    const [role, profession, doctype, occupation, status, identity] = responses.map(countOf);
    return {
      documents_with_role_tag: role,
      documents_with_profession: profession,
      documents_of_this_type: doctype,
      persons_with_occupation: occupation,
      persons_with_status: status,
      persons_with_identity: identity,
      note: 'Counts include narrower concepts where the field is hierarchical.',
    };
  }
  if (kind === 'person' || kind === 'ship' || kind === 'group' || kind === 'polity') {
    const spellings = names.filter((n) => n.length > 2).map((n) => n.replace(/^(Ship|Person|Polity|Organisation) /, '')).slice(0, 20);
    if (!spellings.length) return null;
    const [r] = await esMsearch([
      { index: 'documents', body: countBody({ bool: { should: spellings.map((n) => ({ match_phrase: { annotatedText: n } })), minimum_should_match: 1 } }) },
    ]);
    return { documents_containing_a_recorded_name: countOf(r), method: 'phrase match on recorded spellings (approximate)', search_hint: `search_documents with entities=["${id}"]` };
  }
  return null;
}

async function inventorySummary(inventory: string) {
  const [info, docs] = await Promise.all([
    inventoryInfo(inventory),
    esSearch<Record<string, any>>('documents', {
      size: 200,
      _source: ['identifier', 'title', 'startDate', 'endDate', 'scanCount', 'settlement', 'archiveDescription'],
      query: { term: { inventoryNumber: inventory } },
      sort: [{ startDate: 'asc' }],
      track_total_hits: true,
    }),
  ]);
  const first = docs.hits.hits[0]?._source;
  return {
    kind: 'inventory',
    inventory,
    label: info.label,
    scans: info.scanCount,
    manifest: manifestUri(inventory),
    metadata: info.metadata,
    archive_path: first?.archiveDescription,
    documents_total: docs.hits.total.value,
    documents: docs.hits.hits.map((h) => ({
      document_id: h._source.identifier,
      title: h._source.title,
      date: h._source.startDate === h._source.endDate ? h._source.startDate : `${h._source.startDate} / ${h._source.endDate}`,
      scans: h._source.scanCount,
      settlement: h._source.settlement || null,
    })),
    provenance: provenance([manifestUri(inventory), `${config.searchBase}/documents/_search`], [CAVEATS.documents], [await indexVersion('documents')]),
    uri: uriFor('inventory', inventory),
  };
}
