import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead } from '../server/lead-scoring.js';

const bigSouthRoof = { kwp: 12, orientationFactor: 0.97 };
const smallNorthRoof = { kwp: 2.5, orientationFactor: 0.72 };

test('Eigentümer mit großem Süddach, der sofort starten will = A-Lead', () => {
  const s = scoreLead({
    result: bigSouthRoof,
    contact: { ownership: 'eigentuemer', timeline: 'sofort', phone: '0170 1234567', callbackWanted: true },
    extras: { storage: true, wallbox: true },
  });
  assert.equal(s.grade, 'A');
  assert.ok(s.score <= 100);
});

test('Mieter mit kleinem Dach, der sich nur informiert = C-Lead', () => {
  const s = scoreLead({ result: smallNorthRoof, contact: { ownership: 'mieter', timeline: 'informieren' } });
  assert.equal(s.grade, 'C');
  assert.ok(s.reasons.some((r) => r.includes('Mieter')));
});
