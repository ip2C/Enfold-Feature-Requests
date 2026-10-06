// Zentrale Konfiguration. Alle Werte kommen aus Umgebungsvariablen (.env),
// damit Schlüssel und Preise ohne Code-Änderung angepasst werden können.

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== '' ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  company: {
    name: process.env.COMPANY_NAME || 'Ihr Solarteam',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || '',
    privacyUrl: process.env.PRIVACY_URL || '/datenschutz',
  },

  google: {
    // Browser-Schlüssel (Maps JavaScript API + Places API (New)).
    // Unbedingt in der Google Cloud Console auf die eigene Domain (HTTP-Referrer) beschränken!
    mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
    // Server-Schlüssel für die Solar API – wird nie an den Browser ausgeliefert.
    solarServerKey: process.env.GOOGLE_SOLAR_SERVER_KEY || '',
  },

  anthropic: {
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'PV-Dachcheck <noreply@example.com>',
    // Wer intern über neue Leads informiert wird (Komma-getrennt).
    salesTo: process.env.SALES_NOTIFY_TO || '',
  },

  admin: {
    token: process.env.ADMIN_TOKEN || '',
  },

  // Optional: jeden neuen Lead zusätzlich an ein CRM / n8n / Zapier schicken.
  leadWebhookUrl: process.env.LEAD_WEBHOOK_URL || '',

  dataDir: process.env.DATA_DIR || new URL('../data/', import.meta.url).pathname,

  // Annahmen für die Wirtschaftlichkeitsrechnung (Deutschland, Stand 2026).
  // Bitte regelmäßig an eure tatsächlichen Preise anpassen.
  pv: {
    moduleWp: num(process.env.PV_MODULE_WP, 440),
    moduleAreaM2: num(process.env.PV_MODULE_AREA_M2, 1.95),
    specificYieldKwhPerKwp: num(process.env.PV_SPECIFIC_YIELD, 950), // Süd, 30–35°, Mitteldeutschland
    electricityPriceEur: num(process.env.PV_ELECTRICITY_PRICE, 0.35),
    feedInTariffEur: num(process.env.PV_FEED_IN_TARIFF, 0.078),
    costPerKwpSmallEur: num(process.env.PV_COST_PER_KWP_SMALL, 1500), // bis 10 kWp
    costPerKwpLargeEur: num(process.env.PV_COST_PER_KWP_LARGE, 1300), // über 10 kWp
    storageCostPerKwhEur: num(process.env.PV_STORAGE_COST_PER_KWH, 650),
    co2KgPerKwh: num(process.env.PV_CO2_KG_PER_KWH, 0.38),
    degradationPerYear: 0.005,
    lifetimeYears: 25,
  },
};
