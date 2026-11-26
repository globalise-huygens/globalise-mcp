import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerMapViewer } from './apps/mapViewer.ts';
import { registerScanViewer } from './apps/scanViewer.ts';
import { SERVER_INSTRUCTIONS, TOPICS, type Topic } from './knowledge.ts';
import { registerAnalyzeDistribution } from './tools/analyzeDistribution.ts';
import { registerAnalyzePersons } from './tools/analyzePersons.ts';
import { registerBrowseConcepts } from './tools/browseConcepts.ts';
import { READ_ONLY } from './tools/common.ts';
import { registerCorpusStatistics } from './tools/corpusStatistics.ts';
import { registerCountMentions } from './tools/countMentions.ts';
import { registerExplorePlaces } from './tools/explorePlaces.ts';
import { registerGetDocument } from './tools/getDocument.ts';
import { registerGetRecord } from './tools/getRecord.ts';
import { registerGetScan } from './tools/getScan.ts';
import { registerMapDocuments } from './tools/mapDocuments.ts';
import { registerSearchDocuments } from './tools/searchDocuments.ts';
import { registerSearchReferenceData } from './tools/searchReferenceData.ts';

export const SERVER_NAME = 'globalise';
export const SERVER_VERSION = '0.1.0';

/** Builds a fully configured MCP server. Cheap enough to create per request in stateless HTTP mode. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION, title: 'Globalise – VOC archives' }, { instructions: SERVER_INSTRUCTIONS });

  const topics = Object.keys(TOPICS) as [Topic, ...Topic[]];

  server.registerTool(
    'globalise_about',
    {
      title: 'About Globalise data',
      description:
        'Documentation for this server: overview of the tools, the data model (how inventories, scans, documents, annotations and reference records relate), source criticism and limitations, the query syntax, and a recommended research workflow. Read data_model and limitations before substantive research.',
      inputSchema: { topic: z.enum(topics).default('overview') },
      annotations: { ...READ_ONLY, openWorldHint: false, title: 'About Globalise' },
    },
    async ({ topic }) => ({ content: [{ type: 'text', text: TOPICS[topic ?? 'overview'] }] }),
  );

  registerSearchDocuments(server);
  registerAnalyzeDistribution(server);
  registerCountMentions(server);
  registerMapDocuments(server);
  registerCorpusStatistics(server);
  registerSearchReferenceData(server);
  registerExplorePlaces(server);
  registerBrowseConcepts(server);
  registerAnalyzePersons(server);
  registerGetRecord(server);
  registerGetDocument(server);
  registerGetScan(server);
  registerScanViewer(server);
  registerMapViewer(server);

  for (const topic of topics) {
    server.registerResource(
      `globalise-${topic}`,
      `globalise://docs/${topic}`,
      { title: `Globalise: ${topic.replace('_', ' ')}`, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: TOPICS[topic] }] }),
    );
  }

  server.registerPrompt(
    'research_question',
    {
      title: 'Research a question in the VOC archives',
      description: 'Starts a source-critical research session on a question, following the Globalise workflow.',
      argsSchema: { question: z.string().describe('The research question, in any language.') },
    },
    ({ question }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Research this question with the Globalise tools: ${question}

Work as follows:
${TOPICS.workflow}
In the answer: separate what the sources say from your interpretation; cite document ids, scan ids, dates and viewer links for every claim; include a "Research strategy" section with your route through the archives (tools, order, reasons) and the exact search terms, ids and filters you used, verbatim, plus the index version; answer from the tool results only, and mark anything from your own knowledge explicitly as not coming from the archives; quantify with corpus-normalised figures where you count; and end with the limitations that affect this answer (see globalise_about topic "limitations").`,
          },
        },
      ],
    }),
  );

  return server;
}
