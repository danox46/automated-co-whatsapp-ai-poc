import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Base64Url } from '../src/meta/pilotCrypto.js';

describe('Morning sign-in durable state', () => {
  it('retains one workspace setup across concurrent claims and fresh stubs until its original expiry', async () => {
    const name = 'morning-setup-' + crypto.randomUUID(), stub = env.OAUTH_STATE.getByName(name);
    const hash = await sha256Base64Url('workspace-one'), other = await sha256Base64Url('workspace-two');
    const now = Math.floor(Date.now() / 1000);
    const claims = await Promise.all([
      stub.claimMorningSetup(hash, 'encrypted-first', now + 300, now),
      stub.claimMorningSetup(hash, 'encrypted-second', now + 600, now)
    ]);
    expect(claims[0]).toBe('encrypted-first');
    expect(claims[1]).toBe(claims[0]);
    const resumed = env.OAUTH_STATE.getByName(name);
    expect(await resumed.claimMorningSetup(other, 'encrypted-other', now + 600, now)).toBe('encrypted-other');
    expect(await resumed.claimMorningSetup(hash, 'must-not-extend', now + 700, now + 299)).toBe('encrypted-first');
    expect(await resumed.claimMorningSetup(hash, 'too-long', now + 4000, now + 299)).toBeNull();
    expect(await resumed.claimMorningSetup(hash, 'expired', now + 299, now + 299)).toBeNull();
    expect(await resumed.claimMorningSetup(hash, 'renewed-after-expiry', now + 900, now + 300)).toBe('renewed-after-expiry');
    expect(await resumed.claimMorningSetup(other, 'unchanged-other', now + 900, now + 300)).toBe('encrypted-other');
  });
  it('claims one callback once across concurrent readers and preserves session expiry on business selection', async () => {
    const stub = env.OAUTH_STATE.getByName('morning-test-' + crypto.randomUUID());
    const hash = await sha256Base64Url('synthetic-browser-cookie'), now = Math.floor(Date.now() / 1000);
    await stub.putMorningLogin('flow', hash, 'synthetic-ciphertext-only', now + 300, now);
    expect(await stub.getMorningLogin('flow', hash, now)).toBe('synthetic-ciphertext-only');
    const claimed = await Promise.all([stub.consumeMorningLoginFlow(hash, now), stub.consumeMorningLoginFlow(hash, now)]);
    expect(claimed.filter(Boolean)).toEqual(['synthetic-ciphertext-only']);
    await stub.putMorningLogin('session', hash, 'initial-ciphertext', now + 600, now);
    await stub.putMorningLogin('session', hash, 'selected-business-ciphertext', 0, now + 60);
    expect(await stub.getMorningLogin('session', hash, now + 599)).toBe('selected-business-ciphertext');
    expect(await stub.getMorningLogin('session', hash, now + 600)).toBeNull();
    expect(await stub.putMorningLogin('session', hash, 'cannot-resurrect-expired', 0, now + 601)).toBe(false);
  });
  it('bounds public pending sign-ins and rejects invalid/extended lifetimes', async () => {
    const stub = env.OAUTH_STATE.getByName('morning-capacity-' + crypto.randomUUID()), now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 100; i++) await stub.putMorningLogin('flow', await sha256Base64Url(`flow-${i}`), 'synthetic-ciphertext', now + 300, now);
    expect(await stub.putMorningLogin('flow', await sha256Base64Url('over-capacity'), 'synthetic-ciphertext', now + 300, now)).toBe(false);
    expect(await stub.putMorningLogin('session', await sha256Base64Url('too-long'), 'synthetic-ciphertext', now + 3601, now)).toBe(false);
    await stub.putMorningLogin('flow', await sha256Base64Url('after-expiry'), 'synthetic-ciphertext', now + 601, now + 301);
    expect(await stub.getMorningLogin('flow', await sha256Base64Url('after-expiry'), now + 302)).toBe('synthetic-ciphertext');
  });
});
