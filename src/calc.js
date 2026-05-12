// Local arithmetic / fraction / linear-equation computation for the
// Calculator tool. The model parses the image into a structured
// JSON shape; this module validates that shape and computes the
// result locally — no math comes from the model. Keeps the
// model's role narrow (vision-only "read the math") and makes the
// answer deterministic.
//
// Supported types:
//   arithmetic   — two-operand + - × ÷
//   linear_1var  — single linear equation in one variable, e.g.
//                  "2x + 3 = 13" or "3x - 7 = 2x + 5"
//   linear_2var  — system of two linear equations in two
//                  variables, solved by Cramer's rule
//
// The two linear types use a "term-list" shape — each side of the
// equation is an array of { coef, var } terms where `var` is null
// for a pure constant. This matches the natural way the model
// reads handwritten / printed algebra and avoids forcing the
// model to do any normalisation. Local code does all of:
//   - move variable terms to lhs, constants to rhs
//   - check det != 0 / contradictions / identities
//   - compute and render decimal / remainder / fraction forms

const MAX_OPERAND = 1e9;       // sanity bound; primary-school math won't exceed
const MAX_TERMS = 20;          // generous upper bound on terms per side
const ALLOWED_OPS = new Set(['+', '-', '*', '/']);
const ALLOWED_TYPES = new Set([
  'arithmetic', 'linear_1var', 'linear_2var', 'out_of_scope', 'unreadable',
]);

// Validate the model's parsed JSON before computing. Treat the
// response as untrusted: type / op / operand shapes / magnitudes
// all gated. Returns { ok: true } or { ok: false, reason }.
export function validateParsedCalc(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'Empty parse response.' };
  }
  if (!ALLOWED_TYPES.has(parsed.type)) {
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
    if (typeof parsed.variable !== 'string' || !/^[a-z]$/i.test(parsed.variable)) {
      return { ok: false, reason: 'Variable name must be a single letter.' };
    }
    if (!Array.isArray(parsed.lhs) || !Array.isArray(parsed.rhs)) {
      return { ok: false, reason: 'lhs and rhs must be arrays.' };
    }
    if (parsed.lhs.length === 0 || parsed.rhs.length === 0) {
      return { ok: false, reason: 'lhs and rhs cannot be empty.' };
    }
    if (parsed.lhs.length > MAX_TERMS || parsed.rhs.length > MAX_TERMS) {
      return { ok: false, reason: 'Term list too long.' };
    }
    // Variable in every term must either be null (constant) or the
    // declared top-level `variable`. Anything else is the model
    // mixing variables in a "1var" equation — reject.
    const declared = parsed.variable.toLowerCase();
    for (const t of [...parsed.lhs, ...parsed.rhs]) {
      const termCheck = validateTerm(t);
      if (termCheck) return { ok: false, reason: termCheck };
      if (t.var !== null && String(t.var).toLowerCase() !== declared) {
        return { ok: false, reason: `Unexpected variable: ${t.var}` };
      }
    }
    return { ok: true };
  }
  if (parsed.type === 'linear_2var') {
    if (!Array.isArray(parsed.equations) || parsed.equations.length !== 2) {
      return { ok: false, reason: 'Need exactly 2 equations.' };
    }
    const seenVars = new Set();
    for (const eq of parsed.equations) {
      if (!eq || !Array.isArray(eq.lhs) || !Array.isArray(eq.rhs)) {
        return { ok: false, reason: 'Each equation needs lhs and rhs.' };
      }
      if (eq.lhs.length === 0 || eq.rhs.length === 0) {
        return { ok: false, reason: 'lhs and rhs cannot be empty.' };
      }
      if (eq.lhs.length > MAX_TERMS || eq.rhs.length > MAX_TERMS) {
        return { ok: false, reason: 'Term list too long.' };
      }
      for (const t of [...eq.lhs, ...eq.rhs]) {
        const termCheck = validateTerm(t);
        if (termCheck) return { ok: false, reason: termCheck };
        if (t.var !== null) seenVars.add(String(t.var).toLowerCase());
      }
    }
    // Guard against the model producing "linear_2var" where both
    // equations use only one variable — that would actually be two
    // equations in one variable (over-determined or redundant),
    // which is a different solver problem.
    if (seenVars.size !== 2) {
      return { ok: false, reason: `Need exactly 2 distinct variables, found ${seenVars.size}.` };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'Type not implemented.' };
}

// Single-term checker shared by linear_1var and linear_2var.
// Returns a reason string when invalid, null when OK.
function validateTerm(t) {
  if (!t || typeof t !== 'object') return 'Each term must be an object.';
  if (typeof t.coef !== 'number' || !Number.isFinite(t.coef)) {
    return 'Coefficient must be a finite number.';
  }
  if (Math.abs(t.coef) > MAX_OPERAND) {
    return 'Coefficient too large.';
  }
  // var = null means "this term is a constant". Anything else must
  // be a single-letter variable name.
  if (t.var !== null) {
    if (typeof t.var !== 'string' || !/^[a-z]$/i.test(t.var)) {
      return `Variable name must be a single letter: ${t.var}`;
    }
  }
  return null;
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
    return formatLinearEquation(parsed.lhs) + ' = ' + formatLinearEquation(parsed.rhs);
  }
  if (parsed.type === 'linear_2var') {
    return (parsed.equations || []).map((eq) =>
      formatLinearEquation(eq.lhs) + ' = ' + formatLinearEquation(eq.rhs)
    ).join(';  ');
  }
  return '';
}

