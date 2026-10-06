// PV-Rechenkern: reine Funktionen ohne Seiteneffekte – dadurch leicht testbar
// (siehe test/pv-calculator.test.js) und im Browser wie auf dem Server nutzbar.
//
// Konventionen:
//   Azimut in Grad wie auf dem Kompass: 0 = Nord, 90 = Ost, 180 = Süd, 270 = West.
//   Neigung in Grad: 0 = flach, 90 = senkrecht (Fassade).

// Ertragsfaktor relativ zum Optimum (Süd, ~30–35°) für Deutschland.
// Zeilen: Neigung, Spalten: Abweichung von Süd (0 = Süd, 90 = Ost/West, 180 = Nord).
// Werte angelehnt an gängige Einstrahlungstabellen (PVGIS, DGS) und bewusst gerundet.
const TILTS = [0, 15, 30, 45, 60, 90];
const DEVIATIONS = [0, 45, 90, 135, 180];
const FACTORS = [
  /*  0° */ [0.87, 0.87, 0.87, 0.87, 0.87],
  /* 15° */ [0.95, 0.93, 0.87, 0.8, 0.77],
  /* 30° */ [1.0, 0.95, 0.82, 0.68, 0.6],
  /* 45° */ [0.98, 0.92, 0.76, 0.58, 0.47],
  /* 60° */ [0.91, 0.85, 0.68, 0.48, 0.36],
  /* 90° */ [0.7, 0.66, 0.53, 0.36, 0.27],
];

export const ROOF_TYPES = {
  // faces: Dachflächen relativ zur Hauptausrichtung (azimuthOffset) mit Flächenanteil (share).
  satteldach: { label: 'Satteldach', faces: [{ azimuthOffset: 0, share: 0.5 }, { azimuthOffset: 180, share: 0.5 }] },
  pultdach: { label: 'Pultdach', faces: [{ azimuthOffset: 0, share: 1 }] },
  walmdach: {
    label: 'Walmdach',
    faces: [
      { azimuthOffset: 0, share: 0.35 },
      { azimuthOffset: 180, share: 0.35 },
      { azimuthOffset: 90, share: 0.15 },
      { azimuthOffset: 270, share: 0.15 },
    ],
  },
  flachdach: { label: 'Flachdach', faces: [{ azimuthOffset: 0, share: 1 }] },
};

