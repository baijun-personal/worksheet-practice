// Local arithmetic / fraction / linear-equation computation for the
// Calculator tool. The model parses the image into a structured
// JSON shape; this module validates that shape and computes the
// result locally — no math comes from the model. Keeps the
// model's role narrow (vision-only "read the math") and makes the
// answer deterministic.
//
// Stage 5  covers arithmetic.
// Stage 10 covers linear_1var  — single linear equation in one
//                                variable, e.g. "2x + 3 = 5x - 1".
// Stage 11 covers linear_2var  — system of two linear equations
//                                in two variables, solved by
//                                Cramer's rule.

const MAX_OPERAND = 1e9;       // sanity bound; primary-school math won't exceed
const ALLOWED_OPS = new Set(['+', '-', '*', '/']);
const ALLOWED_TYPES_MVP = new Set([
  'arithmetic', 'linear_1var', 'linear_2var', 'out_of_scope', 'unreadable',
]);

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
  if (parsed.type === 'linear_1var') {
    if (!parsed.var || typeof parsed.var !== 'string') {
      return { ok: false, reason: 'Missing variable name.' };
    }
    for (const side of ['lhs', 'rhs']) {
      const s = parsed[side];
      if (!s || typeof s !== 'object') {
        return { ok: false, reason: `Missing ${side}.` };
      }
      for (const k of ['coef', 'const']) {
        const v = s[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, reason: `${side}.${k} must be a finite number.` };
        }
        if (Math.abs(v) > MAX_OPERAND) {
          return { ok: false, reason: `${side}.${k} too large.` };
        }
      }
    }
    return { ok: true };
  }
  if (parsed.type === 'linear_2var') {
    if (!Array.isArray(parsed.vars) || parsed.vars.length !== 2
        || !parsed.vars.every((v) => typeof v === 'string' && v)) {
      return { ok: false, reason: 'Need exactly two variable names.' };
    }
    if (!Array.isArray(parsed.equations) || parsed.equations.length !== 2) {
      return { ok: false, reason: 'Need exactly two equations.' };
    }
    for (const eq of parsed.equations) {
      if (!eq || typeof eq !== 'object') {
        return { ok: false, reason: 'Equation missing.' };
      }
      for (const k of ['a', 'b', 'c']) {
        const v = eq[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, reason: `Equation ${k} must be a finite number.` };
        }
        if (Math.abs(v) > MAX_OPERAND) {
          return { ok: false, reason: `Equation ${k} too large.` };
        }
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
  if (parsed.type === 'arithmetic') {
    const [a, b] = parsed.operands || [];
    const opSymbol = { '+': '+', '-': '−', '*': '×', '/': '÷' }[parsed.op] || parsed.op;
    return `${formatNumber(a)} ${opSymbol} ${formatNumber(b)}`;
  }
  if (parsed.type === 'linear_1var') {
    return `${formatLinearSide(parsed.lhs, parsed.var)} = ${formatLinearSide(parsed.rhs, parsed.var)}`;
  }
  if (parsed.type === 'linear_2var') {
    const [vx, vy] = parsed.vars || ['x', 'y'];
    return (parsed.equations || [])
      .map((eq) => `${formatBivariateLhs(eq, vx, vy)} = ${formatNumber(eq.c)}`)
      .join('; ');
  }
  return '';
}

// "2x + 3" / "−x" / "5" — render a one-variable side from
// { coef, const }. Drops zero terms; doesn't print "1x" (just "x").
function formatLinearSide(side, varName) {
  const v = varName || 'x';
  const coef = side?.coef ?? 0;
  const k = side?.const ?? 0;
  const varTerm = coef === 0
    ? ''
    : (coef === 1 ? v : (coef === -1 ? `−${v}` : `${formatNumber(coef)}${v}`));
  if (!varTerm) return formatNumber(k);
  if (k === 0) return varTerm;
  const sign = k > 0 ? ' + ' : ' − ';
  return `${varTerm}${sign}${formatNumber(Math.abs(k))}`;
}

// "2x + 3y" / "x − y" — render the left side of a 2-variable
// equation in ax + by = c form.
function formatBivariateLhs(eq, vx, vy) {
  const a = eq?.a ?? 0;
  const b = eq?.b ?? 0;
  const termA = a === 0 ? '' : (a === 1 ? vx : (a === -1 ? `−${vx}` : `${formatNumber(a)}${vx}`));
  if (b === 0) return termA || '0';
  const absB = Math.abs(b);
  const sign = b > 0 ? (termA ? ' + ' : '') : (termA ? ' − ' : '−');
  const bMag = absB === 1 ? vy : `${formatNumber(absB)}${vy}`;
  return `${termA}${sign}${bMag}`;
}

// Solve a single linear equation in one variable.
//
// Input shape (validated upstream):
//   { type: 'linear_1var', var, lhs: {coef, const}, rhs: {coef, const} }
// meaning  lhs.coef * var + lhs.const  =  rhs.coef * var + rhs.const
//
// Standard form is computed here:
//   A * var = B   where A = lhs.coef - rhs.coef, B = rhs.const - lhs.const
// then var = B / A.
//
// Edge cases:
//   A == 0, B == 0  → identity (any value satisfies). Refuse rather
//                     than return "x = anything" — the parent would
//                     have to read the model's reasoning to know that
//                     and the popup has no good way to show it.
//   A == 0, B != 0  → contradiction (no solution). Same treatment.
//
// Returns the standard forms shape:
//   { ok, type: 'linear_1var', forms: [{label: var, value}, …] }
// For integer-coef equations whose answer isn't a whole number we
// also include a 'fraction' form (e.g. x = 5/2) for readability.
export function computeLinear1Var(parsed) {
  const v = parsed.var || 'x';
  const lhsCoef = parsed.lhs?.coef ?? 0;
  const lhsConst = parsed.lhs?.const ?? 0;
  const rhsCoef = parsed.rhs?.coef ?? 0;
  const rhsConst = parsed.rhs?.const ?? 0;
  const A = lhsCoef - rhsCoef;
  const B = rhsConst - lhsConst;
  if (A === 0) {
    if (B === 0) return { ok: false, reason: 'Identity — any value of ' + v + ' satisfies this.' };
    return { ok: false, reason: 'No solution (the equation is a contradiction).' };
  }
  const value = B / A;
  const forms = [{ label: v, value: formatNumber(value) }];
  // Add a fraction form when the answer is a clean rational with a
  // non-trivial denominator. Integer coefficients give an exact
  // a/b that's nicer to read than "0.6667".
  if (Number.isInteger(A) && Number.isInteger(B) && B % A !== 0) {
    forms.push({ label: 'fraction', value: simplifyFraction(B, A) });
  }
  return { ok: true, type: 'linear_1var', forms };
}

// Solve a system of two linear equations in two unknowns via
// Cramer's rule.
//
// Input shape (validated upstream):
//   { type: 'linear_2var', vars: [vx, vy],
//     equations: [ {a, b, c}, {a, b, c} ] }
// each equation interpreted as  a * vx + b * vy = c.
//
// det = a1*b2 - a2*b1.
//   det == 0  → either no solution (parallel lines) or infinite
//               (identical lines). Either way refuse — the popup
//               doesn't have a good rendering for "any line".
// Otherwise:
//   vx = (c1*b2 - c2*b1) / det
//   vy = (a1*c2 - a2*c1) / det
export function computeLinear2Var(parsed) {
  const eqs = parsed.equations || [];
  if (eqs.length !== 2) return { ok: false, reason: 'Need exactly two equations.' };
  const [vx, vy] = parsed.vars || ['x', 'y'];
  const a1 = eqs[0].a, b1 = eqs[0].b, c1 = eqs[0].c;
  const a2 = eqs[1].a, b2 = eqs[1].b, c2 = eqs[1].c;
  const det = a1 * b2 - a2 * b1;
  if (det === 0) {
    return { ok: false, reason: 'No unique solution — lines are parallel or identical.' };
  }
  const xNum = c1 * b2 - c2 * b1;
  const yNum = a1 * c2 - a2 * c1;
  const xVal = xNum / det;
  const yVal = yNum / det;
  const forms = [
    { label: vx, value: formatNumber(xVal) },
    { label: vy, value: formatNumber(yVal) },
  ];
  // Fraction forms when integer system gives non-integer answer.
  const allInt = [a1, b1, c1, a2, b2, c2].every(Number.isInteger);
  if (allInt) {
    if (xNum % det !== 0) forms.push({ label: `${vx} (fraction)`, value: simplifyFraction(xNum, det) });
    if (yNum % det !== 0) forms.push({ label: `${vy} (fraction)`, value: simplifyFraction(yNum, det) });
  }
  return { ok: true, type: 'linear_2var', forms };
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
