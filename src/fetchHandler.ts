// A Web-standard (Request -> Response) MCP endpoint. Runs standalone (src/http.ts, via srvx) and
// can be mounted unchanged in a TanStack Start server route or any other fetch-based server.
//
// Stateless: every request gets a fresh server + transport, so instances can be scaled
// horizontally behind a load balancer (Traefik) without sticky sessions.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.ts';
import { RateLimiter } from './util/rateLimit.ts';

export interface McpHandlerOptions {
  /** Path the MCP endpoint is served on. */
  path?: string;
  /** Requests (tool calls etc.) per client per minute. 0 disables the limiter (e.g. when Traefik limits). */
  requestsPerMinute?: number;
  /** Header with the client address set by the reverse proxy. */
  clientIpHeader?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
};

export function createMcpFetchHandler(options: McpHandlerOptions = {}) {
  const path = options.path ?? '/mcp';
  const limiter = options.requestsPerMinute === 0 ? null : new RateLimiter(options.requestsPerMinute ?? 60, 60_000);
  const ipHeader = options.clientIpHeader ?? 'x-forwarded-for';

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/healthz') return Response.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }, { headers: CORS });
    if (url.pathname !== path) return new Response('Not found', { status: 404, headers: CORS });

    // Stateless mode has no server-to-client stream or session to delete.
    if (request.method !== 'POST') {
      return withCors(Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: use POST' }, id: null }, { status: 405, headers: { Allow: 'POST' } }));
    }

    if (limiter) {
      const client = request.headers.get(ipHeader)?.split(',')[0]?.trim() || 'unknown';
      const wait = limiter.take(client);
      if (wait > 0) {
        return withCors(
          Response.json(
            { jsonrpc: '2.0', error: { code: -32029, message: `Rate limit exceeded; retry in ${Math.ceil(wait / 1000)} s` }, id: null },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(wait / 1000)) } },
          ),
        );
      }
    }

    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return withCors(await transport.handleRequest(request));
    } catch (error) {
      console.error('MCP request failed', error);
      return withCors(Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, { status: 500 }));
    } finally {
      // With JSON responses the reply is complete once handleRequest resolves.
      void transport.close();
      void server.close();
    }
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
