import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePv, orientationFactor, buildRoofFaces, compassLabel, deviationFromSouth } from '../server/pv-calculator.js';
import { config } from '../server/config.js';

test('Ausrichtungsfaktor: Süd 30° ist das Optimum, Nord schlechter als Ost', () => {
  assert.equal(orientationFactor(30, 180), 1);
  assert.ok(orientationFactor(30, 90) > orientationFactor(30, 0));
  assert.equal(orientationFactor(30, 90), orientationFactor(30, 270)); // Ost = West
  assert.equal(orientationFactor(0, 0), 0.87); // flach: Richtung egal
});

test('Ausrichtungsfaktor interpoliert zwischen Tabellenwerten', () => {
  const f = orientationFactor(37.5, 180); // zwischen 30° (1.00) und 45° (0.98)
  assert.ok(f < 1 && f > 0.98);
});

test('Hilfsfunktionen für Himmelsrichtungen', () => {
  assert.equal(compassLabel(180), 'Süd');
  assert.equal(compassLabel(-90), 'West');
  assert.equal(deviationFromSouth(90), 90);
  assert.equal(deviationFromSouth(350), 170);
});

test('Draufsicht wird über die Neigung in echte Dachfläche umgerechnet', () => {
  const faces = buildRoofFaces({ roofType: 'pultdach', footprintAreaM2: 100, tiltDeg: 60, azimuthDeg: 180 });
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].areaM2 - 200) < 0.001); // cos(60°) = 0,5
});

test('Satteldach Süd: nur die Südseite wird belegt, die Nordseite nicht', () => {
  const r = calculatePv({ roofType: 'satteldach', footprintAreaM2: 120, tiltDeg: 35, azimuthDeg: 180, persons: 4 }, config.pv);
  const south = r.faces.find((f) => f.direction === 'Süd');
  const north = r.faces.find((f) => f.direction === 'Nord');
  assert.ok(south.used && south.modules > 0);
  assert.ok(!north.used && north.modules === 0);
  assert.ok(r.kwp > 5 && r.kwp < 20, `kWp plausibel: ${r.kwp}`);
  assert.ok(r.yieldKwh > 800 * r.kwp && r.yieldKwh < 1000 * r.kwp);
});

test('Satteldach Ost/West: beide Seiten werden belegt', () => {
  const r = calculatePv({ roofType: 'satteldach', footprintAreaM2: 120, tiltDeg: 30, azimuthDeg: 90 }, config.pv);
  assert.equal(r.faces.filter((f) => f.used).length, 2);
});

test('Google-Solar-Segmente haben Vorrang vor der Karteneingabe', () => {
  const r = calculatePv(
    { footprintAreaM2: 1000, segments: [{ areaM2: 40, tiltDeg: 30, azimuthDeg: 180 }] },
    config.pv,
  );
  assert.equal(r.faces.length, 1);
  assert.equal(r.faces[0].source, 'google-solar');
  assert.ok(r.kwp < 8);
});

test('Speicher erhöht den Eigenverbrauch, Wirtschaftlichkeit ist plausibel', () => {
  const base = { roofType: 'satteldach', footprintAreaM2: 120, tiltDeg: 35, azimuthDeg: 180, persons: 4 };
  const without = calculatePv(base, config.pv);
  const withStorage = calculatePv({ ...base, storage: true }, config.pv);
  assert.ok(withStorage.selfUsedKwh > without.selfUsedKwh);
  assert.ok(withStorage.storageKwh > 0);
  assert.ok(without.paybackYears > 5 && without.paybackYears < 20, `Amortisation: ${without.paybackYears}`);
  assert.equal(without.investmentEur % 100, 0);
});

test('Ohne Dachfläche keine Anlage und keine Division durch null', () => {
  const r = calculatePv({ footprintAreaM2: 0 }, config.pv);
  assert.equal(r.kwp, 0);
  assert.equal(r.paybackYears, null);
  assert.equal(r.rating.key, 'gering');
});
