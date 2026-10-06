// Solar-Dachcheck – Frontend-Logik (ohne Framework, ohne Build-Schritt).
// Aufbau: ein zentrales `state`-Objekt + ein Schritt-Assistent (STEPS).
// Jeder Schritt hat optional enter() (beim Anzeigen), canNext() (darf weiter?) und next() (Aktion).

const $ = (sel) => document.querySelector(sel);

// Adresse des Servers. Leer = derselbe Server, von dem die Seite kommt (Website).
// In einer späteren App (Capacitor) wird hier die volle Adresse eingetragen,
// z. B. <meta name="pv-api-base" content="https://solar.example.de">.
const API_BASE = document.querySelector('meta[name="pv-api-base"]')?.content.replace(/\/$/, '') ?? '';
const api = (path, options) => fetch(API_BASE + path, options);
const fmt = (v, digits = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(v);
const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  config: null,
  address: null, // { formatted, lat, lng }
  solar: null, // Ergebnis der Google Solar API
  useSolar: true,
  footprintAreaM2: 0,
  roofType: 'satteldach',
  tiltDeg: 35,
  azimuthDeg: 180,
  obstructionLevel: 0,
  ai: null,
  persons: 3,
  annualConsumptionKwh: 0,
  storage: false,
  wallbox: false,
  heatPump: false,
  result: null,
};

// ---------------------------------------------------------------------------
// Schritt-Assistent
// ---------------------------------------------------------------------------

const STEPS = [
  { id: 'start', nextLabel: 'Jetzt Dach prüfen' },
  { id: 'address', enter: enterAddress, canNext: () => Boolean(state.address?.formatted) },
  {
    id: 'map',
    enter: enterMap,
    canNext: () => (state.useSolar && state.solar) || state.footprintAreaM2 >= 10,
  },
  { id: 'photo', skippable: true },
  { id: 'roof', enter: enterRoof },
  { id: 'usage', nextLabel: 'Ergebnis berechnen', next: calculate },
  { id: 'contact', enter: renderTeaser, nextLabel: 'Auswertung anfordern', next: submitLead },
  { id: 'result', enter: renderFullResult, hideActions: true },
];

let current = 0;

function goTo(index, { push = true } = {}) {
  current = Math.max(0, Math.min(STEPS.length - 1, index));
  const step = STEPS[current];
  document.querySelectorAll('.step').forEach((el) => el.classList.toggle('active', el.dataset.step === step.id));
  $('#progress').style.width = `${(current / (STEPS.length - 1)) * 100}%`;
  $('#back').hidden = current === 0 || step.id === 'result';
  $('.actionbar').hidden = Boolean(step.hideActions);
  $('#next').textContent = step.nextLabel ?? 'Weiter';
  $('#skip').hidden = !step.skippable;
  step.enter?.();
  updateNextButton();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (push) history.pushState({ step: current }, '', `#${step.id}`);
  track('pv_step', { step: step.id });
}

function updateNextButton() {
  const step = STEPS[current];
  $('#next').disabled = step.canNext ? !step.canNext() : false;
}

async function onNext() {
  const step = STEPS[current];
  if (step.canNext && !step.canNext()) return;
  const btn = $('#next');
  btn.disabled = true;
  try {
    if (step.next && (await step.next()) === false) return;
    goTo(current + 1);
  } finally {
    updateNextButton();
  }
}

// Android-Zurück-Taste / Browser-Zurück soll einen Schritt zurück gehen, nicht die Seite verlassen.
window.addEventListener('popstate', (e) => {
  if (STEPS[current].id === 'result') return history.pushState({ step: current }, '', '#result');
  goTo(e.state?.step ?? 0, { push: false });
});

// ---------------------------------------------------------------------------
// Schritt 1: Adresse (Google Places Autocomplete)
// ---------------------------------------------------------------------------

