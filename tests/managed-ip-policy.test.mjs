import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateAddress } from '../packages/piagent-core/managed/ip-policy.mjs';

test('IPv4 special-purpose ranges are private, public addresses are not', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.0.9', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.129', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255'])
    assert.equal(privateAddress(address), true, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '104.16.0.35', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.0.1.1', '192.169.0.1', '198.17.0.1', '198.20.0.1', '223.255.255.255'])
    assert.equal(privateAddress(address), false, address);
});

test('IPv6 forms that carry an IPv4 address are judged by it, dotted or hex', () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:7F00:0001', '0:0:0:0:0:ffff:c0a8:101', '::ffff:c0a8:101', '::ffff:a00:5',
    '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', '::127.0.0.1', '::7f00:1', '::a00:1',
    '64:ff9b::7f00:1', '64:ff9b::c0a8:101', '64:ff9b::10.0.0.1', '64:ff9b:1::808:808', '64:ff9b:1:2::1',
    '2002:7f00:1::1', '2002:c0a8:101::', '2002:a00:5:1::1'])
    assert.equal(privateAddress(address), true, address);
  for (const address of ['::ffff:808:808', '::ffff:8.8.8.8', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '2002:808:808::1'])
    assert.equal(privateAddress(address), false, address);
});

test('IPv6 special-purpose ranges are private, global unicast is not', () => {
  for (const address of ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe80::1%en0', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'ff00::',
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '2001:2::1', '3fff::1', '100::1', '100::ffff:1', '4000::1', '::2:0:0:1', '::ffff:7f00:1:2'])
    assert.equal(privateAddress(address), true, address);
  for (const address of ['2606:4700:4700::1111', '2606:4700::6810:84e5', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888'])
    assert.equal(privateAddress(address), false, address);
});

test('anything that is not an address counts as private', () => {
  for (const address of ['', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '::ffff:1.2.3.256', '1::2::3', ':1::', '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7', '12345::1', 'g::1', '[::1]', undefined, null])
    assert.equal(privateAddress(address), true, String(address));
});
