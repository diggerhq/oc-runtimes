// Minimal Anthropic Messages API mock. Text-only reply; optional one tool_use
// round when the request carries tools and no prior tool_result (TOOL=1).
import { createServer } from 'node:http';

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

export function startMock({ port = 0, onRequest = () => {} } = {}) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (process.env.MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS)));
      const parsed = JSON.parse(body || '{}');
      onRequest({ url: req.url, headers: req.headers, body: parsed });
      const hasToolResult = JSON.stringify(parsed.messages ?? []).includes('tool_result');
      const wantTool = process.env.MOCK_TOOL === '1' && (parsed.tools ?? []).length > 0 && !hasToolResult;
      const usage = { input_tokens: 5, output_tokens: 7 };
      if (wantTool) {
        const target = (parsed.tools ?? []).find((t) => t.name === (process.env.MOCK_TOOL_NAME || 'ping_probe')) ?? parsed.tools[0];
        const tu = { type: 'tool_use', id: 'toolu_01', name: target.name, input: { probe: 'x' } };
        if (parsed.stream) {
          sse(res, [
            ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: parsed.model, usage } }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input) } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }],
            ['message_stop', { type: 'message_stop' }],
          ]);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: parsed.model, content: [tu], stop_reason: 'tool_use', usage }));
        }
        return;
      }
      if (parsed.stream) {
        sse(res, [
          ['message_start', { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: parsed.model, usage } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_2', type: 'message', role: 'assistant', model: parsed.model, content: [{ type: 'text', text: 'READY' }], stop_reason: 'end_turn', usage }));
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
