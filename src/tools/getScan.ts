import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from '../config.ts';
import { esSearch } from '../globalise/es.ts';
import { documentContainsScan, iiifImageUrl, parseId, scanRef, uriFor, viewerUrlForScan } from '../globalise/ids.ts';
import { fetchImageBase64, locateQuote, scanAnnotations, scanImage, scanTranscription } from '../globalise/scan.ts';
import { CAVEATS, provenance, READ_ONLY, safe } from './common.ts';

type Args = {
  scan_id: string;
  text?: 'normalized' | 'diplomatic' | 'both' | 'none';
  annotations?: boolean;
  quote?: string;
  image?: 'none' | 'page' | 'quote';
  image_width?: number;
};

export function registerGetScan(server: McpServer) {
  server.registerTool(
    'get_scan',
    {
      title: 'Look at a scan (page) and verify a passage',
      description:
        'Returns one scanned page: its transcription (normalized = reading text; diplomatic = line-by-line HTR output), the entity/event annotations on it, the document it belongs to, the IIIF image URL and a link to open it in the GLOBALISE viewer. Set quote to locate a passage on the page; set image to "quote" to receive a crop of that passage, or "page" to receive the whole page, so you can check the transcription against the handwriting yourself.',
      inputSchema: {
        scan_id: z.string().describe('Scan id, e.g. NL-HaNA_1.04.02_1968_0347 (or a canvas URI). Get these from get_document or search results.'),
        text: z.enum(['normalized', 'diplomatic', 'both', 'none']).default('normalized'),
        annotations: z.boolean().default(true).describe('Include the entity and event annotations on this page.'),
        quote: z.string().max(500).optional().describe('A passage to locate on the page (word-level, tolerant of HTR errors).'),
        image: z.enum(['none', 'page', 'quote']).default('none').describe('Return the image: the whole page, or a crop around the quote (requires quote).'),
        image_width: z.number().int().min(300).max(2000).default(1200).describe('Width in pixels of the returned image.'),
      },
      annotations: { ...READ_ONLY, title: 'Get scan' },
    },
    safe(async (args: Args): Promise<CallToolResult> => {
      const parsed = parseId(args.scan_id);
      const ref = parsed?.kind === 'scan' ? scanRef(parsed.id) : null;
      if (!ref) throw new Error(`Not a scan id: ${args.scan_id} (expected e.g. NL-HaNA_1.04.02_1968_0347). For a document id, use get_document to list its scans.`);

      const [image, transcription, annotations, document] = await Promise.all([
        scanImage(ref),
        scanTranscription(ref.scanId),
        args.annotations === false ? Promise.resolve([]) : scanAnnotations(ref.scanId),
        containingDocument(ref.scanId, ref.inventory),
      ]);

      const located = args.quote ? locateQuote(transcription.words, args.quote) : null;
      const textMode = args.text ?? 'normalized';
      const width = args.image_width ?? 1200;
      const cropUrl = located && image ? iiifImageUrl(image.service, { region: located.region, width: Math.min(width, 1600) }) : null;

      const result = {
        scan_id: ref.scanId,
        uri: ref.canvasUri,
        inventory: ref.inventory,
        document,
        viewer_url: viewerUrlForScan(ref.scanId),
        image: image ? { width: image.width, height: image.height, iiif_service: image.service, full: image.full, preview: image.preview, ...(cropUrl ? { quote_crop: cropUrl } : {}) } : null,
        ...(args.quote
          ? {
              quote_location: located
                ? { found: true, matched_words: located.matchedWords, quote_words: located.quoteWords, transcribed_as: located.matchedText, iiif_region: located.region }
                : { found: false, note: 'Passage not found on this page; it may be on a neighbouring scan (try get_document with locate_quote).' },
            }
          : {}),
        ...(textMode === 'normalized' || textMode === 'both' ? { text_normalized: transcription.normalized } : {}),
        ...(textMode === 'diplomatic' || textMode === 'both' ? { text_diplomatic: transcription.diplomatic } : {}),
        ...(args.annotations === false
          ? {}
          : {
              annotations: annotations.slice(0, 150).map((a) => ({
                kind: a.kind,
                type: a.type,
                text: a.quote ?? a.label,
                classification: a.classification,
                ...(a.links.length ? { links: a.links } : {}),
              })),
              ...(annotations.length > 150 ? { annotations_truncated: annotations.length } : {}),
            }),
        provenance: provenance(
          [ref.manifestUri, `${config.dataBase}/annotations:transcriptions:${ref.scanId}`, `${config.dataBase}/annotations:entities:${ref.scanId}`, `${config.dataBase}/annotations:events:${ref.scanId}`],
          [CAVEATS.htr, CAVEATS.annotations, 'The image is the authoritative source; the transcription is a machine reading of it.'],
        ),
      };

      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(result, null, 1) }];

      const wantImage = args.image ?? 'none';
      if (wantImage !== 'none' && image) {
        const url = wantImage === 'quote' ? cropUrl : iiifImageUrl(image.service, { width });
        if (url) {
          const fetched = await fetchImageBase64(url);
          content.push({ type: 'image', data: fetched.data, mimeType: fetched.mimeType });
          content.push({ type: 'text', text: `Image above: ${wantImage === 'quote' ? 'crop around the quoted passage' : 'full page'} of ${ref.scanId} (${url}).` });
        } else {
          content.push({ type: 'text', text: 'No crop available: the quote was not located on this page.' });
        }
      }
      return { content };
    }),
  );
}

/** The document that contains a scan: documents are scan ranges within an inventory. */
async function containingDocument(scanId: string, inventory: string) {
  const data = await esSearch<Record<string, any>>('documents', {
    size: 1000,
    _source: ['identifier', 'title', 'startDate', 'endDate'],
    query: { term: { inventoryNumber: inventory } },
  });
  const hit = data.hits.hits.find((h) => documentContainsScan(String(h._source.identifier), scanId));
  if (!hit) return null;
  const s = hit._source;
  return { document_id: s.identifier, title: s.title, date: s.startDate === s.endDate ? s.startDate : `${s.startDate} / ${s.endDate}`, uri: uriFor('document', s.identifier) };
}
