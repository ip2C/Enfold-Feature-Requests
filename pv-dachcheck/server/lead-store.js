// Einfache Lead-Ablage als JSON-Datei. Reicht für den Start (einige tausend Leads).
// Später durch eine Datenbank oder das CRM ersetzen – die Schnittstelle (list/get/create/update)
// bleibt dann gleich, nur dieses Modul wird ausgetauscht.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const LEAD_STATUSES = ['neu', 'kontaktiert', 'termin', 'angebot', 'gewonnen', 'verloren'];

export function createLeadStore(dataDir) {
  const file = path.join(dataDir, 'leads.json');
  // Alle Schreibzugriffe laufen nacheinander über diese Promise-Kette,
  // damit sich zwei gleichzeitige Anfragen nicht gegenseitig überschreiben.
  let queue = Promise.resolve();

  async function load() {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async function save(leads) {
    await mkdir(dataDir, { recursive: true });
    // Erst in eine temporäre Datei schreiben, dann umbenennen: so ist die Datei nie halb geschrieben.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(leads, null, 2));
    await rename(tmp, file);
  }

  function serialized(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  return {
    list: () => load(),
    get: async (id) => (await load()).find((l) => l.id === id) ?? null,
    create: (data) =>
      serialized(async () => {
        const leads = await load();
        const now = new Date().toISOString();
        const lead = { id: randomUUID(), createdAt: now, updatedAt: now, status: 'neu', notes: '', ...data };
        leads.push(lead);
        await save(leads);
        return lead;
      }),
    update: (id, patch) =>
      serialized(async () => {
        const leads = await load();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return null;
        Object.assign(lead, patch, { updatedAt: new Date().toISOString() });
        await save(leads);
        return lead;
      }),
  };
}
