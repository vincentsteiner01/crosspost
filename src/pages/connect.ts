import '../styles/base.css';
import '../styles/connect.css';
import { connectAccount, createUser, currentUser, findUser, signIn } from '../lib/store';
import type { PlatformId } from '../lib/platforms';
import { isConfigured, type OAuthPlatform } from '../lib/config';
import { startOAuth } from '../lib/oauth';
import { url } from '../lib/paths';

const card = document.querySelector<HTMLElement>('.connect-card')!;
const provider = card.dataset.provider!;
const connects = card.dataset.connects as PlatformId;
const providerName = { google: 'Google', youtube: 'YouTube', facebook: 'Facebook', amazon: 'Amazon' }[provider] ?? provider;
const form = document.querySelector<HTMLFormElement>('#connect-form')!;
const input = document.querySelector<HTMLInputElement>('#connect-email')!;
const error = document.querySelector<HTMLElement>('#connect-error')!;
const help = document.querySelector<HTMLElement>('#connect-help-text')!;

// With the platform's app set up, go straight to its real sign-in, as the
// original does; this page is the demo fallback until then.
if (isConfigured(connects as OAuthPlatform)) {
  startOAuth(connects as OAuthPlatform, { signIn: !currentUser() }).catch(() => {});
}

// Opened from the app's "connect" button: the person is already signed in.
const signedIn = currentUser();
if (signedIn) {
  document.querySelector('main h1, .connect-card h1')!.textContent = `${providerName}-Konto verbinden`;
  document.querySelectorAll<HTMLElement>('.connect-actions > .connect-link, .split-actions, .box-divider, .box-create').forEach((el) => (el.hidden = true));
}

document.querySelector('#connect-help')!.addEventListener('click', (e) => {
  e.preventDefault();
  help.hidden = !help.hidden;
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) {
    error.textContent = 'Geben Sie eine E-Mail-Adresse oder einen Kontonamen ein.';
    error.hidden = false;
    input.focus();
    return;
  }
  error.hidden = true;
  form.querySelector<HTMLButtonElement>('.connect-next')!.disabled = true;

  const isEmail = value.includes('@');
  const handle = isEmail ? value.split('@')[0] : value.replace(/^@/, '');
  if (!signedIn) {
    const email = isEmail ? value : `${handle.toLowerCase().replace(/\s+/g, '.')}@${provider}.local`;
    if (!findUser(email)) createUser({ name: handle, email, method: providerName });
    signIn(email);
  }
  // Google sign-in links the YouTube channel, as on the original.
  // On the Facebook step a page name can be given: posts go to that page.
  const page = document.querySelector<HTMLInputElement>('#connect-page')?.value.trim();
  connectAccount(connects, page || handle);
  setTimeout(() => location.assign(url('dashboard/#/accounts')), 350);
});

// Ask once before storing anything (shown on the layouts that carry the notice).
const consent = document.querySelector<HTMLElement>('#consent');
const CONSENT_KEY = 'crosspost:consent';
if (consent && !localStorage.getItem(CONSENT_KEY)) {
  consent.hidden = false;
  consent.querySelectorAll<HTMLButtonElement>('[data-consent]').forEach((b) =>
    b.addEventListener('click', () => {
      localStorage.setItem(CONSENT_KEY, b.dataset.consent!);
      consent.hidden = true;
      input.focus();
    }),
  );
}
