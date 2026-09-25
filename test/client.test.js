import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { after, describe, it } from 'node:test';
import { FiveMoreMinutes, FmmError } from '../src/client.js';
import { ALL, KEY, startMock } from './mock-fmm.js';

const open = [];
async function mock(options) {
  const server = await startMock(options);
  open.push(server);
  return server;
}
const clientFor = (server, extra = {}) => new FiveMoreMinutes({ url: server.url, apiKey: KEY, ...extra });
after(() => Promise.all(open.map((s) => s.close())));

const rejects = async (promise, kind) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof FmmError, `expected an FmmError, got ${error}`);
    assert.equal(error.kind, kind, error.message);
    assert.ok(!error.message.includes(KEY), 'the key appeared in an error message');
    assert.ok(!String(error.stack).includes(KEY), 'the key appeared in an error stack');
    return true;
  });
};

describe('setting up', () => {
  it('takes a web address and a key', () => {
    assert.doesNotThrow(() => new FiveMoreMinutes({ url: 'http://192.168.1.10:5072', apiKey: KEY }));
    assert.doesNotThrow(() => new FiveMoreMinutes({ url: 'https://fmm.example.com/', apiKey: KEY }));
  });

  it('refuses an address that is not one, and says what to use', () => {
    for (const url of ['', 'not a url', '192.168.1.10:5072', 'ftp://192.168.1.10', 'file:///etc/passwd', 'javascript:alert(1)']) {
      assert.throws(() => new FiveMoreMinutes({ url, apiKey: KEY }), (e) => e instanceof FmmError && e.kind === 'config', url);
    }
  });

  it('refuses credentials in the address, where they would be logged', () => {
    assert.throws(() => new FiveMoreMinutes({ url: 'http://user:pass@192.168.1.10', apiKey: KEY }), /Do not put/);
  });

  it('refuses a key that is not shaped like one, without repeating what it was given', () => {
    const wrong = [undefined, null, '', 'hunter2', 'fmmk_short', `${KEY}x`, ` ${KEY}`, KEY.toUpperCase(), KEY.replace('fmmk_', 'fmmx_')];
    for (const apiKey of wrong) {
      assert.throws(
        () => new FiveMoreMinutes({ url: 'http://localhost:5072', apiKey }),
        (e) => e instanceof FmmError && e.kind === 'config' && !String(apiKey ?? 'x').includes(e.message),
      );
    }
  });

  it('never shows the key when the client is printed or serialised', () => {
    const client = new FiveMoreMinutes({ url: 'http://localhost:5072', apiKey: KEY });

    for (const text of [inspect(client, { depth: 5, showHidden: true }), JSON.stringify(client), `${inspect(client)}`, String(JSON.stringify({ client }))]) {
      assert.ok(!text.includes(KEY), text);
      assert.ok(!text.includes('fmmk_'), text);
    }
  });
});

describe('asking', () => {
  it('sends the key as a bearer token and nothing else about who it is', async () => {
    const server = await mock();
    await clientFor(server).me();

    const [request] = server.world.requests;
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.path, '/api/integrations/v1/me');
    assert.equal(request.headers.accept, 'application/json');
  });

  it('says who the key is and what it may do', async () => {
    const server = await mock({ scopes: ['state:read'] });
    const me = await clientFor(server).me();

    assert.deepEqual(me.key.scopes, ['state:read']);
    assert.equal(me.device.name, 'Elliots laptop');
  });

  it('works under a path, for a service behind a reverse proxy', async () => {
    const server = await mock();
    const client = new FiveMoreMinutes({ url: `${server.url}/`, apiKey: KEY });
    await client.me();
    assert.equal(server.world.requests[0].path, '/api/integrations/v1/me');
  });

  it('reads the state of the one computer', async () => {
    const server = await mock();
    const state = await clientFor(server).state();

    assert.equal(state.timer, null);
    assert.equal(state.lock, null);
    assert.equal(state.device.online, true);
    assert.equal(typeof state.signal, 'number');
  });
});

