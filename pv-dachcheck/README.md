# PV-Dachcheck – Solar-Lead-App

Mobile Web-App (sieht aus wie eine App, ist aber eine normale Unterseite), mit der Interessenten
in ca. 2 Minuten sehen, was ihr Dach für Photovoltaik hergibt – und dabei ihre Kontaktdaten als Lead hinterlassen.

```
Website / SEO / Werbung
        │
        ▼
 ┌─────────────── Solar-Dachcheck (diese App) ───────────────┐
 │ 1. Adresse       Google Places Autocomplete / GPS          │
 │ 2. Dach          Satellitenbild: Dachecken antippen → m²   │
 │                  Google Solar API: echte Dachflächen       │
 │ 3. Foto          Handykamera → KI (Claude) schätzt         │
 │                  Dachform, Neigung, Hindernisse            │
 │ 4. Details       Dachform, Neigung, Ausrichtung (Kompass)  │
 │ 5. Verbrauch     Personen/kWh, Speicher, Wallbox, WP       │
 │ 6. Vorschau      kWp + kWh sichtbar, € verschwommen        │
 │    + Kontakt     Name, E-Mail, Telefon, Einwilligung       │
 │ 7. Ergebnis      volle Wirtschaftlichkeitsrechnung         │
 └────────────────────────────────────────────────────────────┘
        │
        ├─► E-Mail an Interessenten (Auswertung)
        ├─► E-Mail an Vertrieb (Lead-Klasse A/B/C)
        ├─► optional Webhook → CRM / n8n / Zapier
        └─► Vertriebs-Dashboard /admin.html (Lead-Pipeline)
```

## Schnellstart

```bash
cd pv-dachcheck
npm install
cp .env.example .env      # Schlüssel eintragen (alles optional für den Demo-Modus)
npm run dev               # http://localhost:3000
npm test                  # Tests für Rechenkern, Scoring und API
```

**Demo-Modus:** Ohne Schlüssel läuft die App trotzdem – Adresse als Textfeld, Dachfläche wird
manuell eingegeben, der Foto-Schritt entfällt, E-Mails werden nur in der Konsole ausgegeben.

## Dienste & Schlüssel

| Funktion | Dienst | Variable | Hinweis |
|---|---|---|---|
| Adresssuche, Satellitenkarte | Maps JavaScript API, **Places API (New)**, Geocoding API | `GOOGLE_MAPS_BROWSER_KEY` | Schlüssel ist im Browser sichtbar → **HTTP-Referrer-Beschränkung** setzen |
| Echte Dachflächen (Neigung, Ausrichtung, m²) | **Google Solar API** | `GOOGLE_SOLAR_SERVER_KEY` | Nur serverseitig. Abdeckung in DE vor allem in Städten; ohne Treffer greift die manuelle Eingabe |
| KI-Fotoanalyse | Anthropic Claude (Vision) | `ANTHROPIC_API_KEY` | Max. 5 Analysen / 10 Min. pro IP; Foto wird nicht gespeichert |
| E-Mails | beliebiger SMTP-Server | `SMTP_*` | z. B. Microsoft 365, Strato, Mailjet, Brevo |
| Dashboard | – | `ADMIN_TOKEN` | Langes Zufallspasswort |

Die KI-Anfrage nutzt `fallbacks: "default"`: Lehnt das Modell eine Anfrage ab, beantwortet
automatisch ein anderes Claude-Modell dieselbe Anfrage.

## Einbindung in die Website (Enfold / WordPress)

Variante A – **eigene Unterseite** (empfohlen für Werbung): App unter z. B. `https://solar.example.de`
betreiben und aus Anzeigen / Buttons direkt dorthin verlinken.

Variante B – **iframe in einer Enfold-Seite**: Element „Text-Block“ oder „Code-Block“ einfügen:

