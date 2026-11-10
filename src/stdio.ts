#!/usr/bin/env node
// Local use: the MCP client (Claude Desktop, Claude Code, Cursor, VS Code, ...) starts this
// process and talks to it over stdin/stdout. Each user's queries then come from their own machine.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

const server = createServer();
await server.connect(new StdioServerTransport());
console.error('GLOBALISE MCP server running on stdio');
