import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hashPassword } from './phone-gateway.mjs';

if (existsSync('.runtime/phone-auth.json')) throw new Error('Password already configured; refusing to overwrite it.');
mkdirSync('.runtime', { recursive: true });
const password = randomBytes(24).toString('base64url');
const hash = await hashPassword(password);
writeFileSync('.runtime/phone-auth.json', JSON.stringify({ origin: 'https://inbox.danienremoto.com', ...hash }, null, 2), { flag: 'wx', mode: 0o600 });
writeFileSync('.runtime/phone-login.txt', `Inbox: https://inbox.danienremoto.com\n\nPassword: ${password}\n\nSave this password in your password manager, then remove this local note.\nLogout: https://inbox.danienremoto.com/auth/logout\n`, { flag: 'wx', mode: 0o600 });
console.log('Password generated. Open .runtime/phone-login.txt locally; no credential was printed.');
