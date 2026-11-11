# Crosspost – live schalten und Konten verbinden

Die App besteht aus zwei Teilen:

| Teil | Wo er läuft | Wofür |
|---|---|---|
| **Website** (dieser Ordner) | GitHub Pages (kostenlos) | Alles, was du siehst und bedienst |
| **Server** (`server/`) | Cloudflare Workers (kostenloser Tarif reicht zum Start) | Hält die geheimen App-Schlüssel, tauscht Anmelde-Codes, lädt Videos zu Facebook, Instagram und TikTok |

Warum ein Server? Facebook, Instagram und TikTok geben ein „App Secret“ aus. Das darf **nie** auf einer öffentlichen Website liegen. YouTube und Snapchat funktionieren auch ohne Server.

---

## 1. Website auf GitHub bringen

1. Auf github.com ein neues Repository anlegen (z. B. `crosspost`).
2. Den **Inhalt dieses Ordners** (`app/`) hochladen – nicht den Ordner `node_modules` und nicht `dist`.
   Am einfachsten mit GitHub Desktop: „Add existing repository“ → diesen Ordner wählen → „Publish repository“.
3. Im Repository: **Settings → Pages → Source: „GitHub Actions“**.
4. Jeder Push auf `main` baut die Seite neu. Nach 1–2 Minuten ist sie unter
   `https://DEIN-NAME.github.io/crosspost/` erreichbar (Tab „Actions“ zeigt den Fortschritt).

Die **Redirect-URI** für alle Plattformen ist dann:

```
https://DEIN-NAME.github.io/crosspost/oauth/callback/
```

(Die App zeigt sie dir auch unter *Settings → Integrations* zum Kopieren an.)

## 2. Server einrichten (Cloudflare)

1. Kostenloses Konto auf cloudflare.com anlegen, dann im Terminal im Ordner `server/`:
   ```
   npx wrangler login
   npx wrangler r2 bucket create crosspost-media
   ```
2. In `server/wrangler.toml` bei `ALLOWED_ORIGIN` deine GitHub-Adresse eintragen (`https://DEIN-NAME.github.io`).
3. Geheimnisse eintragen (jeweils fragt das Terminal nach dem Wert):
   ```
   npx wrangler secret put FACEBOOK_APP_ID
   npx wrangler secret put FACEBOOK_APP_SECRET
   npx wrangler secret put TIKTOK_CLIENT_KEY
   npx wrangler secret put TIKTOK_CLIENT_SECRET
   npx wrangler secret put SNAPCHAT_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
4. Datenbank für die Workflows anlegen und den Schlüssel, der die gespeicherten Anmeldungen verschlüsselt:
   ```
   npx wrangler d1 create crosspost          # die ausgegebene database_id in wrangler.toml eintragen
   npx wrangler d1 migrations apply crosspost --remote
   openssl rand -base64 32 | npx wrangler secret put TOKEN_KEY
   ```
   In `wrangler.toml` bei `PUBLIC_URL` die Server-Adresse eintragen (siehe Schritt 5).
5. `npx wrangler deploy` – die angezeigte Adresse (z. B. `https://crosspost-api.DEIN-NAME.workers.dev`) ist deine **Server-Adresse**.
6. Optional: im R2-Bucket eine Lebenszyklus-Regel „Objekte nach 1 Tag löschen“ anlegen, damit hochgeladene Videos nicht liegen bleiben.

### Workflows auf dem Server
Workflows mit einer **Instagram-Quelle** laufen auf dem Server (`server/workflows.js`), auch wenn die Seite zu ist:
- Alle 5 Minuten (Cron in `wrangler.toml`) schaut der Server nach neuen Reels/Videos, die nach dem Einschalten des Workflows gepostet wurden.
- Jedes neue Video wird einmal nach R2 kopiert und dann an jedes Ziel geschickt: YouTube (Upload), TikTok und Instagram (holen es von `PUBLIC_URL/media/…`), Facebook-Seite.
- „Run now“ nimmt das neueste noch nicht verarbeitete Video, auch ein älteres – gut zum Testen.
- Die Seite übergibt Workflow und die nötigen Anmeldungen (`PUT /api/sync`); der Server speichert sie mit `TOKEN_KEY` verschlüsselt und erneuert abgelaufene Zugänge selbst.
- Anmeldung am Server: Ein verbundenes Konto (Instagram, YouTube, TikTok oder Facebook) beweist, wer man ist. Uploads (`PUT /media`) gehen nur noch mit dieser Sitzung.

