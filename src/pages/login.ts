import '../styles/base.css';
import '../styles/auth.css';
import { createUser, currentUser, findUser, hashPassword, signIn } from '../lib/store';
import { url } from '../lib/paths';

if (currentUser()) location.replace(url('dashboard/'));

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const form = $<HTMLFormElement>('#form-auth');
const mode = form.dataset.mode as 'login' | 'signup';
const social = $('#socialButtons');
const title = $('#titleSection');
const emailSection = $('#emailSection');
const errorBox = $('#auth-error');
const email = $<HTMLInputElement>('#auth-email');
const password = $<HTMLInputElement>('#auth-password');
const nameInput = document.querySelector<HTMLInputElement>('#auth-name');
const submit = $<HTMLButtonElement>('#auth-submit');

// Swap between the provider list and the email form with a short fade.
function swap(hide: HTMLElement[], show: HTMLElement[], focus?: HTMLElement) {
  hide.forEach((el) => el.classList.add('anim-out'));
  setTimeout(() => {
    hide.forEach((el) => { el.hidden = true; el.classList.remove('anim-out'); });
    show.forEach((el) => { el.hidden = false; el.classList.remove('anim-in'); void el.offsetWidth; el.classList.add('anim-in'); });
    focus?.focus();
  }, 200);
}

$('#loginWithEmailBtn').addEventListener('click', () => {
  resetErrors();
  email.value = '';
  password.value = '';
  if (nameInput) nameInput.value = '';
  swap([social, title], [emailSection], nameInput ?? email);
});
$('#backButton').addEventListener('click', () => {
  errorBox.hidden = true;
  swap([emailSection], [title, social]);
});

$('#toggle-password').addEventListener('click', () => {
  password.type = password.type === 'password' ? 'text' : 'password';
});

function resetErrors() {
  errorBox.hidden = true;
  form.querySelectorAll('.field').forEach((f) => f.classList.remove('has-error'));
  form.querySelectorAll('.help-block').forEach((h) => h.remove());
}

function fieldError(input: HTMLInputElement, msg: string) {
  const field = input.closest('.field')!;
  field.classList.add('has-error');
  const help = document.createElement('span');
  help.className = 'help-block';
  help.textContent = msg;
  field.appendChild(help);
}

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submit.disabled) return;
  resetErrors();
  const em = email.value.trim();
  const pw = password.value;
  let ok = true;
  if (nameInput && !nameInput.value.trim()) { fieldError(nameInput, 'Please enter your name'); ok = false; }
  if (!em) { fieldError(email, 'Please enter your email address'); ok = false; }
  else if (!EMAIL.test(em)) { fieldError(email, 'Please enter a valid email address'); ok = false; }
  if (!pw.trim()) { fieldError(password, 'Please enter your password'); ok = false; }
  else if (mode === 'signup' && pw.length < 8) { fieldError(password, 'Password must be at least 8 characters'); ok = false; }
  if (!ok) return;

  submit.disabled = true;
  const hash = await hashPassword(pw);
  await new Promise((r) => setTimeout(r, 400));
  const user = findUser(em);

  if (mode === 'login') {
    if (!user || user.passwordHash !== hash) {
      submit.disabled = false;
      showError(user && !user.passwordHash
        ? `This account signs in with ${user.method}. Use that button instead.`
        : 'These credentials do not match our records.');
      return;
    }
  } else {
    if (user) {
      submit.disabled = false;
      showError('An account with this email already exists. Please sign in.');
      return;
    }
    createUser({ name: nameInput!.value.trim(), email: em, passwordHash: hash, method: 'email' });
  }
  signIn(em);
  location.href = url('dashboard/');
});
