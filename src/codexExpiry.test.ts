import { codexSessionExpired } from './codexExpiry';

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
const now = Date.parse('2026-10-25T00:00:00Z');
const sec = (iso: string) => Date.parse(iso) / 1000;
let fail = 0;
const check = (name: string, got: boolean, want: boolean) => {
  if (got !== want) {
    fail++;
    console.error(`FALHOU: ${name}`);
  }
};

const old = { id_token: jwt(sec('2026-10-16T13:00:00Z')), access_token: jwt(sec('2026-10-17T13:00:00Z')) };
check('tudo vencido e refresh antigo', codexSessionExpired({ tokens: old, last_refresh: '2026-10-16T12:00:00Z' }, now), true);
check('access ainda válido', codexSessionExpired({ tokens: { ...old, access_token: jwt(sec('2026-10-26T00:00:00Z')) }, last_refresh: '2026-10-16T12:00:00Z' }, now), false);
check('refresh recente', codexSessionExpired({ tokens: old, last_refresh: '2026-10-24T12:00:00Z' }, now), false);
check('sem token legível', codexSessionExpired({ tokens: { id_token: 'abc' } }, now), false);

if (fail) {
  process.exit(1);
}
console.log('ok');
