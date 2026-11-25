/**
 * Unit tests for the pure application workflow rules (no database, no HTTP).
 * The list of allowed moves is checked against the README's Workflow C diagram,
 * so the code and the documentation can't drift apart.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  FINAL_STATES,
  STATES,
  STATE_LABELS,
  TRANSITIONS,
  allowedMoves,
  canTransition,
  groupFitsUnit,
  isFinal,
  isOfferExpired,
} from '../src/services/application.workflow.js';

const ALL_STATES = Object.values(STATES);
const ALL_ACTORS = Object.values(ACTORS);
const DEADLINE = new Date('2027-03-01T17:00:00.000Z');
const ms = (n) => new Date(DEADLINE.getTime() + n);
const BEFORE = { offerExpiresAt: DEADLINE, now: ms(-1) };
const AT = { offerExpiresAt: DEADLINE, now: DEADLINE };
const AFTER = { offerExpiresAt: DEADLINE, now: ms(1) };

/** The context a move needs to be allowed (accept: before the deadline; expire: at it). */
const contextFor = (move) =>
  move.action === 'accept' ? BEFORE : move.action === 'expire offer' ? AT : undefined;

/**
 * Read the moves from the README's "C. Group application → offer" mermaid diagram.
 * Labels start with who acts: "group …", "landlord …", or "deadline passes" (system).
 */
function movesFromReadme() {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('### C. Group application'));
  const diagram = section.slice(section.indexOf('```mermaid'), section.indexOf('```\n', 10));
  const actorByWord = { group: 'GROUP_MEMBER', landlord: 'LISTING_OWNER', deadline: 'SYSTEM' };

  const moves = [];
  for (const line of diagram.split('\n')) {
    const m = /^\s*(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)\s*(?::\s*(\w+))?/.exec(line);
    if (!m || m[2] === '[*]') continue; // skip "final → [*]" end markers
    moves.push({
      from: m[1] === '[*]' ? null : m[1].toUpperCase(),
      to: m[2].toUpperCase(),
      actor: actorByWord[m[3]],
    });
  }
  return moves;
}

const key = ({ from, to, actor }) => `${from} → ${to} by ${actor}`;