let mapsReady = null; // Promise, die auflöst, wenn Google Maps geladen ist

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    window.__onGoogleMapsLoaded = resolve;
    const params = new URLSearchParams({
      key,
      v: 'weekly',
      loading: 'async',
      libraries: 'places,geometry',
      language: 'de',
      region: 'DE',
      callback: '__onGoogleMapsLoaded',
    });
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new Error('Google Maps konnte nicht geladen werden'));
    document.head.append(script);
  });
}

let autocompleteMounted = false;

async function enterAddress() {
  if (autocompleteMounted) return;
  autocompleteMounted = true;
  if (!mapsReady) return showAddressFallback();

  try {
    await mapsReady;
    const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
    const autocomplete = new PlaceAutocompleteElement({ includedRegionCodes: ['de', 'at', 'ch'] });
    autocomplete.setAttribute('placeholder', 'Straße Hausnummer, Ort');
    $('#place-autocomplete').append(autocomplete);

    autocomplete.addEventListener('gmp-select', async ({ placePrediction }) => {
      const place = placePrediction.toPlace();
      await place.fetchFields({ fields: ['formattedAddress', 'location'] });
      setAddress(place.formattedAddress, place.location.lat(), place.location.lng());
    });
  } catch (err) {
    console.error(err);
    mapsReady = null;
    showAddressFallback();
  }
}

// Ohne Google Maps: einfaches Textfeld, die Dachfläche wird später manuell eingegeben.
function showAddressFallback() {
  $('#address-fallback').hidden = false;
  $('#use-location').hidden = true;
  $('#address-input').addEventListener('input', (e) => {
    state.address = { formatted: e.target.value.trim() };
    updateNextButton();
  });
}

function setAddress(formatted, lat, lng) {
  state.address = { formatted, lat, lng };
  state.solar = null;
  state.footprintAreaM2 = 0;
  const el = $('#selected-address');
  el.textContent = `✓ ${formatted}`;
  el.hidden = false;
  updateNextButton();
  loadSolarData(lat, lng); // im Hintergrund – Ergebnis ist im nächsten Schritt meist schon da
}

$('#use-location').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Ihr Browser unterstützt keine Standortabfrage.');
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      await mapsReady;
      const geocoder = new google.maps.Geocoder();
      const location = { lat: coords.latitude, lng: coords.longitude };
      try {
        const { results } = await geocoder.geocode({ location });
        setAddress(results[0]?.formatted_address ?? 'Aktueller Standort', location.lat, location.lng);
      } catch {
        setAddress('Aktueller Standort', location.lat, location.lng);
      }
    },
    () => alert('Standort konnte nicht ermittelt werden. Bitte geben Sie die Adresse ein.'),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

async function loadSolarData(lat, lng) {
  if (!state.config.solarEnabled) return;
  try {
    const res = await api(`/api/solar?lat=${lat}&lng=${lng}`);
    const data = await res.json();
    if (data.found && state.address?.lat === lat) {
      state.solar = data;
      if (STEPS[current].id === 'map') showSolarNotice();
    }
  } catch {
    /* Solar-Daten sind optional */
  }
}

// ---------------------------------------------------------------------------
// Schritt 2: Dach auf dem Satellitenbild einzeichnen
// ---------------------------------------------------------------------------

let map;
let polygon;
let mapCenterFor = null;

async function enterMap() {
  showSolarNotice();
  if (!mapsReady || state.address?.lat === undefined) {
    $('#map').hidden = true;
    $('#map-tools').hidden = true;
    $('#map-hint').hidden = true;
    $('#manual-area').hidden = false;
    return;
  }
  await mapsReady;
  const center = { lat: state.address.lat, lng: state.address.lng };

  if (!map) {
    map = new google.maps.Map($('#map'), {
      center,
      zoom: 20,
      mapTypeId: 'satellite',
      tilt: 0, // senkrechte Draufsicht, keine 45°-Schrägansicht
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy', // Ein-Finger-Bedienung auf dem Handy
      clickableIcons: false,
    });
    polygon = new google.maps.Polygon({
      map,
      editable: true,
      strokeColor: '#f6b400',
      strokeWeight: 3,
      fillColor: '#f6b400',
      fillOpacity: 0.35,
    });
    const path = polygon.getPath();
    ['insert_at', 'remove_at', 'set_at'].forEach((ev) => path.addListener(ev, updateArea));
    map.addListener('click', (e) => path.push(e.latLng));
    // Tippen innerhalb der Fläche fügt ebenfalls einen Punkt hinzu (aber nicht auf Eckpunkten).
    polygon.addListener('click', (e) => {
      if (e.vertex == null && e.edge == null) path.push(e.latLng);
    });
  }

  if (mapCenterFor !== state.address.formatted) {
    mapCenterFor = state.address.formatted;
    map.setCenter(center);
    map.setZoom(20);
    polygon.getPath().clear();
  }
}

