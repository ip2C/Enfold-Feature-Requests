// Google Solar API (buildingInsights:findClosest)
// Liefert – wo Google Daten hat – die echten Dachflächen eines Gebäudes mit Neigung und Ausrichtung.
// In Deutschland ist die Abdeckung gut in Städten, auf dem Land lückenhaft. Ohne Treffer
// fällt die App automatisch auf das Einzeichnen auf der Karte + Kundenangaben zurück.
// Doku: https://developers.google.com/maps/documentation/solar/building-insights

const ENDPOINT = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';

export async function fetchBuildingInsights({ lat, lng }, apiKey) {
  if (!apiKey) return null;

  const url = new URL(ENDPOINT);
  url.searchParams.set('location.latitude', String(lat));
  url.searchParams.set('location.longitude', String(lng));
  url.searchParams.set('requiredQuality', 'MEDIUM');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null; // kein Gebäude / keine Daten an dieser Stelle
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Solar API ${res.status}: ${body.slice(0, 300)}`);
  }
  return summarizeBuildingInsights(await res.json());
}

/** Reduziert die große API-Antwort auf das, was App und Rechner brauchen. */
export function summarizeBuildingInsights(data) {
  const sp = data?.solarPotential;
  if (!sp) return null;

  const segments = (sp.roofSegmentStats ?? [])
    .map((s) => ({
      areaM2: s.stats?.areaMeters2 ?? 0,
      tiltDeg: s.pitchDegrees ?? 0,
      azimuthDeg: s.azimuthDegrees ?? 180,
    }))
    .filter((s) => s.areaM2 >= 5); // Gauben, Mini-Flächen ignorieren

  if (segments.length === 0) return null;

  return {
    segments,
    maxPanels: sp.maxArrayPanelsCount ?? null,
    maxSunshineHoursPerYear: sp.maxSunshineHoursPerYear ?? null,
    imageryDate: data.imageryDate ?? null,
    imageryQuality: data.imageryQuality ?? null,
    center: data.center ?? null,
  };
}
