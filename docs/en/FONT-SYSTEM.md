# src/font/ — the font system (F / G tracks)

> **中文**: [`../FONT-SYSTEM.md`](../FONT-SYSTEM.md)（与本文同源：改一处请同步另一处）

> **This document is an index, not a mechanism description.** The font system's implementation,
> invariants and value conventions live in the header comments of the files under
> [`src/font/`](../../src/font/) (this repo's discipline: a rule that can sit next to the code is not
> written up as a document). This page only answers two things: **what the three channels are**, and
> **which places to touch when changing fonts**. Decisions and trade-offs are in
> [`adr/0002`](../adr/0002-settings-schema-single-source.md) (the single source of truth for values) and
> in the ledger's §9.1 `V1–V10` token-layer constraints (`wip/OPEN-ITEMS.md`, Chinese only).

This directory is **the entire implementation of the font system**. It is its own directory because fonts
have three **mutually distinct delivery channels**, and keeping them apart makes it easy to use the wrong
one when editing (the symptom is "I changed it and nothing happened", only visible on a real machine).

**The files fall into two kinds**: most are **pure computation** (role tables / tokens / hook generation,
never touching the DOM), and `apply.js` is **the only one that touches the DOM** (host default-value
snapshot + component-scoped stylesheet). The effects layer (`src/effects.js`) only calls its entry point
and no longer carries any font implementation.

## The three channels (which one applies depends on where the font comes from)

| Channel | Code | What it covers | Mechanism | Guard |
|---|---|---|---|---|
| ① **Role tokens** | [`color-roles.js`](../../src/font/color-roles.js) · [`typography.js`](../../src/font/typography.js) | DSH **roles** (body / secondary / dimmed / headings / code / table …) | the DSH `theme` service's `overrideTokens` (inlined into `body`, **no `!important` needed**) | `test/verify-theme-layer.mjs` |
| ② **Official component hooks** | `DSL_FONT_HOOKS` in [`components.js`](../../src/font/components.js) | code blocks / terminal | the official `--dsl-*` hooks, where **the scope is the hook's definition site in the stylesheet** (derived by `scanHookScopes`) | `test/verify-component-fonts.mjs` |
| ③ **Direct module-name hits** | the allowlisted entries in `COMPONENT_FONT_TARGETS` in the same file | components reachable by a CSS-module prefix | `body [class*="_<module-name>_"]` direct hits (**equal specificity**, no `!important`) | same as above |

> **The mechanisms, failure modes and invariants of ①②③ are all written in the header comments of
> [`components.js`](../../src/font/components.js) and [`apply.js`](../../src/font/apply.js)** — including
> "why a module name must be measured", "why ② must not build its scope from module names", and "why the
> real-property channel must skip hook components". Read those two headers before changing a channel;
> this document does not repeat them.

**Routing rule (which channel, from static analysis rather than preference)**: a font whose value comes
from a **DSH role token** ⇒ ①; a font that comes from a **`font:` shorthand on a descendant element** ⇒
only ②'s hook leg works (writing `font-size` on the container is ineffective — the shorthand beats
inheritance); a font that is the component's own hard-coded declaration with no `font:` shorthand ⇒ ③.
Each target's `route` field (`tokens` / `hooks` / `props`) is where that judgement lands; the criteria are
in the `components.js` header.

## Where the values actually live (orthogonal to the three channels)

The three channels answer "**how a value reaches the page**"; where the value itself lives is a separate
question:

- **Source of truth = `fontsets/<active id>.json`**: a **shipped layer** under `lib/fontsets/` (read-only)
  plus a **user layer** under the plugin data directory, with the **user layer winning** for the same id;
  editing the shipped copy is **copy-on-write** into a user-layer copy, and deleting that copy restores
  the shipped original.
- `config.json` keeps only the root fields (the active font-set id and the custom entries) — **the six font
  keys are not in the settings persistence allowlist**: `FONTSET_KEYS` in `lib/settings-schema.js` defines
  their kind metadata, and the client's [`src/fontset-store.js`](../../src/fontset-store.js) and the host's
  [`lib/routes/fontsets.js`](../../lib/routes/fontsets.js) **share that one definition** for sanitising.
- **Writing back is part of the design**: editing any font item in the panel only changes **the set that is
  active**; import/export is a whole `.json` round trip (export uses a host response header plus an
  ordinary link, so on desktop it is the system's own "Save as").

## Adding a new role / component

**Three places must change together** (a guard requires them to agree):

| What you are adding | Where it goes | Must be kept in sync |
|---|---|---|
| A typography role | `THEME_TYPE_ROLES` in `typography.js` (copy the expression **from DSH**) | `THEME_TYPE_ROLE_IDS` in `lib/settings-schema.js` (the two must agree) |
| A colour role | `THEME_COLOR_ROLES` in `color-roles.js` | `THEME_COLOR_ROLE_IDS` in the schema |
| A component | `COMPONENT_FONT_TARGETS` in `components.js` (`id` + a **measured** `prefix` + `source` + `route`/`dslHooks`) | `COMPONENT_FONT_KEYS` in the schema (it compares **ids**, not module names) |

**Three steps for adding a component** (details and criteria in the `components.js` header):

1. **Measure** the module name in `@deepseek-ai/dsh-client-ui-primitives`'s `*.module.css` and put that
   file's path into `source` (when DSH is installed locally, a guard opens it and checks the `prefix` really
   appears there);
2. add the allowlist entry and **sync the schema key**;
3. think through `route` — only the `hooks` leg can cover the "descendant `font:` shorthand" case.

> ⚠️ The allowlist has a **size ceiling** (a ratchet), and `source` must be non-empty and end in
> `.module.css` — **the ceiling and the current entry count come from the guard and
> `COMPONENT_FONT_TARGETS`, and this document does not hard-code them**.

After a DSH upgrade, the command to **re-extract the role table** is in the
[`typography.js`](../../src/font/typography.js) header (run it once to check whether the baseline values moved).

## How these modules get into the browser bundle

Every module in this directory is **build-time-inlined** into `lib/client.js` via `INLINE_MODULES` in
[`scripts/build-client.mjs`](../../scripts/build-client.mjs) (the browser half has no local module
resolver, so inlining is the only option). The build asserts for each module: browser-safe / structural
markers present / the machine-extracted injected name does not collide with `src/client.js` — **a missing
marker fails the build**.

> ⚠️ **Forgetting to register in `INLINE_MODULES` does not error**; the file simply never reaches the
> artifact (this really happened here: `src/api-client.js` was an orphan for a while).
> `verify-component-fonts.mjs` has a section asserting `apply.js` on the trio "module present + inlined +
> **not** in the body" — copy that shape when extracting a module.
> Directory semantics and admission thresholds are in [`CODE-STRUCTURE.md`](./CODE-STRUCTURE.md) §4.
