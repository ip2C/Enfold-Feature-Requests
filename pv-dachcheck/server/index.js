// HTTP-Server: liefert die Web-App aus (public/) und stellt die API bereit.

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { calculatePv, ROOF_TYPES } from './pv-calculator.js';
import { scoreLead } from './lead-scoring.js';
import { createLeadStore, LEAD_STATUSES } from './lead-store.js';
import { createMailer } from './mailer.js';
import { fetchBuildingInsights } from './google-solar.js';
import { createRoofAnalyzer, RoofAnalysisError } from './roof-ai.js';
import { rateLimit } from './rate-limit.js';

const app = express();
const leads = createLeadStore(config.dataDir);
const mailer = createMailer(config.mail, config.company);
const analyzeRoofPhoto = config.anthropic.enabled ? createRoofAnalyzer(config.anthropic) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1); // korrekte Client-IP hinter Nginx/Load-Balancer (für das Rate-Limit)
app.use(express.json({ limit: '8mb' })); // Fotos kommen verkleinert als Base64 (~0,5–2 MB)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Einbettung per iframe nur auf den eigenen Websites erlauben (z. B. die Enfold-Seite).
  res.set('Content-Security-Policy', `frame-ancestors 'self' ${process.env.ALLOWED_FRAME_ANCESTORS || ''}`.trim());
  next();
});
app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

// ---------- Öffentliche API ----------

app.get('/api/config', (req, res) => {
  res.json({
    mapsKey: config.google.mapsBrowserKey,
    aiEnabled: Boolean(analyzeRoofPhoto),
    solarEnabled: Boolean(config.google.solarServerKey),
    company: config.company,
    roofTypes: Object.fromEntries(Object.entries(ROOF_TYPES).map(([k, v]) => [k, v.label])),
  });
});

app.get('/api/solar', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!isValidCoordinate(lat, lng)) return res.status(400).json({ error: 'Ungültige Koordinaten' });
  try {
    const insights = await fetchBuildingInsights({ lat, lng }, config.google.solarServerKey);
    res.json(insights ? { found: true, ...insights } : { found: false });
  } catch (err) {
    console.error('[solar]', err.message);
    res.json({ found: false }); // Kein harter Fehler: App funktioniert auch ohne Solar-Daten
  }
});

app.post('/api/analyze-photo', rateLimit({ windowMs: 10 * 60_000, max: 5 }), async (req, res) => {
  if (!analyzeRoofPhoto) return res.status(503).json({ error: 'KI-Analyse ist nicht aktiviert' });
  const { imageBase64, mediaType } = req.body ?? {};
  if (typeof imageBase64 !== 'string' || imageBase64.length < 1000) {
    return res.status(400).json({ error: 'Kein Foto übermittelt' });
  }
  try {
    res.json(await analyzeRoofPhoto({ imageBase64, mediaType }));
  } catch (err) {
    console.error('[ai]', err);
    const message = err instanceof RoofAnalysisError ? err.message : 'Analyse fehlgeschlagen';
    res.status(502).json({ error: message });
  }
});

app.post('/api/calculate', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  res.json(calculatePv(parseRoofInput(req.body), config.pv));
});

app.post('/api/leads', rateLimit({ windowMs: 60 * 60_000, max: 10 }), async (req, res) => {
  const body = req.body ?? {};
  if (body.website) return res.json({ ok: true }); // Honeypot-Feld: nur Bots füllen es aus

  const contact = parseContact(body.contact);
  if (contact.errors.length) return res.status(400).json({ error: contact.errors.join(' ') });
  if (body.consent !== true) return res.status(400).json({ error: 'Bitte stimmen Sie der Kontaktaufnahme zu.' });

  // Ergebnis serverseitig neu berechnen – Zahlen aus dem Browser werden nicht übernommen.
  const roof = parseRoofInput(body.roof);
  const result = calculatePv(roof, config.pv);
  const extras = { storage: roof.storage, wallbox: roof.wallbox, heatPump: roof.heatPump };
  const score = scoreLead({ result, contact: contact.value, extras });

  const lead = await leads.create({
    contact: contact.value,
    address: parseAddress(body.address),
    roof,
    result,
    score,
    aiAnalysis: parseAiAnalysis(body.aiAnalysis),
    source: { utm: pickStrings(body.utm, ['source', 'medium', 'campaign', 'term', 'content']), referrer: str(body.referrer, 300) },
    consent: { contact: true, at: new Date().toISOString(), text: str(body.consentText, 500) },
  });

  // Mails und Webhook dürfen den Lead nicht verhindern – Fehler nur protokollieren.
  const adminUrl = `${config.publicBaseUrl}/admin.html#${lead.id}`;
  await Promise.allSettled([
    mailer.sendCustomerConfirmation(lead),
    mailer.sendSalesNotification(lead, adminUrl),
    pushToWebhook(lead),
  ]).then((results) => results.forEach((r) => r.status === 'rejected' && console.error('[lead:followup]', r.reason)));

  res.status(201).json({ id: lead.id, result });
});

// ---------- Vertriebs-Dashboard (Lead-Pipeline) ----------

function requireAdmin(req, res, next) {
  const expected = Buffer.from(config.admin.token);
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
  // timingSafeEqual verhindert, dass man das Token Zeichen für Zeichen über Antwortzeiten errät.
  if (!config.admin.token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  next();
}

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  const all = await leads.list();
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ leads: all, statuses: LEAD_STATUSES });
});

