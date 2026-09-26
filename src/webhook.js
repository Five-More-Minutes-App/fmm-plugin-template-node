// @ts-check
//
// Checking that a webhook really came from Five More Minutes.
//
// Anyone on your network can send your plugin a request, so a delivery is not believed until its
// signature checks out. The signing key is worked out from your own key's secret, so there is nothing
// new to store. See "Webhooks" in docs/plugins/api-v1.md in the Five More Minutes repository.
//
//   import { verifyWebhook } from './webhook.js';
//
//   // In whatever receives the request, with the body exactly as it arrived (a string or Buffer):
//   const result = verifyWebhook({ apiKey: process.env.FMM_API_KEY, headers: request.headers, body: rawBody });
//   if (!result.ok) return reply(401);          // result.reason says why, for your log; it never holds the key
//   const { type, state } = result.event;       // 'timer.started', and the computer's state at that moment
//
// Check the RAW body. Re-serialising parsed JSON changes the bytes, and the signature is over the bytes.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** How old a delivery may be before it is refused, in seconds. The timestamp is signed, so this stops replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The key deliveries are signed with, from your API key.
 * @param {string} apiKey
 */
export function signingKey(apiKey) {
  // The secret is the last 43 characters of the key. The service stores its SHA-256 as upper-case hex.
  const secret = apiKey.slice(-43);
  const hash = createHash('sha256').update(secret, 'utf8').digest('hex').toUpperCase();
  return createHmac('sha256', hash).update('fmm-webhook-v1', 'utf8').digest();
}

/**
 * What the signature of a delivery is: `v1=` and the hex HMAC-SHA256 of `${timestamp}.${body}`.
 * @param {string} apiKey
 * @param {string | number} timestamp unix seconds, as sent in X-FMM-Timestamp
 * @param {string | Buffer} body the raw body
 */
export function sign(apiKey, timestamp, body) {
  const text = typeof body === 'string' ? body : body.toString('utf8');
  return `v1=${createHmac('sha256', signingKey(apiKey)).update(`${timestamp}.${text}`, 'utf8').digest('hex')}`;
}

/**
 * @typedef {{ id: string, type: string, occurredAt: string, state: import('./client.js').State }} WebhookEvent
 * @typedef {{ ok: true, event: WebhookEvent, deliveryId: string } | { ok: false, reason: string }} Verified
 */

/**
 * Verifies a delivery and reads it. Never throws for a bad one: it says why not.
 *
 * @param {{ apiKey: string, headers: Record<string, string | string[] | undefined> | Headers,
 *           body: string | Buffer, toleranceSeconds?: number, now?: () => number }} options
 * @returns {Verified}
 */
export function verifyWebhook({ apiKey, headers, body, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now }) {
  const signature = header(headers, 'x-fmm-signature');
  const timestamp = header(headers, 'x-fmm-timestamp');
  const deliveryId = header(headers, 'x-fmm-delivery');

  if (!signature || !timestamp || !deliveryId) return { ok: false, reason: 'not a Five More Minutes delivery: headers are missing' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'the timestamp is not a number' };
  if (typeof apiKey !== 'string' || apiKey.length < 43) return { ok: false, reason: 'no usable API key to check with' };

  const age = Math.abs(now() / 1000 - Number(timestamp));
  if (age > toleranceSeconds) return { ok: false, reason: 'the timestamp is too old or too new: it may be a replay' };

  // Constant-time, and the same length first: timingSafeEqual refuses buffers of different sizes.
  const expected = Buffer.from(sign(apiKey, timestamp, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'the signature does not match' };
  }

  // Only now is the body trusted enough to read.
  try {
    const event = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
    if (!event || typeof event.type !== 'string' || typeof event.id !== 'string') throw new Error('shape');
    return { ok: true, event, deliveryId };
  } catch {
    return { ok: false, reason: 'the body is not the JSON a delivery carries' };
  }
}

/**
 * @param {Record<string, string | string[] | undefined> | Headers} headers
 * @param {string} name lower case
 * @returns {string | undefined}
 */
function header(headers, name) {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
