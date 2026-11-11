import '../styles/base.css';
import { finishOAuth } from '../lib/oauth';
import { connectAccount } from '../lib/store';
import { url } from '../lib/paths';

const status = document.getElementById('oauth-status')!;
const detail = document.getElementById('oauth-detail')!;
const back = document.getElementById('oauth-back') as HTMLAnchorElement;
back.href = url('dashboard/#/accounts');

finishOAuth()
  .then((r) => {
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
