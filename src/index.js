// @ts-check
//
// The smallest useful plugin: it connects, says what it may do, and then reports what happens to the
// computer until you stop it. Replace the body of the loop with what you actually want - turn a light
// red, send a message, block a device - and keep the rest.
//
//   FMM_URL=http://192.168.1.10:5072 FMM_API_KEY=fmmk_... node src/index.js
//   node src/index.js --start 30 "Homework"      also starts 30 minutes, if the key may

import { FiveMoreMinutes, FmmError } from './client.js';
import { describe, eventsBetween } from './events.js';

const { FMM_URL, FMM_API_KEY } = process.env;

if (!FMM_URL || !FMM_API_KEY) {
  console.error('Set FMM_URL and FMM_API_KEY. See .env.example, and README.md for how to make a key.');
  process.exit(2);
}

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());
process.on('SIGTERM', () => stop.abort());

try {
  const fmm = new FiveMoreMinutes({ url: FMM_URL, apiKey: FMM_API_KEY });

  // Prove the address and the key work before doing anything else, and say what this key may do,
  // so that a missing permission is a message at start-up rather than a failure later.
  const me = await fmm.me();
  console.log(`Connected as "${me.key.name}" to ${me.device.name}.`);
  console.log(`This key may: ${me.key.scopes.join(', ')}`);
  if (me.key.expiresAt) console.log(`It expires ${me.key.expiresAt}.`);

  const [flag, minutes, ...rest] = process.argv.slice(2);
  if (flag === '--start') {
    const state = await fmm.start({ minutes: Number(minutes), message: rest.join(' ') || undefined });
    console.log(describe(state));
  }

  let previous = null;
  for await (const state of fmm.watch({ signal: stop.signal })) {
    if (previous === null) console.log(describe(state));

    for (const event of eventsBetween(previous, state)) {
      // This is where your plugin does its work.
      console.log(`${event}: ${describe(state)}`);
    }

    previous = state;
  }
} catch (error) {
  if (error instanceof FmmError) {
    // Every message here is safe to show a person; none contains the key.
    console.error(error.message);
    process.exit(error.kind === 'config' ? 2 : 1);
  }
  throw error;
}

console.log('Stopped.');