describe('doing', () => {
  it('starts, extends and stops', async () => {
    const server = await mock();
    const fmm = clientFor(server);

    const started = await fmm.start({ minutes: 30, message: 'Homework' });
    assert.equal(started.timer.message, 'Homework');
    assert.ok(started.timer.secondsLeft > 1700);
    assert.deepEqual(server.world.requests.at(-1).body, { minutes: 30, message: 'Homework' });

    const extended = await fmm.extend(10);
    assert.ok(extended.timer.secondsLeft > 2300);

    const stopped = await fmm.stop();
    assert.equal(stopped.timer, null);
    assert.ok(stopped.lock.secondsLeft > 0);
  });

  it('cancels, which leaves no lock', async () => {
    const server = await mock();
    const fmm = clientFor(server);
    await fmm.start({ minutes: 10 });

    const state = await fmm.cancel();

    assert.equal(state.timer, null);
    assert.equal(state.lock, null);
  });

  it('extends by the household’s usual amount when not told how much', async () => {
    const server = await mock();
    const fmm = clientFor(server);
    await fmm.start({ minutes: 10 });

    await fmm.extend();

    assert.deepEqual(server.world.requests.at(-1).body, {});
  });
});

describe('being refused', () => {
  it('says the key was not accepted', async () => {
    const server = await mock({ key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` });
    await rejects(clientFor(server).me(), 'auth');
  });

  it('says a permission is missing, naming it', async () => {
    const server = await mock({ scopes: ['state:read'] });

    await assert.rejects(clientFor(server).start({ minutes: 5 }), (e) => {
      assert.equal(e.kind, 'forbidden');
      assert.match(e.message, /timer:start/);
      return true;
    });
  });

  it('says the service only answers on the local network', async () => {
    const server = await mock({ localOnly: true });

    await assert.rejects(clientFor(server).me(), (e) => {
      assert.equal(e.kind, 'network-only');
      assert.match(e.message, /local network/);
      assert.equal(e.retryable, false);
      return true;
    });
  });

  it('says when the computer is not in a state that allows it', async () => {
    const server = await mock();
    const fmm = clientFor(server);

    await rejects(fmm.extend(5), 'not-possible');
    await rejects(fmm.stop(), 'not-possible');
    await fmm.start({ minutes: 5 });
    await rejects(fmm.start({ minutes: 5 }), 'not-possible');
  });

  it('says when the request was wrong', async () => {
    const server = await mock();
    await rejects(clientFor(server).start({}), 'invalid');
  });

  it('says how long to wait when slowed down', async () => {
    const server = await mock({ limit: 0 });

    await assert.rejects(clientFor(server).me(), (e) => {
      assert.equal(e.kind, 'rate-limited');
      assert.equal(e.retryAfter, 1);
      assert.equal(e.retryable, true);
      return true;
    });
  });

  it('calls a server error unexpected and worth retrying', async () => {
    const server = await mock();
    server.world.failNext = 1;

    await assert.rejects(clientFor(server).me(), (e) => e.kind === 'unexpected' && e.retryable);
  });

  it('says when the service cannot be reached at all', async () => {
    const server = await mock();
    const url = server.url;
    await server.close();

    await assert.rejects(new FiveMoreMinutes({ url, apiKey: KEY }).me(), (e) => {
      assert.equal(e.kind, 'network');
      assert.ok(e.retryable);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  });

  it('gives up on a service that does not answer', async () => {
    const stuck = createServer(() => {});
    await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve));
    after(() => { stuck.closeAllConnections(); stuck.close(); });

    const fmm = new FiveMoreMinutes({ url: `http://127.0.0.1:${stuck.address().port}`, apiKey: KEY, timeoutMs: 150 });

    await rejects(fmm.me(), 'network');
  });
});

describe('never sending the key somewhere else', () => {
  it('does not follow a redirect', async () => {
    const elsewhere = createServer((request, response) => {
      elsewhere.seen = request.headers.authorization;
      response.end('{}');
    });
    await new Promise((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
    after(() => elsewhere.close());

    const redirecting = createServer((request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.address().port}/steal` });
      response.end();
    });
    await new Promise((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
    after(() => redirecting.close());

    const fmm = new FiveMoreMinutes({ url: `http://127.0.0.1:${redirecting.address().port}`, apiKey: KEY });

    await rejects(fmm.me(), 'unexpected');
    assert.equal(elsewhere.seen, undefined, 'the key was sent to the redirect target');
  });
});

describe('waiting for a change', () => {
  it('holds the request open until something changes, then answers at once', async () => {
    const server = await mock();
    const fmm = clientFor(server);
    const before = await fmm.state();

    const waiting = fmm.state({ wait: 20, since: before.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    server.parentStarts(15, 'x');

    const after = await waiting;

    assert.ok(after.signal > before.signal);
    assert.equal(after.timer.message, 'x');
    assert.equal(server.world.requests.at(-1).query.wait, '20');
    assert.equal(server.world.requests.at(-1).query.since, String(before.signal));
  });

  it('keeps the wait inside what the service allows', async () => {
    const server = await mock();
    await clientFor(server).state({ wait: 999 });
    await clientFor(server).state({ wait: -5 });

    assert.equal(server.world.requests[0].query.wait, '25');
    assert.equal(server.world.requests[1].query.wait, '1');
  });

  it('can be cut short', async () => {
    const server = await mock();
    const fmm = clientFor(server);
    const { signal } = await fmm.state();
    const stop = new AbortController();

    const waiting = fmm.state({ wait: 20, since: signal, signal: stop.signal });
    setTimeout(() => stop.abort(), 100);

    await assert.rejects(waiting);
  });
});

describe('watching', () => {
  const collect = async (fmm, count, run) => {
    const stop = new AbortController();
    const seen = [];
    const done = (async () => {
      for await (const state of fmm.watch({ signal: stop.signal, waitSeconds: 5, backoff: { minMs: 20, maxMs: 40 } })) {
        seen.push(state);
        if (seen.length >= count) stop.abort();
      }
    })();

    await run?.();
    await done;
    return seen;
  };

  it('yields the state now, then again for each change', async () => {
    const server = await mock();
    const seen = await collect(clientFor(server), 3, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      server.parentStarts(20, 'Homework');
      await new Promise((resolve) => setTimeout(resolve, 150));
      server.parentLocks();
    });

    assert.equal(seen[0].timer, null);
    assert.equal(seen[1].timer.message, 'Homework');
    assert.equal(seen[2].timer, null);
    assert.ok(seen[2].lock);
  });

  it('carries on through a hiccup', async () => {
    const server = await mock();
    server.world.failNext = 2;

    const seen = await collect(clientFor(server), 1);

    assert.equal(seen.length, 1, 'it should have recovered and yielded');
    assert.ok(server.world.requests.length >= 3);
  });

  it('stops with the error when trying again cannot help, so a person can be told', async () => {
    const server = await mock({ key: `fmmk_${'f'.repeat(32)}_${'B'.repeat(43)}` });

    await assert.rejects(
      (async () => { for await (const _ of clientFor(server).watch({ waitSeconds: 1 })) { /* nothing */ } })(),
      (e) => e.kind === 'auth',
    );
  });

  it('stops quietly when asked to', async () => {
    const server = await mock();
    const stop = new AbortController();
    const fmm = clientFor(server);

    let count = 0;
    for await (const _ of fmm.watch({ signal: stop.signal, waitSeconds: 1 })) {
      count += 1;
      stop.abort();
    }

    assert.equal(count, 1);
  });

  it('does not use every permission it was given up just by watching', async () => {
    const server = await mock({ scopes: ['state:read'] });
    const seen = await collect(clientFor(server), 1);
    assert.equal(seen.length, 1);
    assert.ok(server.world.requests.every((r) => r.method === 'GET'));
    assert.deepEqual(ALL.length, 5);
  });
});