// Render a term list as a readable algebraic expression, e.g.
// "2x + 3y − 5". Conventions:
//   - First term: include sign only if negative.
//   - Subsequent terms: " + " or " − " from the coefficient sign.
//   - Coefficient 1 / -1 with a variable prints "x" / "−x", not "1x".
//   - Coefficient 0 terms are kept (model can emit them and they're
//     valid algebra), printed as "0". Rare in practice.
//   - Minus sign is U+2212 (−), not hyphen-minus, to match the
//     arithmetic typography (× and ÷) the popup uses elsewhere.
function formatLinearEquation(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return '0';
  let out = '';
  for (let i = 0; i < terms.length; i++) {
    const { coef, var: v } = terms[i];
    const abs = Math.abs(coef);
    let body;
    if (v === null) {
      body = formatNumber(abs);
    } else if (abs === 1) {
      body = String(v);
    } else {
      body = formatNumber(abs) + v;
    }
    if (i === 0) {
      out += (coef < 0 ? '−' : '') + body;
    } else {
      out += (coef < 0 ? ' − ' : ' + ') + body;
    }
  }
  return out;
}

// Solve a single linear equation in one variable.
//
// Move all variable terms to the lhs and all constants to the
// rhs, giving the standard form  a·var = c. Then var = c / a.
//
// Edge cases:
//   a === 0, c === 0  → identity (any value works). Refuse —
//                       the popup has no good way to display
//                       "any value" and primary papers don't
//                       deliberately set this.
//   a === 0, c !== 0  → contradiction. Refuse with a clear
//                       message.
//
// Output uses computeDivisionForms so the answer presents the
// same decimal / remainder / fraction trio as arithmetic
// division — consistent for the user across the two tools.
export function solveLinear1Var(parsed) {
  const v = parsed.variable;
  const lhsX = sumCoefForVar(parsed.lhs, v);
  const lhsC = sumCoefForVar(parsed.lhs, null);
  const rhsX = sumCoefForVar(parsed.rhs, v);
  const rhsC = sumCoefForVar(parsed.rhs, null);
  const a = lhsX - rhsX;
  const c = rhsC - lhsC;

  if (a === 0) {
    return c === 0
      ? { ok: false, reason: `Equation is true for any value of ${v}.` }
      : { ok: false, reason: 'Equation has no solution.' };
  }

  // c / a — re-use the division-forms machine for consistent
  // decimal / remainder / fraction output. Each form gets the
  // "var = …" prefix so the popup reads naturally.
  const divForms = computeDivisionForms(c, a);
  return {
    ok: true,
    type: 'linear_1var',
    forms: divForms.map((f) => ({
      label: f.label,
      value: `${v} = ${f.value}`,
    })),
  };
}

// Solve a 2×2 linear system via Cramer's rule.
//
// Pull both variable names out of the term lists, sort
// alphabetically so output ordering is stable (x before y, a
// before b). Convert each equation to a·v1 + b·v2 = c form by
// moving variables to lhs and constants to rhs. Then:
//   det = a1·b2 − a2·b1
//   v1  = (c1·b2 − c2·b1) / det
//   v2  = (a1·c2 − a2·c1) / det
//
// det === 0 means the two equations are parallel or identical —
// no unique solution. Refuse.
//
// The popup shows ONE form per variable (the decimal). 1-var
// shows three forms; 2-var would be six lines and crowded. If
// the parent wants exact fractions they can read the decimal or
// compute the fraction themselves — primary-paper systems are
// almost always integer-clean.
export function solveLinear2Var(parsed) {
  // Discover variable names from the terms and sort for stable
  // output. Validator has already confirmed there are exactly 2.
  const vars = new Set();
  for (const eq of parsed.equations) {
    for (const t of [...eq.lhs, ...eq.rhs]) {
      if (t.var !== null) vars.add(String(t.var).toLowerCase());
    }
  }
  const [v1, v2] = [...vars].sort();

  const [eq1, eq2] = parsed.equations;
  const a1 = sumCoefForVar(eq1.lhs, v1) - sumCoefForVar(eq1.rhs, v1);
  const b1 = sumCoefForVar(eq1.lhs, v2) - sumCoefForVar(eq1.rhs, v2);
  const c1 = sumCoefForVar(eq1.rhs, null) - sumCoefForVar(eq1.lhs, null);
  const a2 = sumCoefForVar(eq2.lhs, v1) - sumCoefForVar(eq2.rhs, v1);
  const b2 = sumCoefForVar(eq2.lhs, v2) - sumCoefForVar(eq2.rhs, v2);
  const c2 = sumCoefForVar(eq2.rhs, null) - sumCoefForVar(eq2.lhs, null);

  const det = a1 * b2 - a2 * b1;
  if (det === 0) {
    return {
      ok: false,
      reason: 'No unique solution — the equations are parallel or identical.',
    };
  }

  const v1Num = c1 * b2 - c2 * b1;
  const v2Num = a1 * c2 - a2 * c1;
  const v1Forms = computeDivisionForms(v1Num, det);
  const v2Forms = computeDivisionForms(v2Num, det);
  // Take the decimal (first) form for each variable. See doc above.
  return {
    ok: true,
    type: 'linear_2var',
    forms: [
      { label: v1, value: `${v1} = ${v1Forms[0]?.value ?? '?'}` },
      { label: v2, value: `${v2} = ${v2Forms[0]?.value ?? '?'}` },
    ],
  };
}

// Sum the coefficients of all terms whose `var` field matches the
// given variable name (or null for "constants"). Case-insensitive
// on variable names — the validator already locked them down to
// single letters, but the input casing isn't guaranteed.
function sumCoefForVar(terms, v) {
  if (!Array.isArray(terms)) return 0;
  const target = v === null ? null : String(v).toLowerCase();
  let sum = 0;
  for (const t of terms) {
    const termVar = t.var === null ? null : String(t.var).toLowerCase();
    if (termVar === target) sum += t.coef;
  }
  return sum;
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
