import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyDiscordRequest } from '../worker/discord.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({ type: 0 });
const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
const request = new Request('https://example.test/api/discord/events', {
  method: 'POST',
  headers: {
    'x-signature-ed25519': signature,
    'x-signature-timestamp': timestamp,
  },
  body,
});

assert.equal(await verifyDiscordRequest(request, body, { DISCORD_PUBLIC_KEY: rawPublicKey }), true);
assert.equal(await verifyDiscordRequest(request, `${body} `, { DISCORD_PUBLIC_KEY: rawPublicKey }), false);
console.log('Assinatura dos webhooks do Discord: OK');
