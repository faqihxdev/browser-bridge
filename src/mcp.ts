import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectController } from './client.js';
import { message } from './config.js';
import { tools, pageOperations } from './tools.js';
import type { Data } from './wire.js';

export async function runMcp(): Promise<void> {
  let client: Awaited<ReturnType<typeof connectController>> | undefined;
  let connecting: Promise<Awaited<ReturnType<typeof connectController>>> | undefined;
  const server = new Server({ name: 'browser-bridge', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: 'List tabs to obtain explicit tab IDs. Each tab has one agent owner. Release tabs when done. Preserve foreground focus unless requested. Use batches to reduce round trips. Raw CDP and browser APIs are privileged and share the real signed-in profile.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ op: _op, ...tool }) => tool) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const tool = tools.find(tool => tool.name === request.params.name);
      if (!tool) throw new Error('Unknown tool.');
      const args = (request.params.arguments ?? {}) as Data;
      const op = tool.op ?? String(args.op);
      if (tool.name === 'browser_page' && !pageOperations.has(op)) throw new Error('Unsupported page operation.');
      if (!client) {
        connecting ??= connectController(process.env.BROWSER_BRIDGE_AGENT ?? server.getClientVersion()?.name ?? 'MCP agent');
        try { client = await connecting; } finally { connecting = undefined; }
      }
      const result = await client.call(op, args);
      if (result && typeof result === 'object' && 'mimeType' in result && 'data' in result) {
        const image = result as { mimeType: string; data: string };
        return { content: [{ type: 'image' as const, ...image }] };
      }
      const images: { type: 'image'; mimeType: string; data: string }[] = [];
      const extract = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(extract);
        if (value && typeof value === 'object') {
          if ('mimeType' in value && 'data' in value && typeof value.data === 'string') {
            images.push({ type: 'image', mimeType: String(value.mimeType), data: value.data });
            return { image: images.length, mimeType: value.mimeType };
          }
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, extract(child)]));
        }
        return value;
      };
      const summary = extract(result);
      return { content: [{ type: 'text' as const, text: JSON.stringify(summary ?? null) }, ...images] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: message(error) }] }; }
  });
  const close = () => { client?.close(); void server.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close); process.stdin.once('end', close);
  await server.connect(new StdioServerTransport());
}