// Dachflächen unter diesem Ertragsfaktor werden nicht belegt (lohnt sich meist nicht).
export const MIN_FACE_FACTOR = 0.7;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
// round(1234.5) = 1235, round(1.234, 2) = 1.23, round(12345, -2) = 12300
const round = (v, digits = 0) => {
  if (digits < 0) {
    const step = 10 ** -digits;
    return Math.round(v / step) * step;
  }
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export function normalizeAzimuth(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Abweichung von Süd in Grad (0–180), unabhängig davon ob nach Ost oder West. */
export function deviationFromSouth(azimuthDeg) {
  return Math.abs(normalizeAzimuth(azimuthDeg) - 180);
}

function interpolate(axis, value) {
  const v = clamp(value, axis[0], axis[axis.length - 1]);
  let i = axis.findIndex((x, idx) => v >= x && v <= axis[idx + 1]);
  if (i === -1) i = axis.length - 2;
  const t = (v - axis[i]) / (axis[i + 1] - axis[i]);
  return { i, t };
}

/** Ertragsfaktor (0–1) für eine Dachfläche – bilineare Interpolation in der Tabelle. */
export function orientationFactor(tiltDeg, azimuthDeg) {
  const tilt = interpolate(TILTS, tiltDeg);
  const dev = interpolate(DEVIATIONS, deviationFromSouth(azimuthDeg));
  const row = (r) => FACTORS[r][dev.i] * (1 - dev.t) + FACTORS[r][dev.i + 1] * dev.t;
  return round(row(tilt.i) * (1 - tilt.t) + row(tilt.i + 1) * tilt.t, 3);
}

export function compassLabel(azimuthDeg) {
  const labels = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];
  return labels[Math.round(normalizeAzimuth(azimuthDeg) / 45) % 8];
}

/**
 * Erzeugt die einzelnen Dachflächen.
 * Variante A: Google Solar API liefert echte Segmente (Fläche bereits schräg gemessen).
 * Variante B: Kunde zeichnet den Grundriss auf der Karte (Draufsicht!) – die echte
 *             Dachfläche ist größer: Fläche_schräg = Fläche_Draufsicht / cos(Neigung).
 */
export function buildRoofFaces(input) {
  if (Array.isArray(input.segments) && input.segments.length > 0) {
    return input.segments.map((s) => ({
      areaM2: s.areaM2,
      tiltDeg: s.tiltDeg,
      azimuthDeg: normalizeAzimuth(s.azimuthDeg),
      source: 'google-solar',
    }));
  }

  const roofType = ROOF_TYPES[input.roofType] ? input.roofType : 'satteldach';
  const isFlat = roofType === 'flachdach';
  // Flachdach: Module werden aufgeständert (ca. 10–15°), Ausrichtung Süd oder Ost/West.
  const tiltDeg = isFlat ? 12 : clamp(input.tiltDeg ?? 35, 5, 70);
  const footprint = Math.max(0, Number(input.footprintAreaM2) || 0);
  const slopedArea = isFlat ? footprint : footprint / Math.cos((tiltDeg * Math.PI) / 180);

  return ROOF_TYPES[roofType].faces.map((f) => ({
    areaM2: slopedArea * f.share,
    tiltDeg,
    azimuthDeg: normalizeAzimuth((input.azimuthDeg ?? 180) + f.azimuthOffset),
    source: 'map',
  }));
}

/**
 * Hauptberechnung. Gibt eine Schätzung zurück – keine verbindliche Planung!
 * @param {object} input
 * @param {object} pv  Preis-/Technikannahmen aus config.pv
 */
export function calculatePv(input, pv) {
  const roofType = ROOF_TYPES[input.roofType] ? input.roofType : 'satteldach';
  // Nutzbarer Anteil: Randabstände, Schornstein, Dachfenster. Flachdach: Verschattungsabstände.
  const baseUsable = roofType === 'flachdach' ? 0.55 : 0.7;
  const obstructionPenalty = clamp(Number(input.obstructionLevel) || 0, 0, 3) * 0.07;
  const usableShare = clamp(baseUsable - obstructionPenalty, 0.3, 0.8);

  const faces = buildRoofFaces({ ...input, roofType }).map((face) => {
    const factor = orientationFactor(face.tiltDeg, face.azimuthDeg);
    const used = factor >= MIN_FACE_FACTOR;
    const modules = used ? Math.floor((face.areaM2 * usableShare) / pv.moduleAreaM2) : 0;
    const kwp = (modules * pv.moduleWp) / 1000;
    return {
      direction: compassLabel(face.azimuthDeg),
      azimuthDeg: round(face.azimuthDeg),
      tiltDeg: round(face.tiltDeg),
      areaM2: round(face.areaM2, 1),
      factor,
      used,
      modules,
      kwp: round(kwp, 2),
      yieldKwh: round(kwp * pv.specificYieldKwhPerKwp * factor),
      source: face.source,
    };
  });

  const modules = faces.reduce((s, f) => s + f.modules, 0);
  const kwp = round((modules * pv.moduleWp) / 1000, 2);
  const yieldKwh = faces.reduce((s, f) => s + f.yieldKwh, 0);
  const avgFactor = kwp > 0 ? round(faces.reduce((s, f) => s + f.factor * f.kwp, 0) / kwp, 3) : 0;

  // Verbrauch: Haushalt + geplante Großverbraucher.
  const household = Number(input.annualConsumptionKwh) || consumptionFromPersons(input.persons);
  const consumptionKwh = household + (input.wallbox ? 2000 : 0) + (input.heatPump ? 3500 : 0);

  // Faustformel Autarkiegrad: ohne Speicher ~30 %, mit Speicher ~65 % des Verbrauchs,
  // höchstens 90 % der Erzeugung kann selbst genutzt werden.
  const storageKwh = input.storage ? recommendStorageKwh(consumptionKwh, kwp) : 0;
  const autarkyTarget = storageKwh > 0 ? 0.65 : 0.3;
  const selfUsedKwh = round(Math.min(consumptionKwh * autarkyTarget, yieldKwh * 0.9));
  const feedInKwh = Math.max(0, yieldKwh - selfUsedKwh);

  const costPerKwp = kwp > 10 ? pv.costPerKwpLargeEur : pv.costPerKwpSmallEur;
  const investmentEur = round(kwp * costPerKwp + storageKwh * pv.storageCostPerKwhEur, -2);
  const savingsPerYearEur = round(selfUsedKwh * pv.electricityPriceEur + feedInKwh * pv.feedInTariffEur);

  let lifetimeSavings = 0;
  for (let y = 0; y < pv.lifetimeYears; y++) {
    lifetimeSavings += savingsPerYearEur * (1 - pv.degradationPerYear) ** y;
  }

  return {
    roofType,
    roofTypeLabel: ROOF_TYPES[roofType].label,
    faces,
    modules,
    kwp,
    yieldKwh,
    orientationFactor: avgFactor,
    rating: ratingFor(avgFactor, kwp),
    consumptionKwh,
    storageKwh,
    selfUsedKwh,
    feedInKwh: round(feedInKwh),
    autarkyPercent: consumptionKwh > 0 ? round((selfUsedKwh / consumptionKwh) * 100) : 0,
    investmentEur,
    savingsPerYearEur,
    paybackYears: savingsPerYearEur > 0 ? round(investmentEur / savingsPerYearEur, 1) : null,
    profit25YearsEur: round(lifetimeSavings - investmentEur, -2),
    co2SavedKgPerYear: round(yieldKwh * pv.co2KgPerKwh),
  };
}

export function consumptionFromPersons(persons) {
  const table = { 1: 1800, 2: 2800, 3: 3600, 4: 4200, 5: 5000 };
  const p = clamp(Math.round(Number(persons) || 3), 1, 6);
  return table[p] ?? 5000 + (p - 5) * 800;
}

export function recommendStorageKwh(consumptionKwh, kwp) {
  // Faustregel: ~1 kWh Speicher je 1.000 kWh Jahresverbrauch, nicht größer als die kWp-Leistung.
  return clamp(Math.round(Math.min(consumptionKwh / 1000, kwp)), 0, 20);
}

export function ratingFor(factor, kwp) {
  if (kwp < 2) return { key: 'gering', label: 'Wenig Platz – Balkonkraftwerk prüfen' };
  if (factor >= 0.92) return { key: 'sehr-gut', label: 'Sehr gut geeignet' };
  if (factor >= 0.8) return { key: 'gut', label: 'Gut geeignet' };
  return { key: 'ok', label: 'Geeignet' };
}
