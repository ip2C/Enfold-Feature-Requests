// Automatische E-Mails: Bestätigung an den Interessenten + Benachrichtigung an den Vertrieb.
// Ohne SMTP-Zugang (lokale Entwicklung) werden die Mails nur in der Konsole ausgegeben.

import nodemailer from 'nodemailer';

const eur = (v) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
const num = (v, d = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d }).format(v);

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function createMailer(mailConfig, company) {
  const transport = mailConfig.host
    ? nodemailer.createTransport({
        host: mailConfig.host,
        port: mailConfig.port,
        secure: mailConfig.secure,
        auth: mailConfig.user ? { user: mailConfig.user, pass: mailConfig.pass } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });

  async function send(message) {
    const info = await transport.sendMail({ from: mailConfig.from, ...message });
    if (!mailConfig.host) console.log('[mail:dev] nicht versendet (kein SMTP_HOST):', message.to, '–', message.subject);
    return info;
  }

  return {
    sendCustomerConfirmation(lead) {
      const r = lead.result;
      const html = `
        <p>Hallo ${escapeHtml(lead.contact.name)},</p>
        <p>vielen Dank für Ihren Dach-Check! Hier ist Ihre erste Einschätzung für
        <strong>${escapeHtml(lead.address?.formatted || 'Ihr Gebäude')}</strong>:</p>
        <table cellpadding="6" style="border-collapse:collapse">
          <tr><td>Bewertung</td><td><strong>${escapeHtml(r.rating.label)}</strong></td></tr>
          <tr><td>Mögliche Anlagengröße</td><td><strong>${num(r.kwp, 1)} kWp</strong> (${r.modules} Module)</td></tr>
          <tr><td>Erwarteter Jahresertrag</td><td>${num(r.yieldKwh)} kWh</td></tr>
          <tr><td>Ersparnis pro Jahr</td><td>ca. ${eur(r.savingsPerYearEur)}</td></tr>
          <tr><td>Investition (Schätzung)</td><td>ca. ${eur(r.investmentEur)}</td></tr>
          <tr><td>Amortisation</td><td>ca. ${r.paybackYears != null ? num(r.paybackYears, 1) : '–'} Jahre</td></tr>
          <tr><td>CO₂-Einsparung</td><td>${num(r.co2SavedKgPerYear / 1000, 1)} t pro Jahr</td></tr>
        </table>
        <p>Diese Werte sind eine unverbindliche Schätzung auf Basis Ihrer Angaben.
        Eine Fachberaterin bzw. ein Fachberater von ${escapeHtml(company.name)} meldet sich in Kürze bei Ihnen,
        um die Details zu prüfen und ein genaues Angebot zu erstellen.</p>
        <p>Viele Grüße<br>${escapeHtml(company.name)}${company.phone ? `<br>Tel. ${escapeHtml(company.phone)}` : ''}</p>`;
      return send({
        to: lead.contact.email,
        replyTo: company.email || undefined,
        subject: `Ihr PV-Dach-Check: ${num(r.kwp, 1)} kWp möglich`,
        html,
      });
    },

    sendSalesNotification(lead, adminUrl) {
      if (!mailConfig.salesTo) return null;
      const { contact, result: r, score } = lead;
      const html = `
        <h2>Neuer Lead – Klasse ${score.grade} (${score.score}/100)</h2>
        <p><strong>${escapeHtml(contact.name)}</strong><br>
        Tel.: <a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a><br>
        E-Mail: <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a><br>
        Adresse: ${escapeHtml(lead.address?.formatted || '–')}</p>
        <p>${num(r.kwp, 1)} kWp · ${num(r.yieldKwh)} kWh/a · ${escapeHtml(r.roofTypeLabel)} · ${escapeHtml(r.rating.label)}</p>
        <ul>${score.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
        ${lead.aiAnalysis?.salesNotes ? `<p><em>KI-Hinweis:</em> ${escapeHtml(lead.aiAnalysis.salesNotes)}</p>` : ''}
        <p><a href="${escapeHtml(adminUrl)}">Lead im Dashboard öffnen</a></p>`;
      return send({
        to: mailConfig.salesTo,
        subject: `[PV-Lead ${score.grade}] ${contact.name} – ${num(r.kwp, 1)} kWp`,
        html,
      });
    },
  };
}