describe('TRANSITIONS match the README diagram', () => {
  it('has exactly the moves (and actors) drawn in Workflow C, no more and no fewer', () => {
    const readmeMoves = movesFromReadme();
    expect(readmeMoves.length).toBeGreaterThan(0); // the diagram was found and parsed
    expect(readmeMoves.every((m) => m.actor)).toBe(true); // every label names who acts
    expect(TRANSITIONS.map(key).sort()).toEqual(readmeMoves.map(key).sort());
  });

  it('lists each move once, and every state has a friendly label', () => {
    const pairs = TRANSITIONS.map((t) => `${t.from}→${t.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const state of ALL_STATES) expect(STATE_LABELS[state]).toEqual(expect.any(String));
    expect(STATE_LABELS.DOCS_REQUESTED).toBe('Documents requested');
  });

  it('uses UPPERCASE state values', () => {
    for (const state of ALL_STATES) expect(state).toBe(state.toUpperCase());
  });
});

describe('canTransition(): allowed moves', () => {
  it.each(TRANSITIONS.map((t) => [key(t), t]))('allows %s', (_, move) => {
    expect(canTransition(move.from, move.to, move.actor, contextFor(move))).toEqual({
      allowed: true,
      action: move.action,
    });
  });

  it('includes docs_requested → rejected (landlord) but NOT offered → withdrawn', () => {
    expect(canTransition('DOCS_REQUESTED', 'REJECTED', 'LISTING_OWNER').allowed).toBe(true);
    const withdraw = canTransition('OFFERED', 'WITHDRAWN', 'GROUP_MEMBER', BEFORE);
    expect(withdraw).toMatchObject({ allowed: false, code: 'ILLEGAL_TRANSITION' });
  });
});

describe('canTransition(): illegal moves', () => {
  it.each([
    ['SUBMITTED', 'OFFERED'],
    ['SUBMITTED', 'ACCEPTED'],
    ['UNDER_REVIEW', 'ACCEPTED'],
    ['UNDER_REVIEW', 'DOCS_REQUESTED'],
    ['DOCS_REQUESTED', 'OFFERED'],
    ['DOCS_REQUESTED', 'UNDER_REVIEW'],
    ['OFFERED', 'REJECTED'],
    ['OFFERED', 'SUBMITTED'],
    [null, 'OFFERED'],
    ['SUBMITTED', 'SUBMITTED'],
    ['OFFERED', 'OFFERED'],
  ])('refuses %s → %s for every actor', (from, to) => {
    for (const actor of ALL_ACTORS) {
      const result = canTransition(from, to, actor, BEFORE);
      expect(result, `${actor}`).toMatchObject({ allowed: false, code: 'ILLEGAL_TRANSITION' });
      expect(result.reason).toMatch(/can't go from/);
    }
  });

  it('refuses unknown states and actors (programming mistakes)', () => {
    expect(canTransition('PENDING', 'SUBMITTED', 'GROUP_MEMBER').code).toBe('UNKNOWN_STATE');
    expect(canTransition('SUBMITTED', 'submitted', 'LISTING_OWNER').code).toBe('UNKNOWN_STATE');
    expect(canTransition('toString', 'SUBMITTED', 'GROUP_MEMBER').code).toBe('UNKNOWN_STATE');
    expect(canTransition(undefined, 'SUBMITTED', 'GROUP_MEMBER').code).toBe('UNKNOWN_STATE');
    expect(canTransition('SUBMITTED', 'UNDER_REVIEW', 'ADMIN').code).toBe('UNKNOWN_ACTOR');
  });
});

describe('canTransition(): wrong actor', () => {
  const cases = TRANSITIONS.flatMap((t) =>
    ALL_ACTORS.filter((a) => a !== t.actor).map((wrong) => [key(t), wrong, t]),
  );
  it.each(cases)('%s is refused for %s', (_, wrongActor, move) => {
    const result = canTransition(move.from, move.to, wrongActor, contextFor(move));
    expect(result).toMatchObject({ allowed: false, code: 'WRONG_ACTOR' });
    expect(result.reason).toMatch(
      /^Only (a member of the applying group|the listing owner|the system \(when the deadline passes\)) can [a-z ]+\.$/,
    );
  });

  it('names who may act in plain English', () => {
    expect(canTransition('UNDER_REVIEW', 'OFFERED', 'GROUP_MEMBER').reason).toBe(
      'Only the listing owner can make an offer.',
    );
    expect(canTransition('OFFERED', 'ACCEPTED', 'LISTING_OWNER', BEFORE).reason).toBe(
      'Only a member of the applying group can accept an offer.',
    );
    expect(canTransition('OFFERED', 'EXPIRED', 'GROUP_MEMBER', AT).reason).toBe(
      'Only the system (when the deadline passes) can expire an offer.',
    );
  });

  it('every move has a message phrase (never "can undefined")', () => {
    for (const t of TRANSITIONS) {
      const wrong = ALL_ACTORS.find((a) => a !== t.actor);
      expect(canTransition(t.from, t.to, wrong, contextFor(t)).reason).not.toMatch(/undefined/);
    }
  });
});

describe('canTransition(): final states', () => {
  it('final states are exactly accepted, declined, expired, rejected, withdrawn', () => {
    expect([...FINAL_STATES].sort()).toEqual(
      ['ACCEPTED', 'DECLINED', 'EXPIRED', 'REJECTED', 'WITHDRAWN'].sort(),
    );
    expect(TRANSITIONS.some((t) => isFinal(t.from))).toBe(false);
  });

  it.each(FINAL_STATES)('%s allows no further move, by anyone', (final) => {
    expect(isFinal(final)).toBe(true);
    for (const to of ALL_STATES) {
      for (const actor of ALL_ACTORS) {
        const result = canTransition(final, to, actor, BEFORE);
        expect(result, `${final} → ${to} by ${actor}`).toMatchObject({
          allowed: false,
          code: 'FINAL_STATE',
        });
      }
    }
    expect(allowedMoves(final, 'GROUP_MEMBER')).toEqual([]);
  });

  it('open states are not final', () => {
    for (const s of ['SUBMITTED', 'DOCS_REQUESTED', 'UNDER_REVIEW', 'OFFERED']) {
      expect(isFinal(s)).toBe(false);
    }
  });
});

describe('offer deadline', () => {
  it('isOfferExpired: 1 ms before → no; exactly at the deadline → yes; 1 ms after → yes', () => {
    expect(isOfferExpired(DEADLINE, ms(-1))).toBe(false);
    expect(isOfferExpired(DEADLINE, DEADLINE)).toBe(true);
    expect(isOfferExpired(DEADLINE, ms(1))).toBe(true);
  });

  it('isOfferExpired rejects missing or invalid dates', () => {
    expect(() => isOfferExpired(null, DEADLINE)).toThrow(TypeError);
    expect(() => isOfferExpired(DEADLINE, undefined)).toThrow(TypeError);
    expect(() => isOfferExpired('2027-03-01', DEADLINE)).toThrow(TypeError);
    expect(() => isOfferExpired(new Date('nope'), DEADLINE)).toThrow(TypeError);
  });

  it('accept: allowed 1 ms before the deadline, refused exactly at it and after', () => {
    expect(canTransition('OFFERED', 'ACCEPTED', 'GROUP_MEMBER', BEFORE).allowed).toBe(true);
    for (const ctx of [AT, AFTER]) {
      expect(canTransition('OFFERED', 'ACCEPTED', 'GROUP_MEMBER', ctx)).toMatchObject({
        allowed: false,
        code: 'OFFER_EXPIRED',
      });
    }
  });

  it('expire offer (system): refused before the deadline, allowed exactly at it and after', () => {
    expect(canTransition('OFFERED', 'EXPIRED', 'SYSTEM', BEFORE)).toMatchObject({
      allowed: false,
      code: 'OFFER_NOT_EXPIRED',
    });
    expect(canTransition('OFFERED', 'EXPIRED', 'SYSTEM', AT).allowed).toBe(true);
    expect(canTransition('OFFERED', 'EXPIRED', 'SYSTEM', AFTER).allowed).toBe(true);
  });

  it('accept and expire REQUIRE the deadline context (MISSING_DEADLINE otherwise)', () => {
    for (const ctx of [undefined, {}, { now: DEADLINE }, { offerExpiresAt: DEADLINE }]) {
      expect(canTransition('OFFERED', 'ACCEPTED', 'GROUP_MEMBER', ctx).code).toBe(
        'MISSING_DEADLINE',
      );
      expect(canTransition('OFFERED', 'EXPIRED', 'SYSTEM', ctx).code).toBe('MISSING_DEADLINE');
    }
  });

  it.each([
    [
      'a string deadline (e.g. ISO text from JSON)',
      { offerExpiresAt: DEADLINE.toISOString(), now: ms(-1) },
    ],
    ['an invalid Date', { offerExpiresAt: new Date('not a date'), now: ms(-1) }],
    ['a missing "now"', { offerExpiresAt: DEADLINE }],
    ['a string "now"', { offerExpiresAt: DEADLINE, now: '2027-03-01T16:00:00Z' }],
  ])('%s → MISSING_DEADLINE with a plain-English reason, never a throw', (_, ctx) => {
    let accept;
    let expire;
    expect(() => {
      accept = canTransition('OFFERED', 'ACCEPTED', 'GROUP_MEMBER', ctx);
      expire = canTransition('OFFERED', 'EXPIRED', 'SYSTEM', ctx);
    }).not.toThrow();
    expect(accept).toEqual({
      allowed: false,
      code: 'MISSING_DEADLINE',
      reason:
        'To accept an offer, the offer deadline and the current time must both be valid dates.',
    });
    expect(expire).toEqual({
      allowed: false,
      code: 'MISSING_DEADLINE',
      reason:
        'To expire an offer, the offer deadline and the current time must both be valid dates.',
    });
  });

  it('other moves from OFFERED do not need the deadline context', () => {
    expect(canTransition('OFFERED', 'DECLINED', 'GROUP_MEMBER').allowed).toBe(true);
    expect(canTransition('OFFERED', 'UNDER_REVIEW', 'LISTING_OWNER').allowed).toBe(true);
  });
});

describe('allowedMoves()', () => {
  it('lists the buttons each actor would see', () => {
    expect(allowedMoves('OFFERED', 'GROUP_MEMBER')).toEqual([
      { to: 'ACCEPTED', action: 'accept' },
      { to: 'DECLINED', action: 'decline' },
    ]);
    expect(allowedMoves('SUBMITTED', 'LISTING_OWNER').map((m) => m.action)).toEqual([
      'request documents',
      'start review',
      'reject',
    ]);
    expect(allowedMoves(null, 'GROUP_MEMBER')).toEqual([{ to: 'SUBMITTED', action: 'submit' }]);
    expect(allowedMoves('OFFERED', 'SYSTEM')).toEqual([{ to: 'EXPIRED', action: 'expire offer' }]);
  });
});

describe('groupFitsUnit()', () => {
  it('fits when the group size equals the beds, not when it is one more', () => {
    expect(groupFitsUnit(4, { beds: 4, bedrooms: 4 })).toEqual({ ok: true, capacity: 4 });
    const tooBig = groupFitsUnit(5, { beds: 4, bedrooms: 4 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.reason).toBe('This unit fits 4 people, but the group has 5.');
  });

  it('uses beds before bedrooms (2 bedrooms with 4 beds fits 4)', () => {
    expect(groupFitsUnit(4, { beds: 4, bedrooms: 2 })).toEqual({ ok: true, capacity: 4 });
    expect(groupFitsUnit(3, { beds: 2, bedrooms: 3 }).ok).toBe(false);
  });

  it('falls back to bedrooms when beds is null or missing', () => {
    expect(groupFitsUnit(3, { beds: null, bedrooms: 3 })).toEqual({ ok: true, capacity: 3 });
    expect(groupFitsUnit(3, { bedrooms: 3 })).toEqual({ ok: true, capacity: 3 });
    expect(groupFitsUnit(4, { bedrooms: 3 }).ok).toBe(false);
  });

  it('handles 1 person and a 16-person group', () => {
    expect(groupFitsUnit(1, { beds: 1 })).toEqual({ ok: true, capacity: 1 });
    expect(groupFitsUnit(1, { beds: 1 }).ok).toBe(true);
    expect(groupFitsUnit(2, { beds: 1 }).reason).toBe(
      'This unit fits 1 person, but the group has 2.',
    );
    expect(groupFitsUnit(16, { beds: 16 }).ok).toBe(true);
    expect(groupFitsUnit(16, { beds: 15 }).ok).toBe(false);
  });

  it('refuses a group size that is not a whole number of at least 1', () => {
    for (const size of [0, -1, 2.5, '3', null, undefined, NaN]) {
      expect(groupFitsUnit(size, { beds: 4 }), String(size)).toEqual({
        ok: false,
        reason: 'The group must have at least one member.',
      });
    }
  });

  it("refuses a unit that doesn't say how many people it fits", () => {
    for (const unit of [{}, { beds: null, bedrooms: null }, { beds: 0 }, null, undefined]) {
      expect(groupFitsUnit(2, unit)).toEqual({
        ok: false,
        reason: "This unit doesn't list how many people it fits.",
      });
    }
  });
});
