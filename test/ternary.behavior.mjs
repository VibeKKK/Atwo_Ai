// test/ternary.behavior.mjs - behavioural cases for vm/ternary.mjs.
// Each case: { name, call } where call() returns true on success
// and throws (or returns false) on failure.

import {
  toTrits,
  fromTrits,
  addTrits,
  negTrits,
  mulTrits,
  roundTrits,
  formatTrits,
} from '../vm/ternary.mjs';

function fail(message) {
  throw new Error(message);
}

function eqTrits(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
  return true;
}

function eqInt(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  return true;
}

function eqStr(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected "${expected}", got "${actual}"`);
  return true;
}

function assertDigits(ts, label) {
  if (!Array.isArray(ts)) fail(`${label}: not an array`);
  for (let i = 0; i < ts.length; i += 1) {
    if (ts[i] !== -1 && ts[i] !== 0 && ts[i] !== 1) {
      fail(`${label}: digit ${i} is ${ts[i]}, outside {-1,0,1}`);
    }
  }
  return true;
}

const VALUES = [
  0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 9, -9, 13, -13, 40, -40,
  2 ** 31, -(2 ** 31),
];

export const cases = [
  // --- toTrits: value 0 / ±1 / ±2 ---
  {
    name: 'toTrits(0) returns [0], not an empty array',
    call: () => {
      const ts = toTrits(0);
      if (!Array.isArray(ts) || ts.length !== 1) fail(`toTrits(0) => ${JSON.stringify(ts)}`);
      return eqTrits(ts, [0], 'toTrits(0)');
    },
  },
  { name: 'toTrits(1) = [1]', call: () => eqTrits(toTrits(1), [1], 'toTrits(1)') },
  { name: 'toTrits(-1) = [-1]', call: () => eqTrits(toTrits(-1), [-1], 'toTrits(-1)') },
  { name: 'toTrits(2) = [-1,1]', call: () => eqTrits(toTrits(2), [-1, 1], 'toTrits(2)') },
  { name: 'toTrits(-2) = [1,-1]', call: () => eqTrits(toTrits(-2), [1, -1], 'toTrits(-2)') },

  // --- the two documented examples ---
  {
    name: 'toTrits(5) = [-1,-1,1]',
    call: () => eqTrits(toTrits(5), [-1, -1, 1], 'toTrits(5)'),
  },
  {
    name: 'toTrits(-5) = [1,1,-1] (balanced, not sign-magnitude)',
    call: () => {
      const ts = toTrits(-5);
      eqTrits(ts, [1, 1, -1], 'toTrits(-5)');
      assertDigits(ts, 'toTrits(-5)');
      return true;
    },
  },

  // --- large magnitudes ---
  {
    name: 'toTrits(2**31) round-trips and stays in {-1,0,1}',
    call: () => {
      const ts = toTrits(2 ** 31);
      assertDigits(ts, 'toTrits(2**31)');
      return eqInt(fromTrits(ts), 2 ** 31, 'round-trip 2**31');
    },
  },
  {
    name: 'toTrits(-(2**31)) round-trips and stays in {-1,0,1}',
    call: () => {
      const ts = toTrits(-(2 ** 31));
      assertDigits(ts, 'toTrits(-(2**31))');
      return eqInt(fromTrits(ts), -(2 ** 31), 'round-trip -(2**31)');
    },
  },

  // --- round-trip consistency ---
  {
    name: 'fromTrits(toTrits(n)) === n for the boundary value set',
    call: () => {
      for (const n of VALUES) eqInt(fromTrits(toTrits(n)), n, `round-trip ${n}`);
      return true;
    },
  },
  {
    name: 'fromTrits(toTrits(n)) === n for -60..60',
    call: () => {
      for (let n = -60; n <= 60; n += 1) eqInt(fromTrits(toTrits(n)), n, `round-trip ${n}`);
      return true;
    },
  },
  {
    name: 'fromTrits handles leading zeros and single zero',
    call: () => {
      eqInt(fromTrits([0, 0, 0]), 0, 'fromTrits([0,0,0])');
      return eqInt(fromTrits([1, 0, 0]), 1, 'fromTrits([1,0,0])');
    },
  },

  // --- addition: carry chain ---
  {
    name: 'addTrits([1,1] (4) + [1] (1) = 5 through the carry chain',
    call: () => {
      const sum = addTrits([1, 1], [1]);
      assertDigits(sum, 'carry-chain sum');
      eqTrits(sum, [-1, -1, 1], 'carry-chain sum');
      return eqInt(fromTrits(sum), 5, 'carry-chain value');
    },
  },
  {
    name: 'addTrits([1] + [1]) = [-1,1] (2, carry out of the low trit)',
    call: () => {
      const sum = addTrits([1], [1]);
      assertDigits(sum, 'add 1+1');
      return eqTrits(sum, [-1, 1], 'add 1+1');
    },
  },
  {
    name: 'addTrits([-1] + [-1]) = [1,-1] (-2)',
    call: () => {
      const sum = addTrits([-1], [-1]);
      assertDigits(sum, 'add -1+-1');
      return eqTrits(sum, [1, -1], 'add -1+-1');
    },
  },
  {
    name: 'addTrits produces no digit outside {-1,0,1} across a value grid',
    call: () => {
      const ns = [-9, -5, -2, -1, 0, 1, 2, 5, 9, 2 ** 31, -(2 ** 31)];
      for (const x of ns) {
        for (const y of ns) {
          const sum = addTrits(toTrits(x), toTrits(y));
          assertDigits(sum, `add ${x}+${y}`);
          eqInt(fromTrits(sum), x + y, `add ${x}+${y}`);
        }
      }
      return true;
    },
  },
  {
    name: 'addTrits is commutative and associative',
    call: () => {
      const a = toTrits(37);
      const b = toTrits(-11);
      const c = toTrits(6);
      eqTrits(addTrits(a, b), addTrits(b, a), 'commutativity');
      eqTrits(addTrits(addTrits(a, b), c), addTrits(a, addTrits(b, c)), 'associativity');
      return true;
    },
  },
  {
    name: 'addTrits(a, negTrits(a)) = [0]',
    call: () => {
      for (const n of VALUES) {
        const zero = addTrits(toTrits(n), negTrits(toTrits(n)));
        eqTrits(zero, [0], `cancel ${n}`);
      }
      return true;
    },
  },

  // --- negation ---
  {
    name: 'negTrits flips every trit',
    call: () => {
      eqTrits(negTrits([1, 0, -1]), [-1, 0, 1], 'negTrits([1,0,-1])');
      return eqTrits(negTrits(toTrits(5)), toTrits(-5), 'negTrits(5) = -5');
    },
  },

  // --- multiplication ---
  {
    name: 'mulTrits(x, [0]) is [0] for every x (zero absorbs)',
    call: () => {
      for (const n of VALUES) {
        eqTrits(mulTrits(toTrits(n), [0]), [0], `mul ${n}*0`);
        eqTrits(mulTrits([0], toTrits(n)), [0], `mul 0*${n}`);
      }
      return true;
    },
  },
  {
    name: 'mulTrits([-1], [-1]) = [1]',
    call: () => eqTrits(mulTrits([-1], [-1]), [1], 'mulTrits([-1],[-1])'),
  },
  {
    name: 'mulTrits([-1], [1]) = [-1] and mulTrits([1],[1]) = [1]',
    call: () => {
      eqTrits(mulTrits([-1], [1]), [-1], 'mul -1*1');
      return eqTrits(mulTrits([1], [1]), [1], 'mul 1*1');
    },
  },
  {
    name: 'mulTrits(3, 4) = 12 and signs behave',
    call: () => {
      const twelve = mulTrits(toTrits(3), toTrits(4));
      assertDigits(twelve, '3*4');
      eqInt(fromTrits(twelve), 12, '3*4');
      eqInt(fromTrits(mulTrits(toTrits(-3), toTrits(4))), -12, '-3*4');
      return eqInt(fromTrits(mulTrits(toTrits(-3), toTrits(-4))), 12, '-3*-4');
    },
  },
  {
    name: 'mulTrits matches integer multiplication across a grid',
    call: () => {
      const ns = [-9, -5, -2, -1, 0, 1, 2, 5, 9];
      for (const x of ns) {
        for (const y of ns) {
          const p = mulTrits(toTrits(x), toTrits(y));
          assertDigits(p, `mul ${x}*${y}`);
          eqInt(fromTrits(p), x * y, `mul ${x}*${y}`);
        }
      }
      return true;
    },
  },

  // --- rounding / lowest-trit truncation ---
  {
    name: 'roundTrits drops the lowest trit',
    call: () => {
      eqTrits(roundTrits([-1, -1, 1]), [-1, 1], 'round 5 -> 2');
      return eqInt(fromTrits(roundTrits(toTrits(5))), 2, 'round 5');
    },
  },
  {
    name: 'roundTrits of a single trit is [0]',
    call: () => {
      eqTrits(roundTrits([1]), [0], 'round [1]');
      eqTrits(roundTrits([-1]), [0], 'round [-1]');
      return eqTrits(roundTrits([0]), [0], 'round [0]');
    },
  },
  {
    name: 'roundTrits(3) = 1 and roundTrits(-3) = -1',
    call: () => {
      eqInt(fromTrits(roundTrits(toTrits(3))), 1, 'round 3');
      return eqInt(fromTrits(roundTrits(toTrits(-3))), -1, 'round -3');
    },
  },

  // --- formatting ---
  {
    name: 'formatTrits(5) = "+--" and formatTrits(-5) = "-++"',
    call: () => {
      eqStr(formatTrits(toTrits(5)), '+--', 'format 5');
      return eqStr(formatTrits(toTrits(-5)), '-++', 'format -5');
    },
  },
  {
    name: 'formatTrits shows interior zeros: 3 -> "+0"',
    call: () => {
      eqStr(formatTrits(toTrits(3)), '+0', 'format 3');
      return eqStr(formatTrits([0]), '0', 'format zero');
    },
  },
];