function updateArea() {
  const path = polygon.getPath();
  state.footprintAreaM2 = path.getLength() >= 3 ? Math.round(google.maps.geometry.spherical.computeArea(path)) : 0;
  $('#map-area').textContent = `${fmt(state.footprintAreaM2)} m²`;
  updateNextButton();
}

$('#map-undo').addEventListener('click', () => polygon?.getPath().pop());
$('#map-reset').addEventListener('click', () => polygon?.getPath().clear());
$('#footprint-input').addEventListener('input', (e) => {
  state.footprintAreaM2 = Number(e.target.value) || 0;
  updateNextButton();
});
$('#use-solar').addEventListener('change', (e) => {
  state.useSolar = e.target.checked;
  updateNextButton();
});

function showSolarNotice() {
  const box = $('#solar-found');
  if (!state.solar) {
    box.hidden = true;
    return;
  }
  const area = state.solar.segments.reduce((s, x) => s + x.areaM2, 0);
  $('#solar-summary').textContent = `${state.solar.segments.length} Dachflächen mit zusammen ${fmt(area)} m². Sie müssen nichts einzeichnen.`;
  box.hidden = false;
  updateNextButton();
}

// ---------------------------------------------------------------------------
// Schritt 3: Foto + KI-Analyse
// ---------------------------------------------------------------------------

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const dataUrl = await resizeImage(file, 1568); // größere Bilder bringen der KI keinen Mehrwert
  const preview = $('#photo-preview');
  preview.src = dataUrl;
  preview.hidden = false;
  $('#photo-cta').hidden = true;
  $('#skip').hidden = true;
  track('pv_photo_taken');
  if (state.config.aiEnabled) analyzePhoto(dataUrl);
});

async function resizeImage(file, maxSize) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function analyzePhoto(dataUrl) {
  const status = $('#ai-status');
  status.hidden = false;
  status.className = 'ai-status loading';
  status.textContent = 'KI analysiert Ihr Dach …';
  $('#ai-result').hidden = true;
  $('#next').disabled = true;

  try {
    const res = await api('/api/analyze-photo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }),
    });
    const ai = await res.json();
    if (!res.ok) throw new Error(ai.error);

    if (!ai.isBuildingPhoto) {
      status.className = 'ai-status';
      status.textContent = 'Auf dem Foto ist kein Dach gut zu erkennen. Versuchen Sie es mit etwas mehr Abstand – oder fahren Sie einfach fort.';
      return;
    }
    state.ai = ai;
    if (ai.roofType) state.roofType = ai.roofType;
    if (ai.pitchDeg && ai.roofType !== 'flachdach') state.tiltDeg = Math.max(5, Math.min(60, ai.pitchDeg));
    state.obstructionLevel = ai.obstructionLevel;

    status.hidden = true;
    const box = $('#ai-result');
    box.innerHTML = `
      <strong>KI-Einschätzung</strong>
      <dl>
        <dt>Dachform</dt><dd>${esc(state.config.roofTypes[ai.roofType] ?? 'nicht eindeutig')}</dd>
        <dt>Neigung</dt><dd>ca. ${esc(ai.pitchDeg)}° <span class="small">(Sicherheit: ${esc(ai.pitchConfidence)})</span></dd>
        <dt>Eindeckung</dt><dd>${esc(ai.roofCovering || '–')}</dd>
        <dt>Hindernisse</dt><dd>${esc(ai.obstructions.join(', ') || 'keine erkannt')}</dd>
      </dl>
      <p>${esc(ai.customerMessage)}</p>
      <p class="small">Sie können die Werte im nächsten Schritt anpassen.</p>`;
    box.hidden = false;
    track('pv_ai_analyzed', { roofType: ai.roofType });
  } catch (err) {
    status.className = 'ai-status';
    status.textContent = `${err.message || 'Analyse nicht möglich'} – Sie können trotzdem fortfahren.`;
  } finally {
    updateNextButton();
  }
}