app.patch('/api/admin/leads/:id', requireAdmin, async (req, res) => {
  const patch = {};
  if (LEAD_STATUSES.includes(req.body?.status)) patch.status = req.body.status;
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes.slice(0, 5000);
  const lead = await leads.update(req.params.id, patch);
  if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
  res.json(lead);
});

app.get('/api/admin/leads.csv', requireAdmin, async (req, res) => {
  const rows = (await leads.list()).map((l) => [
    l.createdAt, l.status, l.score?.grade, l.score?.score, l.contact.name, l.contact.email, l.contact.phone,
    l.address?.formatted, l.result?.kwp, l.result?.yieldKwh, l.result?.investmentEur, l.contact.timeline, l.contact.ownership,
  ]);
  const header = ['Datum', 'Status', 'Klasse', 'Score', 'Name', 'E-Mail', 'Telefon', 'Adresse', 'kWp', 'kWh/Jahr', 'Investition', 'Zeitraum', 'Eigentum'];
  res.type('text/csv; charset=utf-8').attachment('leads.csv');
  res.send('﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\n'));
});

// ---------- Eingabe-Validierung ----------

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function pickStrings(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, str(obj?.[k], 100)]).filter(([, v]) => v));
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function parseRoofInput(body = {}) {
  const n = (v, min, max, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
  };
  const segments = Array.isArray(body.segments)
    ? body.segments.slice(0, 20).map((s) => ({
        areaM2: n(s.areaM2, 0, 5000, 0),
        tiltDeg: n(s.tiltDeg, 0, 90, 30),
        azimuthDeg: n(s.azimuthDeg, 0, 360, 180),
      }))
    : undefined;
  return {
    roofType: ROOF_TYPES[body.roofType] ? body.roofType : 'satteldach',
    footprintAreaM2: n(body.footprintAreaM2, 0, 5000, 0),
    tiltDeg: n(body.tiltDeg, 0, 70, 35),
    azimuthDeg: n(body.azimuthDeg, 0, 360, 180),
    obstructionLevel: n(body.obstructionLevel, 0, 3, 0),
    segments: segments?.length ? segments : undefined,
    persons: n(body.persons, 1, 10, 3),
    annualConsumptionKwh: n(body.annualConsumptionKwh, 0, 100_000, 0),
    storage: Boolean(body.storage),
    wallbox: Boolean(body.wallbox),
    heatPump: Boolean(body.heatPump),
  };
}

export function parseContact(c = {}) {
  const value = {
    name: str(c.name, 120),
    email: str(c.email, 200).toLowerCase(),
    phone: str(c.phone, 40),
    ownership: ['eigentuemer', 'kauf-geplant', 'mieter'].includes(c.ownership) ? c.ownership : 'unbekannt',
    timeline: ['sofort', '3-monate', '12-monate', 'informieren'].includes(c.timeline) ? c.timeline : 'unbekannt',
    callbackWanted: Boolean(c.callbackWanted),
    message: str(c.message, 2000),
  };
  const errors = [];
  if (value.name.length < 2) errors.push('Bitte geben Sie Ihren Namen an.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.email)) errors.push('Bitte geben Sie eine gültige E-Mail-Adresse an.');
  if (value.phone.replace(/\D/g, '').length < 6) errors.push('Bitte geben Sie eine gültige Telefonnummer an.');
  return { value, errors };
}

function parseAddress(a = {}) {
  const lat = Number(a.lat);
  const lng = Number(a.lng);
  return {
    formatted: str(a.formatted, 300),
    ...(isValidCoordinate(lat, lng) ? { lat, lng } : {}),
  };
}

function parseAiAnalysis(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    roofType: str(a.roofType, 30),
    pitchDeg: Number(a.pitchDeg) || null,
    pitchConfidence: str(a.pitchConfidence, 20),
    roofCovering: str(a.roofCovering, 100),
    obstructions: Array.isArray(a.obstructions) ? a.obstructions.slice(0, 10).map((o) => str(o, 100)) : [],
    shadingRisk: str(a.shadingRisk, 20),
    salesNotes: str(a.salesNotes, 1000),
  };
}

function csvCell(v) {
  let s = String(v ?? '');
  // Schutz vor CSV-/Formel-Injection beim Öffnen in Excel.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function pushToWebhook(lead) {
  if (!config.leadWebhookUrl) return;
  const res = await fetch(config.leadWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(lead),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
}

// Fehler-Handler für kaputtes JSON o. Ä.
app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  res.status(err.status || 500).json({ error: err.status === 413 ? 'Foto ist zu groß' : 'Serverfehler' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(config.port, () => {
    console.log(`PV-Dachcheck läuft auf http://localhost:${config.port}`);
    if (!config.google.mapsBrowserKey) console.log('  ⚠ GOOGLE_MAPS_BROWSER_KEY fehlt – Karte/Adresssuche deaktiviert');
    if (!config.google.solarServerKey) console.log('  ⚠ GOOGLE_SOLAR_SERVER_KEY fehlt – keine Google-Solar-Dachdaten');
    if (!analyzeRoofPhoto) console.log('  ⚠ ANTHROPIC_API_KEY fehlt – KI-Fotoanalyse deaktiviert');
    if (!config.admin.token) console.log('  ⚠ ADMIN_TOKEN fehlt – Lead-Dashboard gesperrt');
  });
}

export { app };
