import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { parseAnnotated, plainText, renderSegments, summariseEntities, type TextFormat } from '../globalise/annotatedText.ts';
import { esSearch } from '../globalise/es.ts';
import { documentScanIds, parseId, uriFor, viewerUrlForDocument, viewerUrlForScan } from '../globalise/ids.ts';
import { labelsFor } from '../globalise/lookup.ts';
import { locateQuote, scanTranscription } from '../globalise/scan.ts';
import { CAVEATS, json, provenance, READ_ONLY, safe } from './common.ts';

type Args = {
  document_id: string;
  text_format?: TextFormat | 'none';
  offset?: number;
  max_chars?: number;
  locate_quote?: string;
};

const MAX_LOCATE_SCANS = 60;

export function registerGetDocument(server: McpServer) {
  server.registerTool(
    'get_document',
    {
      title: 'Read a VOC document',
      description:
        'Returns one document: metadata (title, date, place of writing, archive path), its transcription (paged by characters; "inline" shows entity/event tags with ids), a summary of tagged places, roles and annotation types, and its scans with viewer links. With locate_quote, finds which scan(s) contain a passage, so it can be checked with get_scan.',
      inputSchema: {
        document_id: z.string().describe('Document id (e.g. NL-HaNA_1.04.02_1968_0347-0350) or its URI.'),
        text_format: z.enum(['plain', 'inline', 'none']).default('plain'),
        offset: z.number().int().min(0).default(0).describe('Character offset into the text, for paging long documents.'),
        max_chars: z.number().int().min(500).max(40_000).default(12_000),
        locate_quote: z.string().max(500).optional().describe('A passage (a few words is enough) to find among the document\'s scans.'),
      },
      annotations: { ...READ_ONLY, title: 'Get document' },
    },
    safe(async (args: Args) => {
      const parsed = parseId(args.document_id);
      if (!parsed || parsed.kind !== 'document') throw new Error(`Not a document id: ${args.document_id} (expected e.g. NL-HaNA_1.04.02_1968_0347-0350)`);

      const data = await esSearch<Record<string, any>>('documents', { size: 1, query: { term: { id: parsed.uri } } });
      const hit = data.hits.hits[0];
      if (!hit) throw new Error(`Document ${parsed.id} is not in the documents index (it may have been re-segmented; try search_documents with inventory:${parsed.id.split('_')[2]}).`);
      const s = hit._source;

      const segments = parseAnnotated(String(s.annotatedText ?? ''));
      const format = args.text_format ?? 'plain';
      const full = format === 'none' ? '' : format === 'inline' ? renderSegments(segments, 'inline') : plainText(segments);
      const offset = args.offset ?? 0;
      const maxChars = args.max_chars ?? 12_000;
      const text = full.slice(offset, offset + maxChars);

      const entities = summariseEntities(segments, 30);
      const [placeLabels, roleLabels] = await Promise.all([
        labelsFor('places', entities.places.map((p) => p.placeId)),
        labelsFor('concepts', entities.roles.map((r) => r.conceptId)),
      ]);

      const scanIds = documentScanIds(parsed.id);
      const located = args.locate_quote ? await locate(scanIds, args.locate_quote) : undefined;

      return json({
        document_id: parsed.id,
        uri: parsed.uri,
        title: s.title,
        date: { start: s.startDate, end: s.endDate },
        settlement: s.settlement || null,
        inventory: s.inventoryNumber,
        archive_path: s.archiveDescription,
        viewer_url: viewerUrlForDocument(parsed.id),
        ...(located ? { located_quote: located } : {}),
        text:
          format === 'none'
            ? undefined
            : {
                format,
                offset,
                returned_chars: text.length,
                total_chars: full.length,
                has_more: offset + text.length < full.length,
                content: text,
              },
        tagged_entities: {
          places: entities.places.map((p) => ({ ...p, label: placeLabels.get(p.placeId) ?? null })),
          roles: entities.roles.map((r) => ({ ...r, label: roleLabels.get(r.conceptId) ?? null })),
          person_names: entities.personNames,
          annotation_type_counts: entities.annotationTypes,
        },
        scans: {
          count: scanIds.length,
          items: scanIds.slice(0, 50).map((id) => ({ scan_id: id, viewer_url: viewerUrlForScan(id) })),
          ...(scanIds.length > 50 ? { note: `${scanIds.length - 50} more scans follow the same numbering.` } : {}),
        },
        provenance: provenance([`${config.searchBase}/documents/_search`, uriFor('document', parsed.id)], [CAVEATS.htr, CAVEATS.annotations, CAVEATS.documents, CAVEATS.verify], [hit._index]),
      });
    }),
  );
}

/** Looks for a passage page by page; stops at the first good match. */
async function locate(scanIds: string[], quote: string) {
  const candidates = scanIds.slice(0, MAX_LOCATE_SCANS);
  const matches: Array<{ scan_id: string; matched_words: number; quote_words: number; matched_text: string; viewer_url: string | null }> = [];
  // Small batches keep upstream load modest while still being reasonably quick.
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const pages = await Promise.all(batch.map((id) => scanTranscription(id).then((t) => ({ id, t })).catch(() => null)));
    for (const page of pages) {
      if (!page) continue;
      const found = locateQuote(page.t.words, quote);
      if (found) matches.push({ scan_id: page.id, matched_words: found.matchedWords, quote_words: found.quoteWords, matched_text: found.matchedText, viewer_url: viewerUrlForScan(page.id) });
    }
    if (matches.some((m) => m.matched_words === m.quote_words)) break;
  }
  matches.sort((a, b) => b.matched_words - a.matched_words);
  return {
    quote,
    searched_scans: Math.min(candidates.length, scanIds.length),
    ...(scanIds.length > MAX_LOCATE_SCANS ? { note: `Only the first ${MAX_LOCATE_SCANS} of ${scanIds.length} scans were searched.` } : {}),
    matches: matches.slice(0, 5),
  };
}