```html
<iframe id="pv-dachcheck" src="https://solar.example.de/"
        style="width:100%;height:820px;border:0;border-radius:16px"
        allow="geolocation; camera; accelerometer; gyroscope; magnetometer"
        title="Solar-Dachcheck"></iframe>
<script>
  // UTM-Parameter der Seite (Google Ads, Facebook …) an die App weiterreichen
  (function () {
    var f = document.getElementById('pv-dachcheck');
    if (location.search) f.src = f.src + location.search;
    // Conversion-Tracking: die App meldet jeden Schritt per postMessage
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'pv-dachcheck') {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: e.data.event, kwp: e.data.kwp });
      }
    });
  })();
</script>
```

In `.env` dann `ALLOWED_FRAME_ANCESTORS=https://www.eure-domain.de` setzen.
Das Event `pv_lead_submitted` im Google Tag Manager als Conversion für Google Ads / Meta verwenden.

## Lead-Scoring (A/B/C)

`server/lead-scoring.js` vergibt bis zu 100 Punkte:

* **Dach (max. 45):** mögliche kWp, Ausrichtungsfaktor
* **Kunde (max. 55):** Eigentümer/Mieter, Zeitrahmen, Interesse an Speicher/Wallbox/Wärmepumpe, Telefonnummer, Rückrufwunsch

A ≥ 70 (sofort anrufen) · B ≥ 45 · C darunter. Die Gewichte sind Startwerte – nach einigen Wochen
mit den echten Abschlüssen abgleichen und anpassen.

## Wie gerechnet wird

`server/pv-calculator.js` (reine Funktionen, siehe Tests):

1. **Dachfläche:** Google Solar API liefert echte Flächen. Sonst: eingezeichnete Fläche ist die
   *Draufsicht* → echte Dachfläche = Draufsicht / cos(Neigung). Satteldach = 2 Flächen, Walmdach = 4.
2. **Belegung:** 70 % nutzbar (Flachdach 55 %), minus Abzug für Hindernisse aus der KI-Analyse.
   Flächen mit Ertragsfaktor < 0,7 (z. B. Nordseite) werden nicht belegt.
3. **Ertrag:** kWp × 950 kWh/kWp × Ausrichtungsfaktor (Tabelle Neigung × Himmelsrichtung).
4. **Wirtschaftlichkeit:** Eigenverbrauch ~30 % (mit Speicher ~65 %) des Verbrauchs, Rest Einspeisung.
   Preise in `.env` anpassbar.

Das ist bewusst eine **Schätzung** für die Erstberatung, keine Anlagenplanung.

## Projektstruktur

```
pv-dachcheck/
├── server/
│   ├── index.js          HTTP-Server, API-Routen, Eingabeprüfung
│   ├── config.js         alle Einstellungen aus .env
│   ├── pv-calculator.js  Rechenkern
│   ├── lead-scoring.js   A/B/C-Bewertung
│   ├── lead-store.js     Speicherung (JSON-Datei, data/leads.json)
│   ├── mailer.js         Kunden- und Vertriebs-E-Mail
│   ├── google-solar.js   Google Solar API
│   ├── roof-ai.js        KI-Fotoanalyse (Claude)
│   └── rate-limit.js     Schutz vor Missbrauch
├── public/
│   ├── index.html / app.js / styles.css   die App
│   └── admin.html        Vertriebs-Dashboard
└── test/                 node --test
```

## Datenschutz & Recht – vor dem Livegang klären

* Datenschutzerklärung ergänzen: Google Maps/Places/Solar, Anthropic (KI-Fotoanalyse), E-Mail-Versand,
  Speicherdauer der Leads. Einwilligungstext steht in `public/index.html` und wird mit jedem Lead gespeichert.
* Google Maps lädt erst im Adress-Schritt – ggf. trotzdem in das Cookie-Banner aufnehmen.
* AV-Verträge mit Hosting, SMTP-Anbieter und Anthropic abschließen.
* Optional Double-Opt-In für die E-Mail, falls später Newsletter verschickt werden sollen.

## Nächste Ausbaustufen

* Solar API `dataLayers` (Sonneneinstrahlung als Heatmap auf dem Dach) anzeigen
* PDF-Angebot automatisch an die E-Mail anhängen
* Lead-Speicher durch CRM (HubSpot, Pipedrive …) oder Datenbank ersetzen
* Terminbuchung (z. B. Calendly) direkt auf der Ergebnisseite
