import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describe as sentence, eventsBetween } from '../src/events.js';

const state = ({ timer = null, lock = null, online = true } = {}) => ({
  apiVersion: 1,
  serverTime: '2026-09-25T18:00:00Z',
  signal: 1,
  device: { id: 'd', name: 'Elliots laptop', online },
  timer,
  lock,
});

const timer = (id, endsAt, message = null) => ({ id, startsAt: '2026-09-25T18:00:00Z', endsAt, secondsLeft: 600, message });
const lock = (seconds = 1800) => ({ startsAt: '2026-09-25T18:10:00Z', endsAt: '2026-09-25T18:40:00Z', secondsLeft: seconds, mode: 'Network' });

describe('what happened between two states', () => {
  it('nothing, the first time: a plugin that has just started has watched nothing happen', () => {
    assert.deepEqual(eventsBetween(null, state({ timer: timer('a', '2026-09-25T18:10:00Z') })), []);
    assert.deepEqual(eventsBetween(null, state({ lock: lock() })), []);
  });

  it('nothing, when nothing changed', () => {
    const s = state({ timer: timer('a', '2026-09-25T18:10:00Z') });
    assert.deepEqual(eventsBetween(s, { ...s, signal: 2 }), []);
  });

  it('a timer starting', () => {
    assert.deepEqual(eventsBetween(state(), state({ timer: timer('a', '2026-09-25T18:10:00Z') })), ['timer-started']);
  });

  it('a timer being made longer, which is not a new timer', () => {
    const before = state({ timer: timer('a', '2026-09-25T18:10:00Z') });
    const after = state({ timer: timer('a', '2026-09-25T18:20:00Z') });
    assert.deepEqual(eventsBetween(before, after), ['timer-extended']);
  });

  it('a timer ending with no lock, which is being let go', () => {
    assert.deepEqual(eventsBetween(state({ timer: timer('a', '2026-09-25T18:10:00Z') }), state()), ['timer-ended']);
  });

  it('time being up, which is the timer ending and the lock starting together', () => {
    assert.deepEqual(
      eventsBetween(state({ timer: timer('a', '2026-09-25T18:10:00Z') }), state({ lock: lock() })),
      ['timer-ended', 'lock-started'],
    );
  });

  it('the lock lifting', () => {
    assert.deepEqual(eventsBetween(state({ lock: lock() }), state()), ['lock-ended']);
  });

  it('starting time during a lock, which lifts it', () => {
    assert.deepEqual(
      eventsBetween(state({ lock: lock() }), state({ timer: timer('b', '2026-09-25T18:50:00Z') })),
      ['timer-started', 'lock-ended'],
    );
  });

  it('one timer replaced by another in a single step', () => {
    assert.deepEqual(
      eventsBetween(state({ timer: timer('a', '2026-09-25T18:10:00Z') }), state({ timer: timer('b', '2026-09-25T19:00:00Z') })),
      ['timer-ended', 'timer-started'],
    );
  });

  it('the computer going away and coming back', () => {
    assert.deepEqual(eventsBetween(state(), state({ online: false })), ['went-offline']);
    assert.deepEqual(eventsBetween(state({ online: false }), state()), ['came-online']);
  });
});

describe('saying it in words', () => {
  it('for a lock, a timer and neither', () => {
    assert.equal(sentence(state({ lock: lock(600) })), 'Elliots laptop is locked for another 10 minutes.');
    assert.equal(sentence(state({ timer: { ...timer('a', 'x'), secondsLeft: 90, message: 'Homework' } })), 'Elliots laptop has 2 minutes left (Homework).');
    assert.equal(sentence(state()), 'Elliots laptop has no timer running.');
  });

  it('with seconds when there are only seconds', () => {
    assert.equal(sentence(state({ timer: { ...timer('a', 'x'), secondsLeft: 1 } })), 'Elliots laptop has 1 second left.');
    assert.equal(sentence(state({ timer: { ...timer('a', 'x'), secondsLeft: 45 } })), 'Elliots laptop has 45 seconds left.');
  });
});
