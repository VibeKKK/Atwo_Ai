// vm/ternary.mjs - balanced ternary arithmetic kernel.
// Digit set { -1, 0, +1 }, least-significant trit first. Zero dependencies.
//
//   5  = [ -1, -1, +1 ]   because -1*1 + -1*3 + 1*9 = 5
//   -5 = [ +1, +1, -1 ]
//
// Every routine keeps digits inside {-1, 0, 1}: carries are resolved one trit
// at a time, so no intermediate value ever leaves the digit set.

const MIN_TRIT = -1;
const MAX_TRIT = 1;

function assertTrit(t, where) {
  if (t !== -1 && t !== 0 && t !== 1) {
    throw new RangeError(`${where}: trit must be -1, 0 or 1, got ${t}`);
  }
  return t;
}

function assertTrits(ts, where) {
  if (!Array.isArray(ts)) {
    throw new TypeError(`${where}: expected an array of trits`);
  }
  for (let i = 0; i < ts.length; i += 1) assertTrit(ts[i], `${where}[${i}]`);
  return ts;
}

// Drop redundant high-order zeros; a balanced-ternary number keeps >= 1 trit.
function trim(ts) {
  let end = ts.length;
  while (end > 1 && ts[end - 1] === 0) end -= 1;
  return end === ts.length ? ts : ts.slice(0, end);
}

function isZero(ts) {
  for (let i = 0; i < ts.length; i += 1) {
    if (ts[i] !== 0) return false;
  }
  return true;
}

// Integer -> trits. Negative numbers come out balanced, never sign-magnitude:
// the remainder is folded into {-1, 0, 1} and the leftover goes to the quotient.
export function toTrits(n) {
  if (!Number.isInteger(n)) {
    throw new TypeError(`toTrits: expected an integer, got ${n}`);
  }
  if (n === 0) return [0];
  const out = [];
  let rest = n;
  while (rest !== 0) {
    let r = rest % 3;
    if (r === 2) r = -1;
    else if (r === -2) r = 1;
    else if (r === 0) r = 0; // normalise -0 from the modulo
    rest = (rest - r) / 3; // exact: rest - r is always a multiple of 3
    out.push(r);
  }
  return out;
}

// Trits -> integer, folded from the most significant trit down (no powers).
export function fromTrits(ts) {
  assertTrits(ts, 'fromTrits');
  let acc = 0;
  for (let i = ts.length - 1; i >= 0; i -= 1) acc = acc * 3 + ts[i];
  return acc === 0 ? 0 : acc;
}

export function negTrits(a) {
  assertTrits(a, 'negTrits');
  return a.map((t) => -t);
}

// Trits-only addition with ripple carry. Never leaves {-1, 0, 1}.
export function addTrits(a, b) {
  assertTrits(a, 'addTrits.a');
  assertTrits(b, 'addTrits.b');
  const len = Math.max(a.length, b.length, 1);
  const out = new Array(len);
  let carry = 0;
  for (let i = 0; i < len; i += 1) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    let s = x + y + carry; // -3 .. 3
    if (s > MAX_TRIT) {
      s -= 3;
      carry = 1;
    } else if (s < MIN_TRIT) {
      s += 3;
      carry = -1;
    } else {
      carry = 0;
    }
    out[i] = s;
  }
  if (carry !== 0) out.push(carry);
  return trim(out);
}

// Shift-and-add multiplication: each nonzero trit of b selects a shifted
// copy of a (or its negation), and partial products are summed with addTrits.
export function mulTrits(a, b) {
  assertTrits(a, 'mulTrits.a');
  assertTrits(b, 'mulTrits.b');
  if (isZero(a) || isZero(b)) return [0];
  let acc = [0];
  for (let j = 0; j < b.length; j += 1) {
    const d = b[j];
    if (d === 0) continue;
    const partial = new Array(j).fill(0);
    for (let i = 0; i < a.length; i += 1) partial.push(d * a[i]);
    acc = addTrits(acc, trim(partial));
  }
  return trim(acc);
}

// Dropping the lowest trit is exactly truncating the fraction, which in
// balanced ternary is also round-to-nearest (halves share one digit slot).
export function roundTrits(x) {
  assertTrits(x, 'roundTrits');
  if (x.length <= 1) return [0];
  return trim(x.slice(1));
}

// Human-readable, most significant trit first: 5 -> "+--", -5 -> "-++".
export function formatTrits(ts) {
  assertTrits(ts, 'formatTrits');
  if (ts.length === 0) return '0';
  const glyph = (t) => (t === 1 ? '+' : t === -1 ? '-' : '0');
  let s = '';
  for (let i = ts.length - 1; i >= 0; i -= 1) s += glyph(ts[i]);
  return s;
}
