// Minimal fake of the adapter's MCP host: streamable-http, JSON responses, six tools
// with canned outputs. Mirrors adapter-core/src/mcp-host.ts's transport choices.
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const calls = [];

export async function startFakeMcp(port = 0) {
  const srv = createServer((req, res) => {
    void (async () => {
      const mcp = new McpServer({ name: 'fake-host', version: '0' });
      const reg = (name, schema, out) =>
        mcp.registerTool(name, { inputSchema: schema }, async (args) => {
          calls.push({ name, args });
          return { content: [{ type: 'text', text: typeof out === 'function' ? out(args) : out }] };
        });
      reg('bash', { command: z.string() }, (a) => `ran:${a.command}`.slice(0, 200));
      reg('read', { path: z.string() }, (a) => `content-of:${a.path}`);
      reg('write', { path: z.string(), content: z.string() }, 'ok');
      reg('ls', { path: z.string() }, 'file-a\nfile-b');
      reg('say', { text: z.string() }, 'shown');
      reg('ask', { question: z.string() }, 'asked');
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let body = '';
      req.on('data', (c) => (body += c));
      await new Promise((r) => req.on('end', r));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    })().catch((e) => { res.writeHead(500); res.end(String(e)); });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port: srv.address().port, srv };
}
