// Library entry point, for embedding in another Node service (e.g. a TanStack Start server route).
export { createServer, SERVER_NAME, SERVER_VERSION } from './server.ts';
export { createMcpFetchHandler, type McpHandlerOptions } from './fetchHandler.ts';
export { config } from './config.ts';
