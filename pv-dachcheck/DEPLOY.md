# Installation: Subdomain bei All-Inkl → App auf eigenem Server

```
Besucher ──► solar.eure-domain.de ──(DNS bei All-Inkl)──► Hetzner-Server
                                                          ├─ Caddy (HTTPS)
                                                          └─ Node.js-App (diese App)
Website www.eure-domain.de bleibt unverändert bei All-Inkl.
```

Voraussetzung: Der Code ist im `main`-Branch des Repositorys (Pull Request gemergt).

Dauer: ca. 30 Minuten. Kosten: ca. 4–6 € / Monat.

## 1. Server mieten (Hetzner Cloud)

1. Auf <https://console.hetzner.cloud> ein Projekt anlegen → **Server hinzufügen**
2. Standort **Falkenstein oder Nürnberg** (Deutschland), Image **Ubuntu 24.04**, Typ **CX22** (kleinster reicht)
3. SSH-Schlüssel hinterlegen (oder Root-Passwort per E-Mail), Server erstellen
4. Die **IPv4-Adresse** notieren, z. B. `203.0.113.10`

## 2. Subdomain bei All-Inkl auf den Server zeigen lassen

1. KAS (<https://kas.all-inkl.com>) → **Tools → DNS-Einstellungen** → Domain auswählen → **bearbeiten**
2. Neuer Eintrag: Name `solar`, Typ **A**, Daten = IPv4-Adresse des Servers
3. Speichern. Es kann bis zu ~1 Stunde dauern, bis die Subdomain weltweit erreichbar ist.

> Die Subdomain **nicht** zusätzlich unter „Subdomains“ im KAS anlegen – dann würde All-Inkl sie selbst beantworten.

## 3. Server einrichten (einmalig)

Per SSH einloggen (`ssh root@203.0.113.10`) und nacheinander ausführen:

```bash
# Updates + Firewall (nur SSH und Web erlaubt)
apt update && apt upgrade -y
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Node.js 22 und Caddy installieren
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git caddy

# Eigener Benutzer für die App (läuft nicht als root)
useradd --system --create-home --home-dir /opt/pv-dachcheck pvapp

# Code holen
sudo -u pvapp git clone https://github.com/ip2C/Enfold-Feature-Requests.git /opt/pv-dachcheck
cd /opt/pv-dachcheck/pv-dachcheck
sudo -u pvapp npm ci --omit=dev

# Einstellungen anlegen und ausfüllen (Schlüssel, SMTP, Admin-Token …)
sudo -u pvapp cp .env.example .env
nano .env
chmod 600 .env && chown pvapp .env

# Dienst + HTTPS einrichten
cp deploy/pv-dachcheck.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pv-dachcheck
cp deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile          # solar.example.de → eure Subdomain
systemctl reload caddy
```

> Das Repository ist privat? Dann beim `git clone` einen GitHub-Deploy-Key oder ein Token verwenden.

Fertig: <https://solar.eure-domain.de> öffnen. Dashboard: `/admin.html`.

**Prüfen, ob alles läuft:** `systemctl status pv-dachcheck` · Logs: `journalctl -u pv-dachcheck -f`

## 4. Updates einspielen

```bash
cd /opt/pv-dachcheck && sudo -u pvapp git pull
cd pv-dachcheck && sudo -u pvapp npm ci --omit=dev
systemctl restart pv-dachcheck
```

## 5. Backup der Leads

Die Leads liegen in `data/leads.json`. Im Hetzner-Panel **Backups** aktivieren (+20 % Serverpreis)
oder die Datei regelmäßig sichern, z. B. täglich per Cron:

```bash
echo '0 3 * * * root cp /opt/pv-dachcheck/pv-dachcheck/data/leads.json /root/leads-$(date +\%F).json' > /etc/cron.d/pv-backup
```

## E-Mail über All-Inkl versenden

Im KAS ein Postfach anlegen (z. B. `solar@eure-domain.de`) und in `.env` eintragen:

```
SMTP_HOST=w0xxxxxx.kasserver.com     # steht im KAS beim Postfach
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=solar@eure-domain.de       # bzw. der Postfach-Login (m0xxxxxx)
SMTP_PASS=…
MAIL_FROM="Eure Firma Solar <solar@eure-domain.de>"
```

## Später: echte App für iOS / Android

Die App ist dafür vorbereitet:

* **Oberfläche** (`public/`) ist reines HTML/CSS/JavaScript → kann mit [Capacitor](https://capacitorjs.com)
  ohne Neuentwicklung als iOS- und Android-App verpackt werden.
* **Server** bleibt derselbe und bedient Website und App gleichzeitig. In der App-Version in
  `index.html` die Server-Adresse eintragen: `<meta name="pv-api-base" content="https://solar.eure-domain.de">`
  und in `.env` freigeben: `APP_ORIGINS=capacitor://localhost https://localhost`.
* Für die App braucht Google Maps eigene, auf die App beschränkte Schlüssel (Android/iOS).
* Bis dahin ist die Seite schon eine **PWA**: Kunden können sie über „Zum Startbildschirm hinzufügen“
  wie eine App auf dem Handy ablegen.