// ---------------------------------------------------------------------------
// Schritt 4: Dachform, Neigung, Ausrichtung
// ---------------------------------------------------------------------------

const ROOF_ICONS = {
  satteldach: '<path d="M4 30 L24 10 L44 30" /><path d="M8 30 V40 H40 V30" />',
  pultdach: '<path d="M4 22 L44 12" /><path d="M8 21 V40 H40 V13" />',
  walmdach: '<path d="M4 30 L16 14 H32 L44 30 Z" /><path d="M8 30 V40 H40 V30" />',
  flachdach: '<path d="M4 18 H44" /><path d="M8 18 V40 H40 V18" />',
};
const DIRECTIONS = [
  ['N', 0], ['NO', 45], ['O', 90], ['SO', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

function enterRoof() {
  const usingSolar = state.useSolar && state.solar;
  $('#roof-from-solar').hidden = !usingSolar;
  $('#roof-manual').hidden = Boolean(usingSolar);

  if (usingSolar) {
    $('#segment-list').innerHTML = state.solar.segments
      .map((s) => `<li><span>${esc(directionName(s.azimuthDeg))}</span><span>${fmt(s.areaM2)} m² · ${fmt(s.tiltDeg)}°</span></li>`)
      .join('');
    return;
  }
  renderRoofTypes();
  renderCompass();
  $('#tilt-input').value = state.tiltDeg;
  $('#tilt-value').textContent = `${state.tiltDeg}°`;
  $('#tilt-ai').hidden = !state.ai?.pitchDeg;
  $('#tilt-field').hidden = state.roofType === 'flachdach';
}

function renderRoofTypes() {
  $('#roof-types').innerHTML = Object.entries(state.config.roofTypes)
    .map(
      ([key, label]) => `
      <button type="button" class="choice" data-roof="${key}" aria-pressed="${key === state.roofType}">
        <svg width="48" height="44" viewBox="0 0 48 44" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round">${ROOF_ICONS[key]}</svg>
        ${esc(label)}
      </button>`,
    )
    .join('');
}

$('#roof-types').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-roof]');
  if (!btn) return;
  state.roofType = btn.dataset.roof;
  enterRoof();
});

$('#tilt-input').addEventListener('input', (e) => {
  state.tiltDeg = Number(e.target.value);
  $('#tilt-value').textContent = `${state.tiltDeg}°`;
  $('#tilt-ai').hidden = true;
});

function renderCompass() {
  $('#compass').innerHTML = DIRECTIONS.map(([label, az]) => {
    const rad = (az * Math.PI) / 180;
    const x = 50 + 38 * Math.sin(rad);
    const y = 50 - 38 * Math.cos(rad);
    return `<button type="button" class="choice" data-az="${az}" style="left:${x}%;top:${y}%" aria-pressed="${az === state.azimuthDeg}" aria-label="${directionName(az)}">${label}</button>`;
  }).join('');
}

$('#compass').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-az]');
  if (!btn) return;
  state.azimuthDeg = Number(btn.dataset.az);
  renderCompass();
});

function directionName(az) {
  const names = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];
  return names[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}

