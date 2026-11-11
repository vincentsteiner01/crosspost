// Writes the static HTML entry pages before Vite builds them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icons } from '../src/lib/icons.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = 'Crosspost';
// Sub-folder the site is served from (GitHub Pages: /<repository>/). Vite fixes
// scripts, styles and pictures itself; plain links are prefixed here.
const BASE = (process.env.BASE_PATH || '/').replace(/\/?$/, '/');

function page({ title, body, script, bodyClass = '', lang = 'de' }) {
  return `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${BRAND}">
<title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body class="${bodyClass}">
${body}
<script type="module" src="${script}"></script>
</body>
</html>
`;
}

function write(rel, html) {
  html = html.replace(/(<a\b[^>]*?\bhref=")\/(?!\/)/g, `$1${BASE}`);
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// Plain text pages linked from the footer.
const textPage = (heading, paras) => `<main class="text-page"><a href="/dashboard/" class="text-back">${icons.chevronLeft} Zurück zu Crosspost</a><h1>${heading}</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</main>`;
write(
  'privacy/index.html',
  page({
    title: `Datenschutzerklärung – ${BRAND}`,
    script: '/src/pages/plain.ts',
    body: textPage('Datenschutzerklärung', [
      'Dein Profil, deine Posts und deine Workflows werden in deinem eigenen Browser gespeichert (Local Storage). Videos, die du aus diesem Browser postest, werden ebenfalls dort aufbewahrt, damit du einen Post noch einmal ansehen kannst; du kannst sie unter „Einstellungen“ entfernen.',
      'Wenn du Facebook, Instagram, TikTok, YouTube oder Snapchat verbindest, meldest du dich auf der jeweiligen Plattform an und erlaubst dieser App, für dich zu veröffentlichen. Der Zugang, den sie dabei erhält, wird in deinem Browser gespeichert. Für Workflows und geplante Posts wird er außerdem verschlüsselt auf unserem Server gespeichert, damit Posts auch veröffentlicht werden können, während die App geschlossen ist; wenn du ein Konto trennst, wird er auch dort entfernt.',
      'Videos, die du über den Server planst oder veröffentlichst, werden dort nur so lange aufbewahrt, bis jede Plattform sie abgerufen hat (bei geplanten Posts höchstens 60 Tage), und danach gelöscht. YouTube-Uploads, die sofort erfolgen, gehen direkt von deinem Browser zu YouTube.',
      '<strong>Deine Daten löschen:</strong> Trenne ein Konto unter „Verbundene Konten“ oder lösche alles unter „Einstellungen → Deine Daten“. Du kannst die App außerdem in den Einstellungen der jeweiligen Plattform entfernen (zum Beispiel Facebook → Einstellungen → Apps und Websites). Fragen: Schreib an die Adresse, die im Impressum dieser Website angegeben ist.',
    ]),
  }),
);
write(
  'terms/index.html',
  page({
    title: `Nutzungsbedingungen – ${BRAND}`,
    script: '/src/pages/plain.ts',
    body: textPage('Nutzungsbedingungen', [
      'Beispiel-Nutzungsbedingungen für diesen Nachbau. Ersetze diesen Text durch deine eigenen Bedingungen, bevor du das Tool veröffentlichst.',
      'Poste nur Inhalte, die dir gehören oder für die du die Rechte zum Teilen hast, und halte dich an die Regeln jeder Plattform, auf der du veröffentlichst.',
    ]),
  }),
);

// Where every platform sends the person back after signing in.
write(
  'oauth/callback/index.html',
  page({
    title: `Verbinden – ${BRAND}`,
    script: '/src/pages/callback.ts',
    bodyClass: 'auth-page',
    body: `<main class="text-page"><h1 id="oauth-status">Konto wird verbunden…</h1><p id="oauth-detail">Einen Moment bitte.</p><a id="oauth-back" class="pink-link" href="/dashboard/#/accounts" hidden>Zurück</a></main>`,
  }),
);

// The app itself – there is no sign-in.
write(
  'dashboard/index.html',
  page({ title: `Übersicht – ${BRAND}`, script: '/src/pages/app.ts', bodyClass: 'app-page', body: `<div id="app"></div>` }),
);

// No sign-in: the start page and the old sign-in addresses lead straight into the app.
const redirect = (to) => `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${to}">
<title>${BRAND}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body><a href="${to}">${BRAND} öffnen</a></body>
</html>
`;
write('index.html', redirect('dashboard/'));
write('login/index.html', redirect('../dashboard/'));
write('signup/index.html', redirect('../dashboard/'));

export const entries = [
  'index.html', 'login/index.html', 'signup/index.html', 'privacy/index.html', 'terms/index.html', 'dashboard/index.html', 'oauth/callback/index.html',
];
console.log(`wrote ${entries.length} pages`);
