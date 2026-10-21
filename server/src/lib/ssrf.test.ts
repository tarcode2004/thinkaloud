import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateAddress, SsrfError } from './ssrf.ts';

test('private, loopback, link-local and special addresses are refused', () => {
  for (const ip of [
    '127.0.0.1', '127.8.9.10', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe', 'ff02::1', 'not-an-ip',
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('assertPublicUrl rejects internal targets and honours ALLOW_PRIVATE_PROXY', async () => {
  const prev = process.env.ALLOW_PRIVATE_PROXY;
  delete process.env.ALLOW_PRIVATE_PROXY;
  try {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://app.localhost/', 'ftp://example.com/'])
      await assert.rejects(assertPublicUrl(u), SsrfError, u);
    await assertPublicUrl('http://8.8.8.8/');
    process.env.ALLOW_PRIVATE_PROXY = '1';
    await assertPublicUrl('http://127.0.0.1:3000/');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_PRIVATE_PROXY;
    else process.env.ALLOW_PRIVATE_PROXY = prev;
  }
});