## 3. Entwickler-Apps bei den Plattformen anlegen

Überall gilt: als Redirect-/Callback-URL genau die Adresse aus Schritt 1 eintragen.

### Instagram (Unified Login)
Instagram läuft über **eine** Meta-App, dieselbe wie Facebook. Ein eigenes „Instagram Login“ bietet Meta neuen Apps nicht mehr an.
- developers.facebook.com → **App erstellen** → Anwendungsfall „Messaging und Content auf Instagram verwalten“, Business-Portfolio verknüpfen.
- **Facebook Login for Business → Konfigurationen** → Konfiguration „Instagram API (Unified Login)“ anlegen. Tokentyp: Systemnutzer-Token (läuft nicht ab).
  Berechtigungen: `instagram_basic`, `instagram_content_publish` (Meta verlangt zusätzlich `instagram_manage_messages`).
- Die **Konfigurations-ID** (`config_id`) ist öffentlich: in der App unter *Settings → Integrations* („Instagram configuration ID“) oder als GitHub-Variable `VITE_META_CONFIG_ID`.
- Redirect-URI eintragen unter *Facebook Login for Business → Gültige OAuth-Redirect-URIs*.
- Beim Verbinden wählt man das Instagram-Konto direkt aus. Der Server holt es über `/me/assigned_instagram_accounts`, eine Facebook-Seite ist **nicht** nötig. Alle Aufrufe gehen an `graph.facebook.com`.
- Voraussetzung: Instagram-**Business- oder Creator-Konto** (professionelles Konto).

### Facebook (Seiten)
- Braucht in derselben Meta-App den zusätzlichen Anwendungsfall „Alles auf deiner Seite verwalten“.
- Berechtigungen: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Voraussetzung: eine **Seite**, die du verwaltest.

### Für Facebook und Instagram gilt
- Solange die App im Entwicklungsmodus ist, funktioniert sie nur für Personen, die du als Tester/Admin einträgst. Für alle anderen braucht es die **App-Prüfung (App Review)** und eine Unternehmensverifizierung. Die Datenschutzseite der App (`/privacy/`) erklärt das Löschen der Daten – diese Adresse wird bei der Prüfung verlangt.

### TikTok
- developers.tiktok.com → **App erstellen** → Produkte **Login Kit** und **Content Posting API** (mit „Direct Post“).
- Scopes: `user.info.basic`, `video.publish`. Redirect-URI eintragen.
- Videos holt TikTok von deinem Server ab („PULL_FROM_URL“). Dafür die Server-Adresse unter „URL properties“ verifizieren: TikTok gibt eine Datei vor – Name und Inhalt in `wrangler.toml` bei `TIKTOK_VERIFICATION_FILENAME` / `TIKTOK_VERIFICATION_CONTENT` eintragen und neu deployen.
- **Wichtig:** Bis TikTok die App geprüft hat (Audit), sind alle Posts nur privat sichtbar (`SELF_ONLY`). Nach dem Audit `TIKTOK_PRIVACY` z. B. auf `PUBLIC_TO_EVERYONE` setzen.

### YouTube

**Was du brauchst:** ein Google-Konto mit deinem YouTube-Kanal und etwa 15 Minuten.

1. console.cloud.google.com → oben „Projekt auswählen“ → **Neues Projekt** (z. B. „Crosspost“).
2. **APIs & Dienste → Bibliothek** → „YouTube Data API v3“ suchen → **Aktivieren**.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm** (heißt inzwischen auch „Google Auth Platform“):
   - Nutzertyp **Extern**, App-Name „Crosspost“, deine E-Mail als Support- und Entwickler-Kontakt.
   - Unter **Datenzugriff/Bereiche** hinzufügen: `.../auth/youtube.upload` und `.../auth/youtube.readonly`.
   - Unter **Zielgruppe/Testnutzer** deine eigene Google-Adresse eintragen. Solange die App im Testmodus ist, können sich nur Testnutzer anmelden (bis 100 Personen).
4. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**, Typ **Webanwendung**:
   - Autorisierte JavaScript-Quellen: `https://DEIN-NAME.github.io`
   - Autorisierte Weiterleitungs-URIs: die Redirect-URI aus Schritt 1 (endet auf `/oauth/callback/`)
5. Google zeigt **Client-ID** und **Clientschlüssel (Client Secret)** an.
   - Die **Client-ID** in der App unter *Settings → Integrations* („Google OAuth Client ID“) oder als GitHub-Variable `VITE_GOOGLE_CLIENT_ID` eintragen.
   - Den **Clientschlüssel** nur in den Server: `npx wrangler secret put GOOGLE_CLIENT_ID` und `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

**Mit oder ohne Server:**
- *Ohne Server* (nur Client-ID): Verbinden und Hochladen funktionieren sofort. Google gibt dann aber nur **1 Stunde** Zugang – danach in der App auf „Reconnect“ klicken.
- *Mit Server* (Client-ID + Secret auf Cloudflare): Der Zugang bleibt **dauerhaft**, geplante Uploads klappen auch Tage später.

**Was die App bei YouTube kann:**
- Video direkt vom Browser zu YouTube hochladen (mit Fortschrittsanzeige), Titel = Titelfeld (max. 100 Zeichen), Beschreibung = Bildunterschrift.
- Sichtbarkeit (öffentlich/nicht gelistet/privat), Kategorie, Tags, „Für Kinder gemacht“, „Als Short“ (#Shorts im Titel).
- **Geplante Beiträge**: Die App lädt das Video sofort hoch und YouTube veröffentlicht es selbst zur geplanten Zeit – auch wenn die App dann geschlossen ist.

**Grenzen laut YouTube-Dokumentation (Stand: November 2026):** bis zu 100 Uploads pro Tag über die API (eigenes Kontingent „Video Uploads“). Für mehr kann man bei Google ein höheres Kontingent beantragen. Damit andere Personen als die Testnutzer die App nutzen können, muss Google die App prüfen (Verifizierung des OAuth-Zustimmungsbildschirms, weil `youtube.upload` eine geschützte Berechtigung ist).

### Snapchat
- developers.snap.com → **App erstellen** → Login Kit, „Public OAuth Client ID“ verwenden, Redirect-URI eintragen.
- Snapchat erlaubt normalen Apps **kein automatisches Posten** – das Konto lässt sich verbinden, Beiträge dorthin bleiben manuell (die App zeigt das beim Veröffentlichen an).

## 4. App-IDs eintragen

Zwei Möglichkeiten:
- **In der App:** *Settings → Integrations* – Server-Adresse und die öffentlichen IDs (App-ID, Client Key, Client ID) eintragen. Gilt für diesen Browser.
- **Fest in der Website:** im GitHub-Repository *Settings → Secrets and variables → Actions → Variables* anlegen:
  `VITE_SERVER_URL`, `VITE_FACEBOOK_APP_ID`, `VITE_META_CONFIG_ID`, `VITE_TIKTOK_CLIENT_KEY`, `VITE_GOOGLE_CLIENT_ID`, `VITE_SNAPCHAT_CLIENT_ID`.
  Danach im Tab „Actions“ den Workflow erneut starten.

Die **Secrets** (App Secret, Client Secret) gehören nur in den Server – nie in GitHub-Variablen oder in die App.

## Was du wissen solltest

- Verbundene Konten mit dem Hinweis **Live** posten wirklich, **Demo**-Konten werden nur simuliert.
- Geplante Beiträge werden veröffentlicht, solange die App in einem Browser-Tab offen ist. Ausnahme YouTube: Dort wird das Video sofort hochgeladen und YouTube veröffentlicht es selbst zur geplanten Zeit. Für Veröffentlichen „im Hintergrund“ müsste der Server die Planung übernehmen (nächster Ausbauschritt).
- Die Zugangs-Tokens liegen im Browser (lokaler Speicher). Für mehrere Nutzer oder ein Team sollten sie auf dem Server liegen (ebenfalls ein Ausbauschritt).
- Cloudflare Workers nehmen im kostenlosen Tarif Uploads bis 100 MB an.

## Selbst bauen

```
npm install
npm run build        # Ergebnis in dist/
```
