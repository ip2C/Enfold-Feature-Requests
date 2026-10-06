import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Testumgebung vor dem Import des Servers setzen (config liest die Variablen beim Laden).
const dataDir = await mkdtemp(path.join(tmpdir(), 'pv-test-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_TOKEN = 'test-token';
process.env.APP_ORIGINS = 'capacitor://localhost';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.SMTP_HOST;

const { app } = await import('../server/index.js');
let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const validLead = {
  contact: { name: 'Erika Muster', email: 'erika@example.com', phone: '0170 1234567', ownership: 'eigentuemer', timeline: 'sofort' },
  consent: true,
  address: { formatted: 'Musterstraße 1, 12345 Musterstadt', lat: 50.1, lng: 8.6 },
  roof: { roofType: 'satteldach', footprintAreaM2: 110, tiltDeg: 38, azimuthDeg: 180, persons: 4, storage: true },
};

test('GET /api/config meldet deaktivierte KI ohne API-Key', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.aiEnabled, false);
  assert.ok(cfg.roofTypes.satteldach);
});

test('POST /api/calculate rechnet und begrenzt unsinnige Eingaben', async () => {
  const r = await (await post('/api/calculate', { footprintAreaM2: 1e9, tiltDeg: 'abc', roofType: '<script>' })).json();
  assert.equal(r.roofType, 'satteldach');
  assert.ok(r.kwp > 0 && r.kwp < 2000);
});

test('POST /api/leads lehnt Leads ohne Einwilligung bzw. ohne Telefon ab', async () => {
  assert.equal((await post('/api/leads', { ...validLead, consent: false })).status, 400);
  const noPhone = { ...validLead, contact: { ...validLead.contact, phone: '' } };
  assert.equal((await post('/api/leads', noPhone)).status, 400);
});

test('POST /api/leads speichert Lead, rechnet serverseitig und bewertet ihn', async () => {
  const res = await post('/api/leads', { ...validLead, result: { kwp: 9999 } });
  assert.equal(res.status, 201);
  const { id, result } = await res.json();
  assert.ok(result.kwp < 100, 'Ergebnis aus dem Browser darf nicht übernommen werden');

  const unauthorized = await fetch(`${base}/api/admin/leads`);
  assert.equal(unauthorized.status, 401);

  const auth = { authorization: 'Bearer test-token' };
  const { leads } = await (await fetch(`${base}/api/admin/leads`, { headers: auth })).json();
  const lead = leads.find((l) => l.id === id);
  assert.equal(lead.status, 'neu');
  assert.equal(lead.score.grade, 'A');

  const patched = await fetch(`${base}/api/admin/leads/${id}`, {
    method: 'PATCH',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'kontaktiert', notes: 'Termin Do 10 Uhr' }),
  });
  assert.equal((await patched.json()).status, 'kontaktiert');

  const csv = await (await fetch(`${base}/api/admin/leads.csv`, { headers: auth })).text();
  assert.ok(csv.includes('Erika Muster'));
});

test('Honeypot: Bot-Anfragen werden still verworfen', async () => {
  const res = await post('/api/leads', { ...validLead, website: 'http://spam' });
  assert.equal(res.status, 200);
});

test('CORS: freigegebene App darf die API nutzen, fremde Seiten nicht', async () => {
  const allowed = await fetch(`${base}/api/config`, { headers: { origin: 'capacitor://localhost' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const preflight = await fetch(`${base}/api/leads`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost' } });
  assert.equal(preflight.status, 204);
  const foreign = await fetch(`${base}/api/config`, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
});
