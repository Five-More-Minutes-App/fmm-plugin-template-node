import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sign, signingKey, verifyWebhook } from '../src/webhook.js';
import { KEY } from './mock-fmm.js';

// The same vector the service's tests and the Python starter check: three implementations, one answer.
const VECTOR = { timestamp: '1758823200', body: '{"a":1}', signature: 'v1=f37713737d00007fea817485a555bb9d43390f486496011023acb798df490cf1' };

const NOW = 1758823200 * 1000;

const delivery = (over = {}) => {
  const body = over.body ?? JSON.stringify({ id: 'abc', type: 'timer.started', occurredAt: '2026-09-25T18:00:00Z', state: { apiVersion: 1 } });
  const timestamp = over.timestamp ?? '1758823200';
  return {
    body,
    headers: {
      'X-FMM-Event': 'timer.started',
      'X-FMM-Delivery': 'd1',
      'X-FMM-Timestamp': timestamp,
      'X-FMM-Signature': over.signature ?? sign(over.key ?? KEY, timestamp, body),
      ...(over.headers ?? {}),
    },
  };
};

const check = (d, options = {}) => verifyWebhook({ apiKey: KEY, headers: d.headers, body: d.body, now: () => NOW, ...options });

describe('signing', () => {
  it('matches the vector the service produces', () => {
    assert.equal(sign(KEY, VECTOR.timestamp, VECTOR.body), VECTOR.signature);
    assert.equal(sign(KEY, Number(VECTOR.timestamp), Buffer.from(VECTOR.body)), VECTOR.signature);
  });

  it('is different for a different key, time or body', () => {
    const other = `fmmk_${'0123456789abcdef'.repeat(2)}_${'B'.repeat(43)}`;
    assert.notEqual(sign(other, VECTOR.timestamp, VECTOR.body), VECTOR.signature);
    assert.notEqual(sign(KEY, '1758823201', VECTOR.body), VECTOR.signature);
    assert.notEqual(sign(KEY, VECTOR.timestamp, `${VECTOR.body} `), VECTOR.signature);
    assert.equal(signingKey(KEY).length, 32);
  });
});

describe('verifying a delivery', () => {
  it('accepts a good one and reads it', () => {
    const result = check(delivery());

    assert.equal(result.ok, true);
    assert.equal(result.event.type, 'timer.started');
    assert.equal(result.deliveryId, 'd1');
  });

  it('accepts the body as a Buffer, and headers in any case or as a Headers object', () => {
    const d = delivery();

    assert.equal(check({ ...d, body: Buffer.from(d.body) }).ok, true);
    assert.equal(check({ ...d, headers: new Headers(d.headers) }).ok, true);
    assert.equal(check({ ...d, headers: Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k.toLowerCase(), v])) }).ok, true);
  });

  it('refuses a body that was changed, even by a space', () => {
    const d = delivery();

    assert.equal(check({ ...d, body: `${d.body} ` }).ok, false);
    assert.equal(check({ ...d, body: d.body.replace('timer.started', 'timer.ended') }).ok, false);
  });

  it('refuses a signature made with a different key', () => {
    const other = `fmmk_${'0123456789abcdef'.repeat(2)}_${'B'.repeat(43)}`;

    assert.match(check(delivery({ key: other })).reason, /does not match/);
  });

  it('refuses one that is too old, or from the future, which is what a replay looks like', () => {
    assert.match(check(delivery({ timestamp: String(1758823200 - 3600) })).reason, /replay/);
    assert.match(check(delivery({ timestamp: String(1758823200 + 3600) })).reason, /replay/);
    assert.equal(check(delivery({ timestamp: String(1758823200 - 200) })).ok, true);
    assert.equal(check(delivery({ timestamp: String(1758823200 - 200) }), { toleranceSeconds: 60 }).ok, false);
  });

  it('refuses one that was re-stamped: the time is inside the signature', () => {
    const old = delivery({ timestamp: '1758823000' });

    assert.equal(check({ ...old, headers: { ...old.headers, 'X-FMM-Timestamp': '1758823200' } }).ok, false);
  });

  it('says so when it is not a delivery at all', () => {
    assert.match(check({ body: '{}', headers: {} }).reason, /headers are missing/);
    assert.match(check(delivery({ headers: { 'X-FMM-Timestamp': 'yesterday' } })).reason, /not a number/);
    assert.match(verifyWebhook({ apiKey: '', headers: delivery().headers, body: delivery().body, now: () => NOW }).reason, /usable API key/);
  });

  it('does not read a body it has not verified, and refuses one that is signed but not JSON', () => {
    const body = 'not json';
    const d = delivery({ body });

    assert.match(check(d).reason, /not the JSON/);
    assert.equal(check({ ...d, headers: { ...d.headers, 'X-FMM-Signature': 'v1=00' } }).reason, 'the signature does not match');
  });

  it('never puts the key in what it says', () => {
    for (const d of [delivery({ key: `fmmk_${'0123456789abcdef'.repeat(2)}_${'B'.repeat(43)}` }), delivery({ timestamp: '1' }), { body: '', headers: {} }]) {
      assert.ok(!JSON.stringify(check(d)).includes(KEY));
    }
  });
});
