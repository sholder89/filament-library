/**
 * The MCP endpoint, end to end: the real app on a free port with a throwaway
 * database, driven by the SDK's own client.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EXPECTED = [
  'filament_list', 'filament_get', 'filament_history', 'filament_stats', 'filament_list_locations',
  'filament_catalog_search', 'filament_list_spool_tares', 'filament_print_status',
  'filament_create', 'filament_update', 'filament_set_status', 'filament_undo', 'filament_duplicate',
  'filament_create_location', 'filament_update_location', 'filament_print_label',
];

const dir = mkdtempSync(join(tmpdir(), 'filament-mcp-'));
const apps = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    }).on('error', reject);
  });
}

/** Starts the app; resolves with its base URL once it's listening. */
async function startApp(name, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: join(dir, `${name}.db`),
      // Never reach a real printer or Vision from a test.
      LABEL_RELAY_URL: '', LABEL_TOKEN: '', LABEL_CLIENT_URL: '', VISION_API_KEY: '',
      MCP_TOKEN: '', MCP_ALLOWED_ORIGINS: '', MCP_ENABLED: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apps.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start`)), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => reject(new Error(`${name} exited with ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

async function connect(base, headers = {}) {
  const client = new Client({ name: 'filament-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

const pass = (name) => console.log(`PASS  ${name}`);

try {
  const base = await startApp('main');
  const client = await connect(base);

  // tools/list: exactly the agreed tools, each annotated.
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
  pass(`tools/list returns the ${EXPECTED.length} expected tools`);
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} has annotations`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} readOnlyHint`);
    assert.equal(typeof t.annotations.openWorldHint, 'boolean', `${t.name} openWorldHint`);
    if (!t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, `${t.name} destructiveHint`);
    assert.ok(t.description?.length > 20, `${t.name} description`);
  }
  pass('every tool has annotations and a description');

  // A read tool returns data.
  const stats = await client.callTool({ name: 'filament_stats', arguments: {} });
  assert.ok(!stats.isError, JSON.stringify(stats.content));
  assert.equal(stats.structuredContent.total, 0);
  const catalog = await client.callTool({ name: 'filament_catalog_search', arguments: { q: 'sunlu' } });
  assert.ok(catalog.structuredContent.brands.includes('Sunlu'));
  pass('read tools return data');

  // A write round-trips: create, edit, read back, list, undo.
  const created = await client.callTool({
    name: 'filament_create',
    arguments: { brand: 'Sunlu', material: 'PLA', color_name: 'Red', color_hex: '#CC0000' },
  });
  assert.ok(!created.isError, JSON.stringify(created.content));
  const id = created.structuredContent.created[0].id;
  assert.match(id, /^[0-9A-Z]{8}$/);

  const updated = await client.callTool({ name: 'filament_update', arguments: { id, remaining_pct: 40, status: 'opened' } });
  assert.equal(updated.structuredContent.remaining_pct, 40);
  const got = await client.callTool({ name: 'filament_get', arguments: { id } });
  assert.equal(got.structuredContent.remaining_pct, 40);
  assert.equal(got.structuredContent.status, 'opened');

  const listed = await client.callTool({ name: 'filament_list', arguments: { q: 'sunlu red', limit: 5 } });
  assert.equal(listed.structuredContent.total, 1);
  assert.equal(listed.structuredContent.items[0].id, id);

  // Dates are plain strings; an empty one clears the date.
  const dated = await client.callTool({ name: 'filament_update', arguments: { id, purchased_at: '2026-10-01' } });
  assert.match(dated.structuredContent.purchased_at, /^2026-10-01/);
  const cleared = await client.callTool({ name: 'filament_update', arguments: { id, purchased_at: '' } });
  assert.equal(cleared.structuredContent.purchased_at, null);
  await client.callTool({ name: 'filament_undo', arguments: { id } });
  await client.callTool({ name: 'filament_undo', arguments: { id } });

  const undone = await client.callTool({ name: 'filament_undo', arguments: { id } });
  assert.ok(!undone.isError, JSON.stringify(undone.content));
  assert.equal(undone.structuredContent.remaining_pct, 100);
  assert.equal(undone.structuredContent.status, 'new');
  pass('create, update, get, list and undo round-trip against a temp database');

  // Locations: create one, and loading into a printer works by name.
  const place = await client.callTool({
    name: 'filament_create_location', arguments: { name: 'Bambu H2S', kind: 'printer', code: 'H2S' },
  });
  assert.equal(typeof place.structuredContent.id, 'number');
  const loaded = await client.callTool({ name: 'filament_update', arguments: { id, location: 'Bambu H2S' } });
  assert.equal(loaded.structuredContent.loaded, 1);
  const status = await client.callTool({ name: 'filament_set_status', arguments: { id, action: 'empty' } });
  assert.equal(status.structuredContent.status, 'empty');
  pass('locations and status changes work');

  // REST errors come back as tool errors carrying the app's message.
  const missing = await client.callTool({ name: 'filament_get', arguments: { id: 'NOPE0000' } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /not found/i);
  const noPrinter = await client.callTool({ name: 'filament_print_label', arguments: { id } });
  assert.equal(noPrinter.isError, true);
  assert.match(noPrinter.content[0].text, /not configured/i);
  pass('API errors are returned as isError with the app\'s message');

  const printStatus = await client.callTool({ name: 'filament_print_status', arguments: {} });
  assert.equal(printStatus.structuredContent.mode, 'off');
  assert.ok(!('target' in printStatus.structuredContent), 'printer address is not exposed');
  pass('print status leaves out the printer address');
  await client.close();

  // A browser page on another origin is refused; other methods are not allowed.
  const init = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const foreign = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://evil.example' },
    body: JSON.stringify(init),
  });
  assert.equal(foreign.status, 403);
  pass('a foreign Origin gets 403');
  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  pass('GET /mcp is 405 with Allow: POST');

  // With MCP_TOKEN set, the bearer token is required.
  const guarded = await startApp('token', { MCP_TOKEN: 'sekrit' });
  const noToken = await fetch(`${guarded}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(init),
  });
  assert.equal(noToken.status, 401);
  const withToken = await connect(guarded, { authorization: 'Bearer sekrit' });
  assert.ok((await withToken.listTools()).tools.length);
  await withToken.close();
  pass('MCP_TOKEN requires the bearer token');

  // MCP_ENABLED=false leaves /mcp unmounted.
  const off = await startApp('off', { MCP_ENABLED: 'false' });
  assert.equal((await fetch(`${off}/mcp`, { method: 'POST' })).status, 404);
  pass('MCP_ENABLED=false turns the endpoint off');

  console.log('All MCP checks passed.');
} finally {
  for (const child of apps) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
