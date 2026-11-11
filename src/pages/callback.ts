import '../styles/base.css';
import '../styles/auth.css';
import { finishOAuth } from '../lib/oauth';
import { connectAccount, createUser, currentUser, findUser, signIn } from '../lib/store';
import { url } from '../lib/paths';

const status = document.getElementById('oauth-status')!;
const detail = document.getElementById('oauth-detail')!;
const back = document.getElementById('oauth-back') as HTMLAnchorElement;
back.href = url(currentUser() ? 'dashboard/#/accounts' : 'login/');

finishOAuth()
  .then((r) => {
    if (!currentUser()) {
      // Signing in with a platform: one local profile per platform account.
      const email = `${r.handle.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@${r.platform}.oauth`;
      if (!findUser(email)) createUser({ name: r.handle, email, method: r.platform });
      signIn(email);
    }
    connectAccount(r.platform, r.handle, r.auth);
    status.textContent = 'Verbunden!';
    detail.textContent = `${r.handle} ist jetzt verbunden. Du wirst weitergeleitet …`;
    setTimeout(() => location.replace(url('dashboard/#/accounts')), 900);
  })
  .catch((e: Error) => {
    status.textContent = 'Verbinden hat nicht geklappt';
    detail.textContent = e.message;
    back.hidden = false;
  });
