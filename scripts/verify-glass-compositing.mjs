// Verify the GLASS COMPOSITING invariants (static, parse-based — no browser).
//
// Why this suite exists: a "noise / grain" experiment (option C, kept only as
// the local tag archive/noise-overlay-exp) laid a grain layer on the composer
// card as a `::after` carrying `mix-blend-mode: overlay` + `opacity: 0.05`. That
// broke real behaviour: the composer's `backdrop-filter` lives on the SAME
// card's `::before`, and `mix-blend-mode` (like `isolation: isolate`, `filter:`
// and `opacity:` < 1) makes its ancestor an isolated group / backdrop root — so
// the `::before` found an EMPTY backdrop and the glass went dead (the 玻璃
// slider stopped affecting the composer). Readability was also measured to be
// unaffected by the grain (masker 44–79x weaker than the residual text signal),
// so the whole experiment was dropped. The class of bug survived the drop
// because nothing asserted it statically: this suite is that missing guard.
//
// Assertions (all derived from the BUILT lib/client.js — nothing re-typed):
//   G0  the guard really read the injected stylesheet (non-empty CSS + a
//       plausible rule count), so a bundle-shape change can never make the
//       checks below pass vacuously.
//   G1  the carrier inventory is derived from the stylesheet itself: every rule
//       declaring a non-none `backdrop-filter` names a glass carrier, and the
//       required carriers ([data-composer-card] incl. its ::before,
//       [class*="_bubble"], and the plugin's own glass panels) are all present.
//   G2  no rule introduces `mix-blend-mode` (other than `normal`),
//       `isolation: isolate`, `filter:` / `-webkit-filter:` (other than `none`),
//       or `opacity:` < 1 ON a glass carrier or on one of its pseudo-elements.
//       Rationale: those properties create an isolated group / backdrop root and
//       can empty the backdrop that `backdrop-filter` samples — exactly how the
//       dropped noise commit broke the composer glass.
//   G3  the same properties never appear INSIDE a carrier (a descendant
//       selector) or on an ANCESTOR of one — an isolated group anywhere on that
//       axis can swallow the carrier's backdrop sampling.
//   G4  a rule that declares a non-none `backdrop-filter` never also declares
//       one of those primitives in the SAME body (the blur carrier must stay a
//       pure glass surface).
//   G5  the two carriers that must keep their blur are present and non-none in
//       the DEFAULT (no-flag) build: the composer `::before` blur expression and
//       the message-bubble blur expression, each reading --we-blur AND
//       --we-saturate.
//   G6  the composer card ITSELF keeps `backdrop-filter: none` (the blur must
//       stay on `::before`: a non-none backdrop-filter on the card makes it a
//       containing block for its position:fixed descendants — #89).
//   N1  `@keyframes` blocks, which G2/G3 exempt as transient entry fades, never
//       carry a compositing primitive of their own (only opacity/transform).
//   N2  the detector has teeth: the EXACT dropped-commit selector shape (with its
//       `body[data-we-noise="on"]` prefix and `:not(...)::after`) is flagged, and
//       its clean twin is not.
//   D1  the Task-1 contract: in the DEFAULT path `--we-saturate` is a CONSTANT
//       (the 玻璃 slider drives frost depth only — one slider, one job), the
//       constant sits in the modest liquid-glass band and BELOW the stylesheet's
//       own fallback default, and the `?we-saturate=legacy` escape hatch still
//       restores the old coupled ramp verbatim.
//
// Usage: node scripts/verify-glass-compositing.mjs [path-to-client-bundle]
//   The optional argument points the parser at another bundle; the negative
//   control uses it to prove the assertions fail on a mutated copy.
import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const CLIENT = process.argv[2] || new URL('../lib/client.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = readFileSync(CLIENT, 'utf8');

// ── source → the stylesheet the plugin injects ──────────────────────────────
const FLOOR = {
  light: Number((SRC.match(/const READABILITY_FLOOR = ([\d.]+);/) || [])[1]),
  dark: Number((SRC.match(/const READABILITY_FLOOR_DARK = ([\d.]+);/) || [])[1]),
};
const CSS_BODY_MATCH = SRC.match(/const CSS = `([^`]*)`;/);
const CSS_BODY = CSS_BODY_MATCH ? CSS_BODY_MATCH[1] : '';
let CSS = '';
let cssError = null;
try {
  if (CSS_BODY) {
    // Evaluate the template with exactly the constants the source declares, so
    // the string parsed here IS the string the plugin injects.
    CSS = new Function('READABILITY_FLOOR', 'READABILITY_FLOOR_DARK',
      'return `' + CSS_BODY + '`;')(FLOOR.light, FLOOR.dark);
  }
} catch (err) { cssError = err && err.message; }
// Comments are prose that can contain ':' and braces; drop them before parsing
// so the selector/declaration extraction is exact.
CSS = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

// ── CSS parsing helpers ─────────────────────────────────────────────────────
/** Split a selector list into its comma-separated selectors, whitespace-collapsed. */
function selectorsOf(header) {
  const lastBrace = header.lastIndexOf('{');
  const tail = lastBrace >= 0 ? header.slice(lastBrace + 1) : header;
  return tail.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** Split one selector into compound selectors at TOP-level combinators only
 *  (spaces/`>`/`+`/`~` inside `:has(...)`, `:not(...)`, `[a="b c"]` must not split). */
function compounds(sel) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '+' || ch === '~')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Distinctive class/id/attribute tokens of a compound (falls back to the tag). */
function tokensOf(compound) {
  const tokens = [];
  const re = /\[[^\]]*\]|\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+/g;
  let m;
  while ((m = re.exec(compound))) tokens.push(m[0]);
  if (tokens.length === 0) {
    const tag = compound.match(/^[A-Za-z][A-Za-z0-9-]*/);
    if (tag) tokens.push(tag[0]);
  }
  return tokens;
}

const WORD = /[A-Za-z0-9_-]/;
/** Does `hay` contain `token` as a complete selector token? `.we-update-notice`
 *  must NOT match inside `.we-update-notice__body` (BEM suffix is a longer name),
 *  which a plain substring test would wrongly flag. */
function containsToken(hay, token) {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(token, from);
    if (at < 0) return false;
    const after = hay[at + token.length] || '';
    if (!WORD.test(after)) return true;
    from = at + 1;
  }
}

/** The first declaration value for `prop` in a rule body (prop is matched at a
 *  token boundary so `filter` never matches inside `backdrop-filter`). */
function declValue(body, prop) {
  const m = body.match(new RegExp('(?:^|[\\s;{])' + prop + ':\\s*([^;}]+)', 'i'));
  return m ? m[1].trim() : null;
}

/** Compositing primitives that create an isolated group / backdrop root. */
const RISK_PROPS = [
  { prop: 'mix-blend-mode', label: 'mix-blend-mode', bad: (v) => v.toLowerCase() !== 'normal' },
  { prop: 'isolation', label: 'isolation', bad: (v) => v.toLowerCase().startsWith('isolate') },
  { prop: 'filter', label: 'filter', bad: (v) => v.toLowerCase() !== 'none' },
  { prop: '-webkit-filter', label: '-webkit-filter', bad: (v) => v.toLowerCase() !== 'none' },
  { prop: 'opacity', label: 'opacity < 1', bad: (v) => Number.isFinite(parseFloat(v)) && parseFloat(v) < 1 },
];

/** Run the whole detection over one stylesheet string. Factored out so the
 *  negative control in N2 exercises the very same code path as the real checks. */
function analyze(cssText) {
  const keyframes = [];
  // Mask @keyframes blocks (transient entry fades, checked separately in N1)
  // before the steady-state rule scan.
  let masked = '';
  let i = 0;
  for (;;) {
    const at = cssText.indexOf('@keyframes', i);
    if (at < 0) { masked += cssText.slice(i); break; }
    masked += cssText.slice(i, at);
    const open = cssText.indexOf('{', at);
    if (open < 0) { masked += cssText.slice(at); break; }
    let depth = 0;
    let end = -1;
    for (let j = open; j < cssText.length; j++) {
      if (cssText[j] === '{') depth++;
      else if (cssText[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { masked += cssText.slice(at); break; }
    keyframes.push({ name: cssText.slice(at, open).trim(), body: cssText.slice(open + 1, end) });
    masked += ' '.repeat(end - at + 1);
    i = end + 1;
  }

  // Every flat rule, brace-depth matched (same convention as verify-readability).
  const rules = [];
  let from = 0;
  for (;;) {
    const open = masked.indexOf('{', from);
    if (open < 0) break;
    const prevClose = masked.lastIndexOf('}', open);
    const header = masked.slice(prevClose + 1, open);
    let depth = 0;
    let close = -1;
    for (let j = open; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) break;
    rules.push({
      header,
      inSupports: /@supports/.test(header),
      selectors: selectorsOf(header),
      body: masked.slice(open + 1, close),
    });
    from = open + 1;
  }

  // Carriers: every selector whose rule declares a non-none backdrop-filter.
  const carriers = new Map(); // "token token" -> { sel, compounds, tokens, blur }
  for (const r of rules) {
    const bf = declValue(r.body, 'backdrop-filter') || declValue(r.body, '-webkit-backdrop-filter');
    if (!bf || /^none\b/i.test(bf)) continue;
    for (const s of r.selectors) {
      const cps = compounds(s);
      if (!cps.length) continue;
      const tokens = tokensOf(cps[cps.length - 1]);
      if (!tokens.length) continue;
      const key = tokens.join(' ');
      if (!carriers.has(key)) carriers.set(key, { sel: s, compounds: cps, tokens, blur: bf });
    }
  }

  // Violations: risky declarations on / inside / above a carrier.
  const violations = [];
  for (const r of rules) {
    for (const risk of RISK_PROPS) {
      const v = declValue(r.body, risk.prop);
      if (v === null || !risk.bad(v)) continue;
      for (const s of r.selectors) {
        const cps = compounds(s);
        if (!cps.length) continue;
        for (let ci = 0; ci < cps.length; ci++) {
          for (const [key, c] of carriers) {
            if (!c.tokens.every((t) => containsToken(cps[ci], t))) continue;
            violations.push({
              scope: ci === cps.length - 1 ? 'ON' : 'INSIDE',
              prop: risk.label, value: v, sel: s, carrier: key,
            });
          }
        }
        for (const [key, c] of carriers) {
          const isPrefix = cps.length < c.compounds.length
            && cps.every((x, k) => x === c.compounds[k]);
          if (isPrefix) violations.push({ scope: 'ABOVE', prop: risk.label, value: v, sel: s, carrier: key });
        }
      }
      break; // one risky property per rule body is enough to report
    }
  }

  // A blur-declaring rule must not also declare a risky primitive itself.
  const impureCarriers = [];
  for (const r of rules) {
    const bf = declValue(r.body, 'backdrop-filter') || declValue(r.body, '-webkit-backdrop-filter');
    if (!bf || /^none\b/i.test(bf)) continue;
    for (const risk of RISK_PROPS) {
      const v = declValue(r.body, risk.prop);
      if (v !== null && risk.bad(v)) impureCarriers.push({ prop: risk.label, value: v, sel: r.selectors[0] });
    }
  }

  return { rules, carriers, violations, impureCarriers, keyframes };
}

const fmtViolation = (v) => v.scope + ' ' + v.carrier + ' <= ' + v.prop + ': ' + v.value + ' (' + v.sel + ')';

/** First DEFAULT-build rule keeping a non-none blur on `token` (+ optional pseudo). */
function blurCarrierRule(rules, token, pseudo) {
  for (const r of rules) {
    if (r.inSupports) continue;
    for (const s of r.selectors) {
      if (/data-we-glass-fallback/.test(s)) continue;
      const cps = compounds(s);
      if (!cps.length) continue;
      const last = cps[cps.length - 1];
      if (!containsToken(last, token)) continue;
      if (pseudo && !last.includes(pseudo)) continue;
      const bf = declValue(r.body, 'backdrop-filter') || declValue(r.body, '-webkit-backdrop-filter');
      if (!bf || /^none\b/i.test(bf)) continue;
      return { sel: s, blur: bf };
    }
  }
  return null;
}

function main() {
  const { rules, carriers, violations, impureCarriers, keyframes } = analyze(CSS);

  // ── G0: the guard actually read the injected stylesheet ──────────────────
  check('G0 the injected stylesheet was parsed (non-empty CSS, plausible rules)',
    !cssError && CSS.length > 10000 && rules.length > 100,
    'CSS=' + CSS.length + 'b · rules=' + rules.length + ' · carriers=' + carriers.size
      + (cssError ? ' · CSS eval error: ' + cssError : ''));

  // ── G1: carrier inventory, derived from the stylesheet ───────────────────
  const REQUIRED = [
    { label: 'composer card / its ::before', token: '[data-composer-card]' },
    { label: 'message bubble', token: '[class*="_bubble"]' },
  ];
  const missing = REQUIRED.filter((req) => ![...carriers.values()]
    .some((c) => c.tokens.some((t) => t === req.token)));
  const panelCount = [...carriers.keys()].filter((k) => /^\.we-/.test(k)).length;
  check('G1 every non-none backdrop-filter rule names a glass carrier, incl. the required composer/bubble/panel carriers',
    missing.length === 0 && panelCount >= 3,
    carriers.size + ' carriers (' + panelCount + ' plugin panels)'
      + (missing.length ? ' · MISSING: ' + missing.map((m) => m.label).join(', ') : ''));

  // ── G2: no compositing primitive ON a carrier (or its pseudo-elements) ───
  const onCarrier = violations.filter((v) => v.scope === 'ON');
  check('G2 no mix-blend-mode/isolation/filter/opacity<1 ON a blur carrier or its pseudo-elements (an isolated group would empty the sampled backdrop)',
    onCarrier.length === 0,
    onCarrier.length ? onCarrier.map(fmtViolation).join(' · ') : '0 violations across ' + carriers.size + ' carriers');

  // ── G3: none INSIDE a carrier, nor on an ancestor of one ─────────────────
  const around = violations.filter((v) => v.scope !== 'ON');
  check('G3 no mix-blend-mode/isolation/filter/opacity<1 INSIDE a blur carrier or on one of its ANCESTORS (same isolated-group / backdrop-root hazard)',
    around.length === 0,
    around.length ? around.map(fmtViolation).join(' · ') : '0 violations');

  // ── G4: a blur rule stays a pure glass surface ───────────────────────────
  check('G4 no rule declaring a non-none backdrop-filter also declares mix-blend-mode/isolation/filter/opacity<1 itself',
    impureCarriers.length === 0,
    impureCarriers.length
      ? impureCarriers.map((v) => v.sel + ' <= ' + v.prop + ': ' + v.value).join(' · ')
      : '0 impure carrier rules');

  // ── G5: the two required carriers keep their blur (default build) ────────
  const composer = blurCarrierRule(rules, '[data-composer-card]', '::before');
  const bubble = blurCarrierRule(rules, '[class*="_bubble"]', '');
  const readsBoth = (bf) => /var\(--we-blur\b/.test(bf) && /var\(--we-saturate\b/.test(bf);
  check('G5 composer ::before and message-bubble blur expressions are present, non-none and read --we-blur AND --we-saturate in the no-flag build',
    !!composer && !!bubble && readsBoth(composer.blur) && readsBoth(bubble.blur),
    'composer::before=' + (composer ? composer.blur : 'MISSING')
      + ' · bubble=' + (bubble ? bubble.blur : 'MISSING'));

  // ── G6: the composer card itself must not carry the blur (#89) ───────────
  let cardOwnBlur = null;
  for (const r of rules) {
    if (r.inSupports) continue;
    for (const s of r.selectors) {
      if (/data-we-glass-fallback/.test(s)) continue;
      const cps = compounds(s);
      if (!cps.length || cps[cps.length - 1] !== '[data-composer-card]') continue;
      const bf = declValue(r.body, 'backdrop-filter');
      if (bf) cardOwnBlur = bf;
    }
  }
  check('G6 the composer card itself keeps backdrop-filter: none (blur stays on ::before — a card-level blur becomes a containing block for its fixed descendants, #89)',
    cardOwnBlur === 'none',
    '[data-composer-card] backdrop-filter = ' + String(cardOwnBlur));

  // ── N1: keyframes (exempt from G2/G3) carry no compositing primitive ─────
  const kfBad = [];
  let kfFades = 0;
  for (const kf of keyframes) {
    if (/opacity:/.test(kf.body)) kfFades++;
    for (const risk of RISK_PROPS) {
      if (risk.prop === 'opacity') continue;
      const v = declValue(kf.body, risk.prop);
      if (v !== null && risk.bad(v)) kfBad.push(kf.name + ' <= ' + risk.label + ': ' + v);
    }
  }
  check('N1 @keyframes (transient entry fades, exempted from G2/G3) never carry mix-blend-mode/isolation/filter of their own',
    kfBad.length === 0,
    keyframes.length + ' keyframes (' + kfFades + ' opacity fades)'
      + (kfBad.length ? ' · ' + kfBad.join(' · ') : ''));

  // ── N2: the detector has teeth (the exact dropped-commit shape) ──────────
  const SYNTHETIC_CARRIER = 'body[data-we-wallpaper] [data-composer-card]::before{content:"";'
    + 'backdrop-filter:blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.8));}'
    + 'body[data-we-wallpaper] [class*="_bubble"]{content:"";'
    + 'backdrop-filter:blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.8));}';
  // The dropped option-C rule, verbatim in shape: extra body qualifier + :not() + ::after.
  const SYNTHETIC_NOISE = 'body[data-we-wallpaper][data-we-noise="on"] [data-composer-card]:not([class*="cardWorkspaceTrigger"])::after,'
    + 'body[data-we-wallpaper][data-we-noise="on"] [class*="_bubble"]:not([data-side])::after{content:"";'
    + 'mix-blend-mode:overlay;opacity:0.05;}';
  const bad = analyze(SYNTHETIC_CARRIER + SYNTHETIC_NOISE);
  const clean = analyze(SYNTHETIC_CARRIER
    + SYNTHETIC_NOISE.replace('mix-blend-mode:overlay;opacity:0.05;', 'background-image:none;'));
  const badFlagged = bad.violations.filter((v) => v.scope === 'ON');
  check('N2 negative control: the dropped-commit noise rule IS flagged (both carriers), and its clean twin is not — this assertion has teeth',
    badFlagged.length >= 2 && clean.violations.length === 0 && clean.carriers.size === 2,
    'mutated: ' + badFlagged.length + ' on-carrier violations [' + badFlagged.map((v) => v.carrier + ':' + v.prop).join(', ') + ']'
      + ' · clean twin: ' + clean.violations.length + ' violations, ' + clean.carriers.size + ' carriers');

  // ── D1: Task-1 contract — saturation is decoupled from the blur slider ───
  const satTernary = SRC.match(
    /setProperty\("--we-saturate",\s*useLegacySaturateCoupling\(\)\s*\?\s*String\(1\.15 \+ selection\.blur \* 0\.028\)\s*:\s*String\(GLASS_SATURATE\)\)/);
  const satConst = Number((SRC.match(/const GLASS_SATURATE = ([\d.]+);/) || [])[1]);
  const satFallback = Number((CSS.match(/saturate\(var\(--we-saturate,\s*([\d.]+)\)\)/) || [])[1]);
  check('D1 --we-saturate is a CONSTANT in the default path (the 玻璃 slider drives frost depth only) and ?we-saturate=legacy still restores the old coupled ramp',
    !!satTernary && satConst >= 1.25 && satConst <= 1.4 && satConst < satFallback,
    'GLASS_SATURATE=' + (Number.isFinite(satConst) ? satConst : 'MISSING')
      + ' · stylesheet fallback=' + (Number.isFinite(satFallback) ? satFallback : 'MISSING')
      + ' · legacy branch (1.15 + blur*0.028) preserved=' + !!satTernary
      + ' · old ramp 0/15/30/45/60px = 1.15/1.57/1.99/2.41/2.83, new = constant');

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL GLASS COMPOSITING CHECKS PASSED'
    : failed.length + ' CHECK(S) FAILED'));
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
}