// Handy-Kompass: iOS liefert webkitCompassHeading, Android das Ereignis "deviceorientationabsolute".
let compassHandler = null;
$('#use-compass').addEventListener('click', async () => {
  const btn = $('#use-compass');
  if (compassHandler) return stopCompass();
  try {
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
    }
  } catch {
    return;
  }
  compassHandler = (e) => {
    const heading = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (heading == null) return;
    state.azimuthDeg = (Math.round(heading / 45) * 45) % 360;
    renderCompass();
  };
  window.addEventListener('deviceorientationabsolute', compassHandler);
  window.addEventListener('deviceorientation', compassHandler);
  $('#compass-help').hidden = false;
  btn.textContent = '✓ Richtung übernehmen';
});

function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', compassHandler);
  window.removeEventListener('deviceorientation', compassHandler);
  compassHandler = null;
  $('#compass-help').hidden = true;
  $('#use-compass').textContent = '🧭 Mit Handy-Kompass bestimmen';
}

// ---------------------------------------------------------------------------
// Schritt 5: Verbrauch
// ---------------------------------------------------------------------------

$('#persons').innerHTML = [1, 2, 3, 4, 5]
  .map((p) => `<button type="button" class="choice" data-persons="${p}" aria-pressed="${p === state.persons}">${p}${p === 5 ? '+' : ''}</button>`)
  .join('');
$('#persons').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-persons]');
  if (!btn) return;
  state.persons = Number(btn.dataset.persons);
  document.querySelectorAll('[data-persons]').forEach((b) => b.setAttribute('aria-pressed', b === btn));
});
$('#consumption-input').addEventListener('input', (e) => (state.annualConsumptionKwh = Number(e.target.value) || 0));
$('#opt-storage').addEventListener('change', (e) => (state.storage = e.target.checked));
$('#opt-wallbox').addEventListener('change', (e) => (state.wallbox = e.target.checked));
$('#opt-heatpump').addEventListener('change', (e) => (state.heatPump = e.target.checked));

function roofInput() {
  const usingSolar = state.useSolar && state.solar;
  return {
    roofType: state.roofType,
    footprintAreaM2: state.footprintAreaM2,
    tiltDeg: state.tiltDeg,
    azimuthDeg: state.azimuthDeg,
    obstructionLevel: state.obstructionLevel,
    segments: usingSolar ? state.solar.segments : undefined,
    persons: state.persons,
    annualConsumptionKwh: state.annualConsumptionKwh,
    storage: state.storage,
    wallbox: state.wallbox,
    heatPump: state.heatPump,
  };
}

async function calculate() {
  stopCompass();
  const res = await api('/api/calculate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(roofInput()),
  });
  if (!res.ok) {
    alert('Berechnung fehlgeschlagen. Bitte versuchen Sie es erneut.');
    return false;
  }
  state.result = await res.json();
  track('pv_calculated', { kwp: state.result.kwp });
}

// ---------------------------------------------------------------------------
// Schritt 6: Ergebnis-Vorschau + Kontaktformular (Lead)
// ---------------------------------------------------------------------------

function renderTeaser() {
  const r = state.result;
  $('#teaser').innerHTML = `
    <span class="rating">${esc(r.rating.label)}</span>
    <div class="kpis">
      <div class="kpi"><b>${fmt(r.kwp, 1)} kWp</b>Anlagengröße</div>
      <div class="kpi"><b>${fmt(r.yieldKwh)} kWh</b>Strom pro Jahr</div>
      <div class="kpi locked"><b>0.000 €</b>Ersparnis pro Jahr</div>
      <div class="kpi locked"><b>00 Jahre</b>Amortisation</div>
    </div>`;
}

