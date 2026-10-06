// KI-Fotoanalyse mit Claude (Anthropic API, Vision).
// Der Kunde fotografiert sein Haus mit dem Handy; Claude schätzt Dachform, Dachneigung
// und Hindernisse (Gauben, Schornstein, Bäume). Das ist eine GROBE Schätzung – sie dient
// als Vorbelegung, der Kunde kann jeden Wert im nächsten Schritt korrigieren.

import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `Du bist Gutachter für Photovoltaik-Dachanalysen bei einem deutschen Solarfachbetrieb.
Ein Interessent hat ein Handyfoto seines Gebäudes hochgeladen. Schätze daraus die für eine PV-Anlage relevanten Dacheigenschaften.

Hinweise zur Schätzung:
- Dachneigung: Schätze den Winkel der Dachfläche gegen die Horizontale anhand der Giebel-/Traufgeometrie. Perspektive und Kamerawinkel verzerren – berücksichtige das und gib eine realistische Unsicherheit über pitch_confidence an. Typische Werte in Deutschland: Satteldach 30–50°, Pultdach 5–25°, Flachdach 0–5°.
- obstruction_level: 0 = freie Dachfläche, 1 = einzelne kleine Hindernisse, 2 = mehrere Gauben/Dachfenster, 3 = Dach stark zerklüftet oder verschattet.
- Wenn auf dem Foto kein Gebäude bzw. kein Dach erkennbar ist, setze is_building_photo auf false und roof_type auf "unbekannt".
- customer_message: 1–2 freundliche Sätze für den Interessenten (Sie-Form), ohne Zahlenversprechen.
- sales_notes: kurze sachliche Hinweise für den Vertrieb (Dacheindeckung, Zustand, Besonderheiten wie Asbestverdacht, Denkmalschutz-Optik, Gerüst-Zugang).`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_building_photo',
    'roof_type',
    'pitch_degrees',
    'pitch_confidence',
    'roof_covering',
    'obstruction_level',
    'obstructions',
    'shading_risk',
    'customer_message',
    'sales_notes',
  ],
  properties: {
    is_building_photo: { type: 'boolean' },
    roof_type: { type: 'string', enum: ['satteldach', 'pultdach', 'walmdach', 'flachdach', 'unbekannt'] },
    pitch_degrees: { type: 'number', description: 'Geschätzte Dachneigung in Grad (0–70)' },
    pitch_confidence: { type: 'string', enum: ['niedrig', 'mittel', 'hoch'] },
    roof_covering: { type: 'string', description: 'z. B. Tondachziegel, Betondachstein, Schiefer, Blech, Bitumen, unbekannt' },
    obstruction_level: { type: 'integer', description: '0 bis 3' },
    obstructions: { type: 'array', items: { type: 'string' } },
    shading_risk: { type: 'string', enum: ['gering', 'mittel', 'hoch'] },
    customer_message: { type: 'string' },
    sales_notes: { type: 'string' },
  },
};

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class RoofAnalysisError extends Error {}

export function createRoofAnalyzer({ model }) {
  // Der Client liest ANTHROPIC_API_KEY automatisch aus der Umgebung.
  const client = new Anthropic();

  return async function analyzeRoofPhoto({ imageBase64, mediaType }) {
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) throw new RoofAnalysisError('Bildformat nicht unterstützt');

    // `fallbacks: "default"`: lehnt das Modell eine Anfrage ab, beantwortet automatisch ein
    // anderes Claude-Modell dieselbe Anfrage (serverseitig, kein zweiter Request nötig).
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Bitte analysiere das Dach auf diesem Foto.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') throw new RoofAnalysisError('Foto konnte nicht analysiert werden');
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new RoofAnalysisError('Leere KI-Antwort');

    return normalizeAnalysis(JSON.parse(text));
  };
}

/** Werte absichern, bevor sie in Formular und Berechnung landen. */
export function normalizeAnalysis(raw) {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  return {
    isBuildingPhoto: Boolean(raw.is_building_photo),
    roofType: raw.roof_type === 'unbekannt' ? null : raw.roof_type,
    pitchDeg: Math.round(clamp(raw.pitch_degrees, 0, 70)),
    pitchConfidence: raw.pitch_confidence,
    roofCovering: String(raw.roof_covering || '').slice(0, 100),
    obstructionLevel: Math.round(clamp(raw.obstruction_level, 0, 3)),
    obstructions: (raw.obstructions || []).slice(0, 10).map((o) => String(o).slice(0, 100)),
    shadingRisk: raw.shading_risk,
    customerMessage: String(raw.customer_message || '').slice(0, 500),
    salesNotes: String(raw.sales_notes || '').slice(0, 1000),
  };
}
