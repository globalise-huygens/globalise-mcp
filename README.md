# GLOBALISE MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets LLM tools (Claude,
ChatGPT, Cursor, VS Code Copilot, …) do source-critical research in the
[GLOBALISE](https://globalise.nl) VOC archives: the machine transcriptions, their entity and event
annotations, and the GLOBALISE reference data (persons, places, ships, organisations, polities,
thesaurus).

Status: **prototype**. It runs against the work-in-progress indices at `search.globalise.nl` and the
persistent data at `data.globalise.huygens.knaw.nl`.

## What it can do

| Tool | Purpose |
| --- | --- |
| `globalise_about` | Built-in documentation: data model, limitations and bias, query syntax, research workflow |
| `search_documents` | Full-text and structured search (entities by id, roles, event types, dates, settlement, inventory, document type, proximity) with highlighted snippets and viewer links |
| `analyze_distribution` | Spread of a result set over decades, settlements, document types, professions, archive series, **normalised against the whole corpus** |
| `search_reference_data` | Find persons, places, ships, organisations, polities and concepts by any spelling, with corpus mention counts |
| `get_record` | Any record by id/URI, summarised: names, statuses, dates, sources, all linked records (to navigate the graph); inventories list their documents |
| `get_document` | A document's metadata, text (plain or with inline tags), tagged entities, scans; can locate a quote among its scans |
| `get_scan` | One page: normalised and diplomatic transcription, annotations, IIIF image, viewer link, and the image itself (whole page or **a crop around a quoted passage**) so the model and user can check the handwriting |

The server also exposes the documentation as MCP resources (`globalise://docs/…`) and a
`research_question` prompt.

**Transparency.** Every tool response includes a `provenance` block: the endpoints queried, the
dated index version (e.g. `annotated-documents.2026.11.05`) and the caveats that apply to that
particular query, such as "names matched by spelling, not id". Responses also include a
`query_interpretation` showing how typed names were resolved to ids.

## Use it

Requires Node 24+.

```bash
npm install
npm run smoke        # calls every tool against the live services
npm test             # unit tests
npm run inspect      # MCP Inspector UI
```

### Local (stdio): Claude Desktop, Claude Code, Cursor, VS Code

```json
{
  "mcpServers": {
    "globalise": { "command": "node", "args": ["/path/to/globalise-mcp/src/stdio.ts"] }
  }
}
```

Claude Code: `claude mcp add globalise -- node /path/to/globalise-mcp/src/stdio.ts`.
Once published to npm, this becomes `npx -y @globalise/mcp`.

### Hosted (Streamable HTTP)

```bash
npm run start:http   # http://localhost:3001/mcp, health at /healthz
```

Users add the URL (e.g. `https://mcp.globalise.nl/mcp`) as a custom/remote connector in their client.
The endpoint is stateless, read-only and needs no authentication.

## Architecture

```
src/
  server.ts            tool/resource/prompt registration (createServer)
  stdio.ts, http.ts    entry points; fetchHandler.ts = Web-standard Request→Response handler
  knowledge.ts         data model, limitations, query syntax, workflow (served to the model)
  tools/               one file per tool
  globalise/           domain logic: ids & links, ES client, query language (port of
                       globalise-search/unified), annotated-text parsing, Linked Art summaries,
                       scan/IIIF/annotation access
  util/                fetch with timeout + cache + concurrency cap, LRU cache, rate limiter
```

The code uses the portal's conventions: ESM, strict TS, `.ts` imports, erasable syntax only, Node 24.
That means it runs without a build step and can move into the portal monorepo as `packages/mcp`.

## Deployment and load

Run it as its **own container** behind Traefik (see `Dockerfile`), not inside the portal process:

- **Isolation.** A burst of LLM tool calls can't starve the portal's SSR process or crash it.
  The MCP service can be scaled, throttled or switched off independently.
- **Load is on Elasticsearch, wherever the MCP runs.** The real risk is heavy queries (aggregations, big
  documents) on the shared ES cluster, which also serves the portal. Mitigations built in:
  - an upstream concurrency cap per instance (`GLOBALISE_MAX_CONCURRENT_UPSTREAM`, default 8);
  - a response cache (15 min);
  - request timeouts;
  - page-size and result-window limits;
  - a per-client rate limit (`GLOBALISE_RATE_LIMIT_PER_MINUTE`, default 60).
- **Recommended at the edge:** Traefik `rateLimit` and `inFlightReq` middlewares on the MCP route,
  and ideally a separate ES proxy route or user for MCP traffic, so it can be throttled
  independently.
- `search.globalise.nl` is publicly reachable already, so the MCP adds no new exposure. It does make
  heavy querying much easier, though.

Configuration (environment variables): `GLOBALISE_SEARCH_BASE`, `GLOBALISE_DATA_BASE`,
`GLOBALISE_PORTAL_BASE`, `GLOBALISE_REQUEST_TIMEOUT_MS`, `GLOBALISE_MAX_CONCURRENT_UPSTREAM`,
`GLOBALISE_CACHE_TTL_MS`, `GLOBALISE_RATE_LIMIT_PER_MINUTE`, `PORT`, `MCP_PATH`.

## Data issues found while building this

- Manifest `TextPositionSelector`s into `inventory:<n>.txt` drift by about one character per
  preceding scan (e.g. scan 0347 of inventory 1968: selector 381176, actual 380831). The per-scan
  `annotations:transcriptions:<scan>` pages are correct and are what this server uses.
- The "Corpus mentions" annotation collections on reference records are far from complete
  (32 for Amsterdam, against ~53,000 documents with a linked Amsterdam tag in the index).
- Thesaurus URIs only resolve to JSON-LD with exactly `Accept: application/ld+json`. Any other
  Accept header, even one that includes it with a q-value, redirects to Skosmos HTML (404 for some
  concepts).
- `persons.start`/`end` and `documents.dateBucket` are empty. Person records label people
  "Person Identified by …"; names are only in the index and in `is_appellative_subject_of`.

## Roadmap

- Use resolved dates, English translations and new reference-data fields as they land in the indices.
- Embed the GLOBALISE viewer in the chat via [MCP Apps](https://modelcontextprotocol.io) (`ui://`
  resources), for clients that support it.
- Link named persons, ships and organisations by id once the annotations carry those ids.
- Publish to npm and host at a stable URL.