async function submitLead() {
  const form = $('#lead-form');
  const data = new FormData(form);
  const errorBox = $('#form-error');
  errorBox.hidden = true;

  if (!form.reportValidity()) return false;

  const res = await api('/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contact: {
        name: data.get('name'),
        email: data.get('email'),
        phone: data.get('phone'),
        ownership: data.get('ownership'),
        timeline: data.get('timeline'),
        callbackWanted: data.get('callbackWanted') === 'on',
      },
      consent: data.get('consent') === 'on',
      consentText: $('#consent-text').textContent.trim(),
      website: data.get('website'),
      address: state.address,
      roof: roofInput(),
      aiAnalysis: state.ai,
      utm: utmParams(),
      referrer: document.referrer,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    errorBox.textContent = body.error || 'Senden fehlgeschlagen. Bitte versuchen Sie es erneut.';
    errorBox.hidden = false;
    return false;
  }
  if (body.result) state.result = body.result;
  // Conversion für Google Ads / Analytics (siehe track()).
  track('pv_lead_submitted', { kwp: state.result.kwp });
}

function utmParams() {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, p.get(`utm_${k}`) || '']));
}

// ---------------------------------------------------------------------------
// Schritt 7: Vollständiges Ergebnis
// ---------------------------------------------------------------------------

function renderFullResult() {
  const r = state.result;
  const faces = r.faces
    .map((f) => `<li class="${f.used ? '' : 'unused'}"><span>${esc(f.direction)} · ${fmt(f.tiltDeg)}°</span><span>${f.used ? `${f.modules} Module · ${fmt(f.yieldKwh)} kWh` : 'nicht belegt'}</span></li>`)
    .join('');
  $('#full-result').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${fmt(r.kwp, 1)} kWp</b>${r.modules} Module</div>
      <div class="kpi"><b>${fmt(r.yieldKwh)} kWh</b>Ertrag pro Jahr</div>
      <div class="kpi"><b>${eur(r.savingsPerYearEur)}</b>Ersparnis pro Jahr</div>
      <div class="kpi"><b>${r.paybackYears != null ? fmt(r.paybackYears, 1) : '–'} Jahre</b>Amortisation</div>
      <div class="kpi"><b>${eur(r.investmentEur)}</b>Investition (ca.)</div>
      <div class="kpi"><b>${r.autarkyPercent} %</b>Unabhängigkeit</div>
    </div>
    <div class="card">
      <strong>Ihre Dachflächen</strong>
      <ul class="segments">${faces}</ul>
      <dl>
        <dt>Dachform</dt><dd>${esc(r.roofTypeLabel)}</dd>
        ${r.storageKwh ? `<dt>Speicher</dt><dd>${r.storageKwh} kWh empfohlen</dd>` : ''}
        <dt>Gewinn in 25 Jahren</dt><dd>ca. ${eur(r.profit25YearsEur)}</dd>
        <dt>CO₂-Einsparung</dt><dd>${fmt(r.co2SavedKgPerYear / 1000, 1)} t pro Jahr</dd>
      </dl>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tracking: Google Tag Manager (dataLayer) + Nachricht an die Elternseite (iframe-Einbettung)
// ---------------------------------------------------------------------------

function track(event, data = {}) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event, ...data });
  if (window.parent !== window) window.parent.postMessage({ type: 'pv-dachcheck', event, ...data }, '*');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init() {
  state.config = await (await api('/api/config')).json();
  if (state.config.company?.name) $('#brand').textContent = `${state.config.company.name} · Solar-Check`;
  if (state.config.company?.privacyUrl) $('#privacy-link').href = state.config.company.privacyUrl;
  if (state.config.mapsKey) {
    mapsReady = loadGoogleMaps(state.config.mapsKey);
    mapsReady.catch((err) => console.error(err)); // Fehler wird in enterAddress() behandelt
  }
  // Ohne KI-Schlüssel entfällt der Foto-Schritt (das Foto wird nirgends gespeichert).
  if (!state.config.aiEnabled) STEPS.splice(STEPS.findIndex((s) => s.id === 'photo'), 1);

  $('#next').addEventListener('click', onNext);
  $('#skip').addEventListener('click', () => goTo(current + 1));
  $('#back').addEventListener('click', () => history.back());
  history.replaceState({ step: 0 }, '', '#start');
  // Offline-Fähigkeit + „Zum Startbildschirm hinzufügen“ (PWA). In einer echten App nicht nötig.
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  goTo(0, { push: false });
}

init();
