# Developer guide

> **中文**: [`../DEV-GUIDE.md`](../DEV-GUIDE.md)（与本文同源：改一处请同步另一处）
>
> **This document is a set of "how to add an X" recipes**: each section gives the **landing spot, what
> must change alongside it, and what happens if you get it wrong**.
> Structural rules (where a new file goes, where the boundaries are, what the shape is) are in
> [`CODE-STRUCTURE.md`](./CODE-STRUCTURE.md) — this document does not repeat them, only points at them.
> Why the design is this way is in [`adr/`](../adr/).
> §4 is **verification and testing** (the former `TEST-LAYOUT.md`, merged in): where tests go, how to run
> them, how to write one assertion.

## Contents

- [0. Before you start: commands and environment](#0-before-you-start-commands-and-environment)
- [1. Add a host route](#1-add-a-host-route)
- [2. Add a setting](#2-add-a-setting)
- [3. Add browser-side code](#3-add-browser-side-code)
- [4. Verification and testing](#4-verification-and-testing)
  - [4.1 Three layers, one job each](#41-three-layers-one-job-each)
  - [4.2 Two tiers: the hard tier blocks a PR, the soft tier only speaks](#42-two-tiers-the-hard-tier-blocks-a-pr-the-soft-tier-only-speaks)
  - [4.3 How to run (the run matrix)](#43-how-to-run-the-run-matrix)
  - [4.4 Coverage (what each layer does and does not guarantee)](#44-coverage-what-each-layer-does-and-does-not-guarantee)
  - [4.5 How to write a new assertion](#45-how-to-write-a-new-assertion)
  - [4.6 The `test/tools/` inventory](#46-the-testtools-inventory)
  - [4.7 The conventions (eight of them)](#47-the-conventions-eight-of-them)
- [5. Update the file header (every change)](#5-update-the-file-header-every-change)
- [6. Pre-commit checklist](#6-pre-commit-checklist)

---

## 0. Before you start: commands and environment

```sh
npm ci                # fetch the toolchain locally (CI deliberately installs nothing, see CONTRIBUTING.md)
npm run build         # required after touching src/**: regenerates lib/client.js
npm run verify        # hard tier (blocks a PR): real-machine behaviour / publish surface / platform contracts / packaging
npm run verify:docs   # soft tier (speaks only): module layout / reachability / retired lines / orphan declarations
npm run verify:all    # = build + verify + verify:docs + smoke
npm run smoke         # node-level behaviour smoke
```

**Which guards sit in which tier, and what a failure means** — the source of truth is the `verify` /
`verify:docs` / `smoke` scripts in `package.json`. **Do not write the counts here** (they drift). The
tier criteria are in §4.2 of this document.

**Editing `lib/**` requires a DSH restart**; editing `src/**` requires `npm run build`. The asymmetry
between those two is the most common operational mistake in this repo.

---

## 1. Add a host route

**Landing spot**: `lib/routes/<family>.js`. Only give a family its own file once it is **big enough**;
otherwise put the route near the existing family (admission conditions in `CODE-STRUCTURE.md` §4).

**Shape** (the diagnostics family is the template — the registration's return value **must** be pushed
into `disposers`, or the route keeps a released handler after unload / HMR):

```js
export function registerDiagRoutes(webServer, c) {
  const { disposers, appendDiagLine, log, notice, base: BASE } = c;
  disposers.push(webServer.register({
    kind: 'exact',                 // or 'prefix'
    path: `${BASE}/your-route`,
    handler: (req, res) => { /* … */ },
  }));
}
```

**What must change alongside it**:

| Change | Why |
|---|---|
| Pass the dependency into this family's context object in `lib/index.js` | a route module **must not inherit** the facade's imports (the guard `verify-module-layout` section 『路由模块不得"继承" lib/index.js 的 import』 decides this) |
| `package.json`'s `files` (if you added a file) | everything left in `lib/` ships; P1 decides it |
| Documentation: **do not hand-write a path table** | the route index is generated |

**If you get it wrong**:

- **Forgetting to push into `disposers`** ⇒ after unload / HMR the route still holds a released handler.
  No guard can catch this one for you — copy the template.
- **Forgetting `files`** ⇒ it breaks on install (`ERR_MODULE_NOT_FOUND`), and `verify-package-files` goes red.
- **Writing the handler straight into the facade** ⇒ the facade keeps growing, and that
  『路由模块不得继承门面 import』 guard decides it.

**How to update the route index**:

```sh
node test/tools/host-route-index.mjs --write   # recompute and write docs/ROUTE-INDEX.md
```

It is a **generated artifact**: `test/verify-route-index.mjs` recomputes it and compares byte for byte,
so a hand edit always goes red.
Note that one column of the index is a **"guard mentions" count** — adding or removing a guard changes it,
and then you must recompute. That is **expected** behaviour, not a regression.

---

## 2. Add a setting

**Landing spot**: `lib/settings-schema.js` — it is the **single source of truth** for settings, and both
the host and the client derive from it (see [`adr/0002`](../adr/0002-settings-schema-single-source.md)).

**Two things to do, both in that one file**:

1. add a default to `DEFAULTS` (defaults that are never persisted go in `DEFAULTS_ONLY`);
2. add the validation rule to `KINDS` (`num` with min/max, `enum` with its value table,
   `boolTrue` / `boolFalse`, …).

Enum allowlists are defined in that same file too (e.g. `FPS_CAP_VALUES`) — **do not** copy one into the
client or the host.

**Three things to remember**:

- **That file must be browser-safe**: no `import` / `require` / Node API / top-level side effects — it is
  **build-time-inlined** into the browser, and the build asserts each of those.
- **`min` / `max` are defined exactly once, in `KINDS`.** If a slider's actual draggable range differs
  from the schema range (this repo does have that case), **use a constant at the implementation site**
  (e.g. `ROPE_SCALE_MIN` plus the `CONSTS` resolution table) rather than hard-coding a number in the panel.
- **Do not write a second UI table**: the panel renders from the source of truth. A copy is one more thing
  that will decouple from it.

**If you get it wrong**: forget to register one key ⇒ the client's setting is **silently dropped** (the
symptom is "I changed it and nothing happened, and it is back to the default after a restart"). That is a
class of bug this repo really had, and exactly what the single source of truth exists to eliminate.

**Documentation**: setting defaults and ranges **never go into documents** — write "see the control
itself / see `lib/settings-schema.js`".

---

## 3. Add browser-side code

**Landing spot**: `src/<semantic-name>.js` (flat by default; creating a subdirectory has admission
conditions, see `CODE-STRUCTURE.md` §4).

**Two hard constraints**:

1. **It must be registered in `INLINE_MODULES`** in `scripts/build-client.mjs`, with `markers` anchors:

```js
{
  file: 'src/your-module.js',
  why: 'one line on why it is its own file (for your future self)',
  markers: ['const YOUR_EXPORT = ', 'function yourHelper('],   // missing any one ⇒ hard build failure
}
```

2. **The module must not contain** `import` / `require(` / `export default` / `process.*` / `__dirname` /
   `__filename` — each is asserted at build time (and **after stripping comments**).

**If you get it wrong**:

- **Forgetting to register** ⇒ **no error**; the file simply never reaches the artifact, and the first
  call site becomes a `ReferenceError` at runtime. This is the most dangerous failure mode of this route
  (this repo has been bitten once).
- **Reading host state at the top level** ⇒ your module is injected at the **top** of the bundle (before
  the `src/client.js` body), so a top-level read of a `const` declared in the body hits a **TDZ**.
  **If your string or template needs another constant's value, move that constant's declaration above the
  point of use** (this repo hit that trap on `LIVE_FAIL_LABELS` in `src/live-layer.js`).
- **A name colliding with the body or another module** ⇒ machine-extracted and asserted at build time;
  a conflict fails the build.

**The module header must carry its contract**: what it needs from outside, what it exposes. Because there
is **no `import`** on this side, the contract comment is the only dependency description.

**Comments under `src/**` ship to users** ⇒ for anything that drifts (line counts, sizes), write the
**recompute command** rather than a number.

---

## 4. Verification and testing

> This section was merged in from the former `TEST-LAYOUT.md`: **"where tests go / how to run them / how
> to write an assertion" is part of a developer guide**; splitting it out only adds an extra decision
> ("which one do I read?"). For the directory semantics (why `test/` is not in the published package) see
> [`CODE-STRUCTURE.md`](./CODE-STRUCTURE.md) §4.

### 4.1 Three layers, one job each

| Layer | Contents | Who runs it |
|---|---|---|
| **`test/*.mjs` (guards)** | `verify-*.mjs` — structural guards: assert that **code** matches its declarations, **with paired positive/negative controls** (prose-reading guards were removed by ADR-0006) | see §4.2 "two tiers" |
| **`test/*-smoke.mjs` (smoke)** | node-level behaviour smoke: rotation, live-frame backfill, identity validation | `npm run smoke` (inside `verify:all`) |
| **`test/e2e-*.mjs` (end-to-end)** | real-browser paths (needs a Chromium-family browser locally) | `npm run verify:e2e` (not in the verify chain) |
| **`test/compat-*.mjs` (compat)** | the real-harness integration surface, three entries: `compat-harness-live` — links the plugin into a real `@deepseek-ai/dsh` and boots it, asserting host routes are reachable / the on-disk diagnostics show the liveness marker / the plugin tree has no load failures (it isolates HOME and sets `DSH_WE_MEDIA_LEGACY=1`, so the media bridge and other third parties are never started); `compat-harness-surfaces` — a UI-surface inventory ratchet (the installed harness's `dsh-client-ui-*` diffed against `test/fixtures/harness-ui-surfaces.json`; **a new surface that is not registered goes red**) plus live assertions against the sidebar's real source; `compat-harness-pages` — **per-page DOM/style assertions** in a headless browser (a zero-dependency CDP client probing computed styles; `--dump` is the exploration mode) | `.github/workflows/harness-compat.yml` (needs network, the `dsh` CLI and a Chromium-family browser; not in the verify chain) |
| **`test/tools/` (tools)** | diagnostics / analysis / generators — **no CI consumer**, run by hand (inventory in §4.6) | manual |

### 4.2 Two tiers: the hard tier blocks a PR, the soft tier only speaks

The number of assertions is not the problem; **every assertion sharing one and the same red** is the
problem: a documentation-formatting change and "the publish surface is missing a file" used to fail the
same command, so the compliance cost of a one-line change equalled that of touching the publish surface.
They are now split by **what the failure means**:

| Tier | When it goes red | Who runs it | Inventory |
|---|---|---|---|
| **Hard** | failure means **a user will hit it**: real-machine behaviour, the publish surface, platform contracts, packaging | `npm run verify` (in `verify:all` and CI) | the source of truth is the `verify` script in `package.json` — **no inventory listed here** (adding or removing a guard makes it stale; that really happened in this repo). Within it, `verify-media-bridge` goes through `test/warn-only.mjs --probe-spawn`: when the environment cannot start a child process it is a **named SKIP**; CI's `verify:bridge` variant adds two more gates (a trivial-call probe plus artifact sha256 trust) and only records "environment skipped" when both point at the environment, naming the channel |
| **Soft** | failure means **repo housekeeping / one-off cleanup acceptance criteria** are no longer accurate — a human should look, but it must not block someone else's change | `npm run verify:docs` (in `verify:all` and in a `continue-on-error` CI step) | likewise the `verify:docs` script in `package.json` (currently four: module layout / reachability / retired lines / orphan declarations) |

> **Only "code-reading" guards are left in the soft tier.** It used to hold two guards over **document and
> comment prose** (`verify-comment-discipline` · `verify-ledger`); both went away with
> [`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md): writing discipline is carried by
> convention. They guarded "how the author should write", and once that judgement is downgraded to regex
> matching the author starts dodging a word list — and the guard itself rots and contradicts itself (the
> ADR has the details). The four that remain read **code**: module boundaries, the reachability ratchet,
> retired lines, orphan declarations — failures there are objective.

The soft tier **still runs and still prints `✓/✗`**; only its exit code is downgraded by the
`test/warn-only.mjs` wrapper: the original code is printed on the trailing
`[warn-only] 软档守卫原退出码 = N` line and written to `DSH_WARN_ONLY_EXIT`.
This is not "a silent skip" (a skip must not look like a pass, see [`README.md`](./README.md)
§写作纪律) — the assertions are unchanged; to make one block a change again, run it directly with
`node test/<guard>.mjs`.
> Why a child process instead of `node --import …`: **measured** — `npm run` swallows the `--import`
> argument (npm parses options itself), so the downgrade did not take effect and the chain broke on the
> very first soft guard.

**How to pick a tier** (ask this when adding a guard):
1. Would a user see wrong behaviour / receive a broken package? Yes ⇒ **hard**.
2. Does it guard "the form of a rule itself" (ratchet baselines, module boundaries, cleanup acceptance)?
   Yes ⇒ **soft**.
3. Unsure ⇒ **soft**: the hard tier's bar is "you can state the user-side consequence"; if you cannot,
   do not block people yet.

**Four things explicitly not done** (so they don't get re-litigated):
1. **No "prose-reading" guards** — writing discipline (comment wording, document formatting, ledger
   format) is carried by **convention**, not by a machine assertion. Before ADR-0006 this read "do not
   delete guards"; the direction is reversed: **what should go has gone**, and from here on a wording word
   list may not be added back under the banner of "preventing rot". The boundary: **guards that read code
   stay; guards that read prose are not added.**
2. **Do not change assertion contents** — changing an assertion is a separate matter (run
   `npm run verify:all` afterwards); do not ride along with this.
3. **Do not touch the harness-compat workflow** — `test/compat-*` and `harness-compat.yml` stay as they
   are: they need network and a real browser and are not in the verify chain, so tiering does not apply.
4. **Do not add new assertions for archived documents** — `docs/archive/**` is a record and does not
   reflect the current implementation; do not add guards for it.

**The motive in one line**: the root cause was **every assertion sharing one red** — "a user will hit
this" and "repo housekeeping is inaccurate" look identical as failures, so the compliance cost was set by
the most expensive assertion. Tiering separated "who decides red or green", and ADR-0006 went further and
**removed** the prose-reading ones outright instead of keeping them fed.

### 4.3 How to run (the run matrix)

**The source of truth is the scripts in `package.json`** — the table below is "when to run which one",
and **lists no counts** (they drift).

| Your situation | Run | Notes |
|---|---|---|
| You changed something and want to know if it broke | `npm run verify` | the hard tier. **This is the one that blocks a PR**; a failure means a user would hit it |
| You touched `src/**` | `npm run build && npm run verify` | the artifact must be rebuilt; `verify-client-sync` decides whether artifact and source are in sync |
| You touched docs / comments / structure | `npm run verify:docs` | the soft tier — **speaks but does not block**. What matters more than red/green is that it does not get **worse** |
| Before committing | `npm run verify:all` | = build + verify + verify:docs + smoke |
| You changed rotation / live frames / font-set loading | `npm run smoke` | node-level behaviour smoke: slower than structural guards, faster than a real machine |
| Investigating "what exactly does this one say" | `node test/<guard>.mjs` | run a single guard directly and read its own `✓/✗` detail |
| You need a real browser | `npm run verify:e2e` / `node test/compat-*` | **not in the verify chain** (needs Chromium / network / the `dsh` CLI) |

**Two conventions for reading the output**:

- `PASS |` / `✓` lines are assertions; **a line containing "negative control" is proving that an
  assertion has teeth** — if it mentions `failed=` that is **label text, not a failure**. Look at the
  trailing `ALL … PASSED` / `… FAILED`.
- A soft guard's **original exit code** is printed on the trailing
  `[warn-only] 软档守卫原退出码 = N` line. To make a soft guard actually block a change, run it directly
  with `node test/<guard>.mjs` (the assertions are unchanged; only the downgrade is gone).

### 4.4 Coverage (what each layer does and does not guarantee)

| Layer | What it guarantees | What it does **not** |
|---|---|---|
| **Hard-tier guards** | structural contracts: the route index matches the code, the publish surface is self-consistent, types share a source with the implementation, the readability floor, the glass-compositing maths | real-machine appearance, actual GPU behaviour |
| **Smoke** | node-level behaviour: the rotation state machine, live-frame backfill and identity validation, font-set loading | browser rendering results |
| **e2e** | end-to-end paths in a real browser (media origin, frame capture) | cross-platform differences (this repo is **one cross-platform codebase**; passing on one machine is not passing on the other three) |
| **compat** | the real-harness integration surface: host routes reachable, the UI-surface ratchet, per-page computed styles | it is not in the verify chain ⇒ **it will not block your PR** |
| **Soft-tier guards** | repo housekeeping: module boundaries, the reachability ratchet, retired lines, orphan declarations | they do not block a PR either (but **letting them get worse** is wrong) |

⚠️ **Platform coverage is asymmetric**: some assertions have posix / win32 branches, and on Windows the
posix ones **are not executed at all** (the output says "this is a coverage difference, not a pass").
When a change touches a platform branch, do not trust a green local run alone.

### 4.5 How to write a new assertion

**Shortest path**:

1. **Decide the layer** (§4.1 + §4.7 convention 1): behaviour → smoke; real browser → e2e; structure → guard.
2. **Pair the positive and negative controls**, and have them **share one assertion function**
   (§4.7 convention 5) — this is the most commonly botched one.
3. **Assert that the domain is non-empty first**, or a "zero residue" assertion is vacuously true on an
   empty domain.
4. **Strip comments with a string-aware implementation** (`test/tools/js-text.mjs`), not a naive
   block-comment regex.
5. **Verify that the assertion itself works**: neutralise it into "always says fine" — the negative
   control **must go red** (§4.7 convention 8).
6. A new tool / `compat-*` file must be named in §4.6 (a guard decides "no tool nobody knows about").

**⚠️ Do not add a "prose-reading" guard.** If an assertion regex-matches **wording or numbers in a
document**, it guards the editor rather than rot: rephrase the sentence and the assertion degrades from
"recompute" to "keep those two sentences". That boundary is fixed by
[`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md), and `CODE-STRUCTURE.md` §6 keeps a
"removed from this table" list recording it.

### 4.6 The `test/tools/` inventory

| Tool | What it answers | How to run |
|---|---|---|
| `analyze-host-apply.mjs` | evidence for splitting the host's `apply(ctx)` (route count / grouping by first segment / monolith size) | `node test/tools/analyze-host-apply.mjs` |
| `audit-fixture-coverage.mjs` | **whether a fixture neutralises the behaviour under test** | `node test/tools/audit-fixture-coverage.mjs` |
| `audit-guard-teeth.mjs` | a survey of guard "teeth", A–F (controls never evaluated / log-style pseudo-assertions / zero-reference assertions / vacuous truth / no red exit / naive comment stripping eating code) — **candidates only** | `node test/tools/audit-guard-teeth.mjs` |
| `audit-import-closure.mjs` | `lib/`'s **runtime import closure** vs `package.json`'s `files` (a missing file ⇒ it crashes as soon as the registry installs it) | `node test/tools/audit-import-closure.mjs` |
| `branch-notify.mjs` | **branch-level** "the store changed but nothing was notified" | `node test/tools/branch-notify.mjs audit` |
| `diagnose-web-blank.mjs` | a "blank page" investigation bench for web wallpapers (headless real browser) | `node test/tools/diagnose-web-blank.mjs` |
| `host-route-index.mjs` | generate / verify the **host route index** (writes `docs/ROUTE-INDEX.md`) | `node test/tools/host-route-index.mjs [--write]` |
| `js-text.mjs` | **text-level** tooling for JS/TS source (string- and regex-aware comment stripping) | `node test/tools/js-text.mjs selftest` |
| `sync-webwallgl.mjs` | build the WebWallGL render page from a local `webwallgl-github` checkout (vendored sync) | see the file header |

> `host-route-index.mjs` / `js-text.mjs` / `branch-notify.mjs` **are also guard libraries**
> ⇒ changing them is changing an assertion; go through `npm run verify:all`.
> There is also **`test/warn-only.mjs`** (not in this inventory): the two tiers' shared **entry wrapper** —
> exit-code downgrading and "this environment cannot start a child process, so SKIP explicitly". It is not
> an assertion itself, so no guard covers it.

### 4.7 The conventions (eight of them)

1. **New guards go in `test/`, manual tools in `test/tools/`, harness liveness probes in `test/compat-*`** —
   not back into `scripts/`: that directory holds only scripts the user or the publish flow actually runs
   (`build-client.mjs` / `prepare.mjs` / the CI baseline reader-writer `harness-compat-baseline.mjs`).
2. **`test/tools/` is one level deeper than `test/`** ⇒ when deriving the repo root from
   `import.meta.url` you must go up **two** levels (one level resolves the root to `test/`, and the
   symptom is an ENOENT that looks like "the file is gone"). `verify-module-layout` has an assertion.
3. **A guard's assertion strips comments before judging**: this directory is full of prose describing
   "what the fixture looks like", and the fixture itself is a synthetic `import … from '…'` string — an
   assertion that does not strip comments trips over its own negative control.
4. **A new guard decides by "domain" only, with no registration step**: the domain should be **enumerated
   from disk**, not from a hand-maintained list — a list with a missing line only lets that file
   **silently leave the assertion's domain**.
   ⚠️ The exception is `test/tools/*.mjs` and `test/compat-*.mjs`, which **still must be named in §4.6**.
5. **A negative control must feed its mutated input into "the same assertion"**: the assertion is defined
   in **one** place — a named function, or a named regex constant — and both the positive assertion and
   the negative control call it. Two shapes do not count:
   - ① **asserting only that some constant / array does not contain X**: the assertion is never executed,
     so it stays green while it idles;
   - ② **copying the assertion into the control** (a duplicated regex, a duplicated `.every(...)`):
     changing the production side will not turn it red.
6. **A fake React must validate children the way React does** (every stand-in's `createElement` got the
   same `assertChildren` snippet): an object may not be a child (React #31). If the stand-in quietly
   accepts it, such an error **can only blow up on a real machine** — measured: writing an assignment
   expression in an argument position of `React.createElement(...)` turns the expression's value into a
   child; with an empty table it is invisible, and the moment a role is filtered out the whole panel
   crashes — while every assertion was green at the time.
7. **Do not write a BOM into `test/**`**: `verify-fontset.mjs` carries a shebang, and a BOM makes `node`
   report `Invalid or unexpected token` on the `#!` line. Windows PowerShell's
   `Set-Content -Encoding UTF8` writes one **by default** ⇒ use
   `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))` for bulk rewrites.
8. **How to verify "the assertion itself works"**: neutralise the assertion into "always says fine" — the
   matching negative control **must go red**. The positive assertion will still pass (it is idling), which
   is why the negative control is the only thing that catches this kind of failure.

---

## 5. Update the file header (every change)

**A rule that can sit next to the code is not written up as a document.** When you change behaviour, update
the **header comment of the file you changed** in the same commit:

- **invariants** (must / must not) — into the file header;
- **contracts** (what it needs from outside, what it exposes) — into the file header, especially under
  `src/**` (that side has no `import`);
- **measurement provenance** ("measured X ≈ Y") — keep it **near where it was measured**, so it stays a
  checkable source;
- **do not write**: dates, "used to / the old implementation" framing, war stories.

**Decisions** (a trade-off with alternatives, where someone paid a price) go into [`adr/`](../adr/), not
into a file header; the format and "what not to write" are in [`adr/README.md`](../adr/README.md).

---

## 6. Pre-commit checklist

- [ ] Did you touch `src/**`? → `npm run build`, and bring `lib/client.js` along in **the same commit**.
- [ ] Did you touch `lib/**`? → note "DSH must restart for this to take effect".
- [ ] Did you add a file under `lib/`? → add it to `package.json`'s `files`.
- [ ] Did you add a file under `src/**`? → register it in `INLINE_MODULES` with `markers`.
- [ ] Did you add a setting? → only `lib/settings-schema.js`, no second UI table.
- [ ] Did you add a route? → `node test/tools/host-route-index.mjs --write` to recompute the index.
- [ ] Did you add a guard? → paired controls; the tool is named in §4.6; it does not guard document prose.
- [ ] Did you touch documentation? → **no new drifting numbers** (symbol references or recompute commands).
- [ ] Does every path / symbol you wrote into a document **actually exist**? (this is the most common slip)
- [ ] `npm run verify` is green; `npm run verify:docs` is **no worse** than before your change.
