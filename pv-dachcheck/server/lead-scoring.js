// Lead-Scoring: beantwortet für den Vertrieb die zwei Fragen
//   1. Ist das Dach interessant?      (Größe, Ausrichtung)
//   2. Ist der Kunde interessant?     (Eigentümer, Zeitrahmen, Zusatzprodukte, Erreichbarkeit)
// Ergebnis: Punkte 0–100 und eine Klasse A (heiß) / B (warm) / C (kalt).
// Die Gewichte sind Startwerte – nach den ersten Wochen anhand echter Abschlüsse nachjustieren.

const TIMELINE_POINTS = { sofort: 20, '3-monate': 15, '12-monate': 8, informieren: 2 };
const OWNERSHIP_POINTS = { eigentuemer: 15, 'kauf-geplant': 10, mieter: 0 };

export function scoreLead({ result, contact = {}, extras = {} }) {
  const reasons = [];
  let roof = 0;
  let customer = 0;

  // --- Dach (max. 45 Punkte) ---
  const kwp = result?.kwp ?? 0;
  if (kwp >= 15) roof += 25;
  else if (kwp >= 8) roof += 20;
  else if (kwp >= 5) roof += 14;
  else if (kwp >= 3) roof += 8;
  else roof += 2;
  reasons.push(`${kwp.toLocaleString('de-DE')} kWp möglich`);

  const factor = result?.orientationFactor ?? 0;
  if (factor >= 0.92) roof += 20;
  else if (factor >= 0.8) roof += 14;
  else if (factor >= 0.7) roof += 8;
  reasons.push(`Ausrichtungsfaktor ${Math.round(factor * 100)} %`);

  // --- Kunde (max. 55 Punkte) ---
  const ownership = OWNERSHIP_POINTS[contact.ownership] ?? 5;
  customer += ownership;
  if (contact.ownership === 'mieter') reasons.push('Mieter – Eigentümer muss zustimmen');

  customer += TIMELINE_POINTS[contact.timeline] ?? 5;
  if (contact.timeline === 'sofort') reasons.push('Möchte sofort starten');

  const upsell = ['storage', 'wallbox', 'heatPump'].filter((k) => extras[k]);
  customer += Math.min(upsell.length * 4, 10);
  if (upsell.length) reasons.push(`Interesse an: ${upsell.map(upsellLabel).join(', ')}`);

  if (contact.phone) customer += 6;
  if (contact.callbackWanted) {
    customer += 4;
    reasons.push('Rückruf gewünscht');
  }

  const score = Math.max(0, Math.min(100, roof + customer));
  const grade = score >= 70 ? 'A' : score >= 45 ? 'B' : 'C';
  return { score, grade, roofPoints: roof, customerPoints: customer, reasons };
}

function upsellLabel(key) {
  return { storage: 'Speicher', wallbox: 'Wallbox', heatPump: 'Wärmepumpe' }[key] ?? key;
}
