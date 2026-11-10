#!/usr/bin/env node
// Hosted use: a stateless Streamable HTTP endpoint at /mcp (plus /healthz), meant to run as its
// own container behind Traefik. Users add the URL as a remote/custom connector in their client.

import { serve } from 'srvx/node';
import { createMcpFetchHandler } from './fetchHandler.ts';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const hostname = process.env.HOST ?? '0.0.0.0';
const requestsPerMinute = Number.parseInt(process.env.GLOBALISE_RATE_LIMIT_PER_MINUTE ?? '60', 10);

const handler = createMcpFetchHandler({ path: process.env.MCP_PATH ?? '/mcp', requestsPerMinute });

const server = serve({ port, hostname, fetch: handler });
await server.ready();
console.log(`GLOBALISE MCP server listening on http://${hostname}:${port}${process.env.MCP_PATH ?? '/mcp'}`);
