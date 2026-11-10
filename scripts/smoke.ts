// End-to-end check against the live GLOBALISE services: connects an MCP client to the server
// in-process and calls every tool once. Run with: npm run smoke
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.ts';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await createServer().connect(serverTransport);
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(clientTransport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const calls: Array<[string, Record<string, unknown>]> = [
  ['globalise_about', { topic: 'data_model' }],
  ['search_reference_data', { query: 'Amsterdam', kinds: ['places'], limit: 3 }],
  ['search_reference_data', { query: 'koopman', kinds: ['concepts', 'persons'], limit: 3 }],
  ['search_documents', { query: '(place:GLOB2_937 timmerman)~10', page_size: 2, snippets_per_document: 2 }],
  ['search_documents', { query: 'peper', settlement: 'Malabar', year_from: 1700, year_to: 1710, page_size: 2, sort: 'date_asc' }],
  ['search_documents', { entities: ['gzm_ship0511'], page_size: 2 }],
  ['analyze_distribution', { query: 'annotation:Attack', dimensions: ['decade', 'settlement', 'document_type'], top: 5 }],
  ['get_record', { id: 'GLOB2_937' }],
  ['get_record', { id: 'Person_100901' }],
  ['get_record', { id: 'e0c5801f-60f4-4a54-bd3b-9f40a8f78e3e' }],
  ['get_record', { id: 'gzm_ship0511', property: 'moved_by', limit: 2 }],
  ['get_record', { id: 'inventory:1968' }],
  ['get_document', { document_id: 'NL-HaNA_1.04.02_1968_0347-0350', max_chars: 600, locate_quote: 'Specificatie van alle soodanige dranken' }],
  ['get_scan', { scan_id: 'NL-HaNA_1.04.02_1968_0347', quote: 'Specificatie van alle soodanige dranken', image: 'quote' }],
];

let failures = 0;
for (const [name, args] of calls) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string; data?: string }>;
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const images = content.filter((c) => c.type === 'image').length;
  if (result.isError) failures += 1;
  console.log(`\n=== ${name} ${JSON.stringify(args)} — ${Date.now() - started} ms${result.isError ? ' — ERROR' : ''}${images ? ` — ${images} image(s)` : ''}`);
  console.log(text.slice(0, Number(process.env.SMOKE_CHARS ?? 1500)));
}

await client.close();
console.log(`\n${calls.length - failures}/${calls.length} calls succeeded`);
process.exit(failures ? 1 : 0);
