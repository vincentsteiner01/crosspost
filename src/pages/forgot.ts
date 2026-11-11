import '../styles/base.css';
import '../styles/auth.css';
import { findUser } from '../lib/store';

const form = document.querySelector<HTMLFormElement>('#form-forgot')!;
const input = document.querySelector<HTMLInputElement>('#forgot-email')!;
const msg = document.querySelector<HTMLElement>('#forgot-msg')!;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const em = input.value.trim();
  msg.classList.remove('ok');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
    msg.textContent = 'Please enter a valid email address';
    msg.hidden = false;
    return;
  }
  const user = findUser(em);
  msg.classList.add('ok');
  msg.textContent = user
    ? 'This rebuild has no mail server, so no email is sent. Your account is stored in this browser; sign up again with a new password if you forgot it.'
    : 'If an account exists for this address, a reset link is on its way.';
  msg.hidden = false;
});
