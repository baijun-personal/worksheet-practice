// Local arithmetic / fraction computation for the Calculator tool.
// The model parses the image into a structured JSON shape; this
// module validates that shape and computes the result locally —
// no math comes from the model. Keeps the model's role narrow
// (vision-only "read the math") and makes the answer deterministic.
//
// Stage 5 covers arithmetic only. Stages 10–11 (deferred) add
// linear_1var and linear_2var.

const MAX_OPERAND = 1e9;       // sanity bound; primary-school math won't exceed
const ALLOWED_OPS = new Set(['+', '-', '*', '/']);
const ALLOWED_TYPES_MVP = new Set(['arithmetic', 'out_of_scope', 'unreadable']);

// Validate the model's parsed JSON before computing. Treat the
// response as untrusted: type / op / operand shapes / magnitudes
// all gated. Returns { ok: true } or { ok: false, reason }.
export function validateParsedCalc(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Empty parse response.' };
  }
  if (!ALLOWED_TYPES_MVP.has(parsed.type)) {
    return { ok: false, reason: `Unrecognised type: ${parsed.type}` };
  }
  if (parsed.type === 'out_of_scope' || parsed.type === 'unreadable') {
    return { ok: true };
  }
  if (parsed.type === 'arithmetic') {
    if (!ALLOWED_OPS.has(parsed.op)) {
      return { ok: false, reason: `Unrecognised operator: ${parsed.op}` };
    }
    if (!Array.isArray(parsed.operands) || parsed.operands.length !== 2) {
      return { ok: false, reason: 'Need exactly two operands.' };
    }
    for (const x of parsed.operands) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        return { ok: false, reason: 'Operands must be finite numbers.' };
      }
      if (Math.abs(x) > MAX_OPERAND) {
        return { ok: false, reason: 'Operand too large.' };
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: 'Type not implemented.' };
}

// Render the user-facing input string from the parsed shape so the
// popup can show what the model thought it saw. Keeps spaces
// consistent and uses the user-visible operator symbols.
export function stringifyParsedInput(parsed) {
  if (!parsed) return '';
  if (parsed.type !== 'arithmetic') return '';
  const [a, b] = parsed.operands || [];
  const opSymbol = { '+': '+', '-': '−', '*': '×', '/': '÷' }[parsed.op] || parsed.op;
  return `${formatNumber(a)} ${opSymbol} ${formatNumber(b)}`;
}

// Compute the result of a validated arithmetic expression. Returns
// { ok: true, type, forms: [{label, value}, …] } on success, or
// { ok: false, reason } on a runtime issue (e.g. division by zero).
export function computeArithmetic({ op, operands }) {
  const [a, b] = operands;
  switch (op) {
    case '+':
      return {
        ok: true,
        type: 'arithmetic_sum',
        forms: [{ label: 'sum', value: formatNumber(a + b) }],
      };
    case '-':
      return {
        ok: true,
        type: 'arithmetic_difference',
        forms: [{ label: 'difference', value: formatNumber(a - b) }],
      };
    case '*':
      return {
        ok: true,
        type: 'arithmetic_product',
        forms: [{ label: 'product', value: formatNumber(a * b) }],
      };
    case '/':
      if (b === 0) return { ok: false, reason: 'Division by zero.' };
      return {
        ok: true,
        type: 'arithmetic_division',
        forms: computeDivisionForms(a, b),
      };
    default:
      return { ok: false, reason: `Unrecognised operator: ${op}` };
  }
}

// Division forms per the tightened rules:
//   integer ÷ integer → decimal + quotient-remainder + simplified fraction
//   decimal involved  → decimal + simplified fraction (via rational
//                       conversion); NO quotient-remainder
function computeDivisionForms(a, b) {
  const isIntPair = Number.isInteger(a) && Number.isInteger(b);
  const decimal = formatNumber(a / b);

  if (isIntPair) {
    const quotient = Math.trunc(a / b);
    const remainder = a - quotient * b;
    const remForm = remainder === 0
      ? String(quotient)
      : `${quotient} r ${Math.abs(remainder)}`;
    const fraction = simplifyFraction(a, b);
    return [
      { label: 'decimal', value: decimal },
      { label: 'remainder', value: remForm },
      { label: 'fraction', value: fraction },
    ];
  }

  // Decimal case — convert to rational by scaling, then simplify.
  // Skip the remainder form (only meaningful for integer pairs).
  const rational = toRational(a, b);
  if (rational) {
    return [
      { label: 'decimal', value: decimal },
      { label: 'fraction', value: simplifyFraction(rational.num, rational.den) },
    ];
  }
  // Couldn't produce a clean rational — show decimal only.
  return [{ label: 'decimal', value: decimal }];
}

function toRational(a, b) {
  // 2.4 / 0.6 → multiply both by 10 → 24 / 6 → simplify
  const decPlaces = (n) => {
    const s = String(n);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  };
  const scale = 10 ** Math.max(decPlaces(a), decPlaces(b));
  const num = Math.round(a * scale);
  const den = Math.round(b * scale);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return { num, den };
}

function simplifyFraction(a, b) {
  const sign = ((a < 0) !== (b < 0)) ? -1 : 1;
  const A = Math.abs(a);
  const B = Math.abs(b);
  const g = gcd(A, B) || 1;
  const num = sign * (A / g);
  const den = B / g;
  return den === 1 ? `${num}` : `${num}/${den}`;
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function formatNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  // Trim trailing zeros after rounding to 4dp.
  return Number(n.toFixed(4)).toString();
}
