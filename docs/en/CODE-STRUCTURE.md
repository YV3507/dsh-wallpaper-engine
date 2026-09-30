# Code structure

> **中文**: [`../CODE-STRUCTURE.md`](../CODE-STRUCTURE.md)（与本文同源：改一处请同步另一处）

> **This document answers three things**: **where code goes** (where a new file lands), **what the
> structure looks like** (who calls whom, where data flows), and **where the boundaries are** (what
> counts as crossing one).
> **Why it was designed this way** is in [`adr/`](../adr/); **mechanisms and invariants** live in the
> header comments of the files they belong to (this repo's discipline: a rule that can sit next to the
> code is not written up as a document). **How to add something** is in
> [`DEV-GUIDE.md`](../DEV-GUIDE.md).
>
> This document is the merge of two earlier ones (`MODULE-LAYOUT.md` ⊕ `ARCHITECTURE.md`): they were
> always the same axis — one was the **specification** (criteria, admission thresholds), the other the
> **overview** (structure, lifecycle, sources of truth). Merging them means "code structure" has exactly
> one place to read; the cost is that this file is longer than either was alone.
>
> **Editing discipline**: when a **rule** in this document changes and that rule is registered in §6,
> the matching guard must change **in the same commit** (and vice versa); rules **without** a guard hold
> by convention, and you may not add a prose-reading assertion just so a rule can "count"
> ([`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md)).
> **No drifting numbers** (counts, line counts, thresholds, sizes): point at the source of truth or give
> the recompute command.

## Where to read

| What you want to know | Read |
|---|---|
| User-visible behaviour, the out-figure chain, the route table | [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) |
| **Where code goes / structure / boundaries** | **this document** |
| Why a design is the way it is | [`adr/`](../adr/) |
| How to add a route / a setting / a browser-side module / a guard | [`DEV-GUIDE.md`](../DEV-GUIDE.md) |
| Running tests, writing tests, the two tiers | [`DEV-GUIDE.md`](../DEV-GUIDE.md) §4 |
| Permissions and upgrading | [`UPGRADING.md`](./UPGRADING.md) · [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) |

---

## 1. One axis, not two

The split is **not** "`lib` = server / `src` = client". It is two **orthogonal** properties:

| Property | Question | What it decides |
|---|---|---|
| **Which process it runs in** | Does it have to run in the browser? | `src/` or `lib/` |
| **Whether it ships** | Is it listed in `package.json`'s `files`? | Whether dead code may stay / whether dev-only things may live there |

The four combinations are every landing spot in this repository:

| | **Ships with the package** | **Does not ship (dev surface)** |
|---|---|---|
| **Browser process** | `lib/client.js` — **a generated artifact, the only one in the repo** | `src/**` — the **single source of truth** for the browser half |
| **Host process** (Node / Electron main) | `lib/index.js` + the `lib/**` modules it imports + `lib/vendor/`, `lib/webwallgl/` (third-party copies) + `lib/types/` | **`test/` (guards: `verify-*` + `*-smoke` + `e2e-*`) · `test/tools/` (diagnostics / analysis / generators)** · `scripts/` (only `build-client` / `prepare`, used at build and publish time) · `docs/` + the machine-local research / evidence directories (covered by ignore rules, **not committed and not referenced by committed documents**) |

### 1.1 One codebase, two halves (two runtime forms)

This plugin is **one npm package** that is two things at once — and the two loading paths **do not know
about each other**:

| Identity | Entry | Who loads it | Where it runs |
|---|---|---|---|
| **Cordis host plugin** | `inject` / `apply(ctx)` in `lib/index.js` | the DSH host, from the bundle patch row | Node (Electron main side) |
| **DSH client plugin** | `lib/client.js` (`exports["./client"]` + the `dsh.client` manifest in `package.json`) | the DSH **client loader**, from package metadata (the host serves it over no route at all) | browser / renderer process |

What each side may write, and how an edit takes effect:

| | **Host half** | **Browser half** |
|---|---|---|
| Entry | `lib/index.js` (`package.json`'s `main`; `apply(ctx)`) | `lib/client.js` (consumed by the client loader's `window.__ModuleLoader__.load({ id, factory })`) |
| Where the source is | **`lib/*.js` itself** (hand-written, published directly) | **`src/**`**: `src/client.js` is the body, the rest are build-time-inlined modules |
| What is available | `node:*`, `worker_threads`, `child_process`, `fs` | `document`, `fetch`, DSH client ctx services; **no `node:`, no `import`** |
| How an edit takes effect | **DSH must restart** (`lib/*.js` is loaded at startup, never hot-updated) | `npm run build` regenerates `lib/client.js` |

```mermaid
graph TB
    subgraph Host["Host process (Node / Electron main)"]
        IDX["lib/index.js<br/>apply(ctx) · inject = ['webServer']"]
        ROUTES["lib/routes/*<br/>route registration, grouped by family"]
        MEDIA["lib/media/*<br/>media bridge and on-demand runtimes"]
        SCAN["scan chain<br/>Steam → libraryfolders.vdf → wallpaper enumeration"]
        WEB["lib/webwallgl/*<br/>vendored render page (injected as text)"]
        STORE["~/.dsh-wallpaper-engine/<br/>config.json · caches · uploads"]
    end

    subgraph Client["Browser / renderer process"]
        CLI["lib/client.js<br/>window.__ModuleLoader__.load"]
        SRC["src/**<br/>inlined into one scope at build time"]
        LAYER["wallpaper layer<br/>position:fixed; z-index:-1"]
        PANEL["settings page and drawer<br/>DSH client slots"]
    end

    subgraph WE["Local Wallpaper Engine install"]
        PROJ["projects/ · steamapps/workshop/"]
    end

    SCAN -->|read vdf + project dirs| PROJ
    PROJ --> SCAN
    SCAN --> IDX
    IDX --> ROUTES
    IDX --> MEDIA
    IDX --> WEB
    IDX --> STORE
    ROUTES -->|same-origin JSON / media bytes| CLI
    WEB -->|render page + fencing| CLI
    CLI --> SRC
    SRC --> LAYER
    SRC --> PANEL
    MEDIA -->|on-demand download + verification| STORE
```

> The **only interface** between the two paths is the HTTP route table. That is why the route table is a
> **generated artifact** (`docs/ROUTE-INDEX.md`, recomputed and byte-compared by
> `test/tools/host-route-index.mjs`) — hand-writing it always rots, and this repo has the scars.

---

## 2. The host half: a facade plus route families

`lib/index.js` is a **facade**: it registers and aggregates the protocol, and **holds no new logic**. As
the feature set grew, whole families were extracted into modules:

```mermaid
graph LR
    IDX["lib/index.js<br/>(facade: apply + shared closures)"]
    IDX --> R1["lib/routes/diag.js<br/>diagnostics"]
    IDX --> R2["lib/routes/now-playing.js<br/>system audio / now playing / reverse control"]
    IDX --> R3["lib/routes/scene-frame.js<br/>captured and custom frames"]
    IDX --> R4["lib/routes/scene-serve.js<br/>render page / wallpaper files / media-origin probe"]
    IDX --> R5["lib/routes/fontsets.js<br/>font sets"]
    IDX --> R6["lib/routes/upload.js<br/>uploads"]
    IDX --> M1["lib/media/supervisor.js<br/>middleware lifecycle"]
    IDX --> M2["lib/media/provision.js<br/>on-demand download + verification"]
    IDX --> M3["lib/media/legacy.js<br/>built-in fallback implementation"]
```

**The shape of a family is specified** (§4 item 1): a route module receives an **explicit context object**
from `apply(ctx)` — fields are the things it uses but does not own — instead of inheriting
`lib/index.js`'s imports. That boundary is pinned by the guard section in `verify-module-layout` named
『路由模块不得"继承" lib/index.js 的 import』.

**Why the facade is not fully emptied**: some shared mutable state (the media-origin address, the payload
ledger, the cache index) must live in the same scope as `/inventory`. So the facade still owns a set of
closures, and cross-module access may only be through **accessors** — passing a value out is a stale
snapshot.

### 2.1 Startup and lifecycle

```mermaid
sequenceDiagram
    participant DSH as DSH host
    participant IDX as lib/index.js
    participant WS as ctx.webServer
    participant CLI as lib/client.js
    DSH->>IDX: load the bundle patch row
    Note over IDX: inject = ['webServer'] ⇒ waits for the HTTP server<br/>a profile without webServer does not load this plugin at all
    IDX->>IDX: locate the WE install (libraryfolders.vdf)
    IDX->>IDX: enumerate wallpapers + read playlists
    IDX->>WS: register same-origin routes (each family registers itself)
    IDX->>IDX: cache sweep / pruning deferred until loading finishes
    CLI->>WS: GET /wallpaper-engine/inventory
    WS-->>CLI: JSON inventory
    CLI->>WS: GET media / preview / scene-live …
    WS-->>CLI: media bytes (Range) · render page · captured frame
    Note over IDX,WS: unload / HMR ⇒ fiber unwind:<br/>every registration pushes a disposer, unwound in order
```

- **`webServer` is a hard dependency**: declared on `inject` and awaited by the Loader — a profile with no
  HTTP server **does not load** this plugin, rather than loading and then crashing.
- **Every registration goes through the fiber**: routes, the media origin, timers and child processes are
  all reverted on unload. This is not optional — otherwise an unload / HMR leaves live handlers behind.
- **`ctx.webServer` is still read defensively**: when the route table cannot be built there must be a
  clear failure, not an `undefined` crash.

---

## 3. The browser half: build-time inlining, not a module system

The browser half's source of truth is `src/**`, but **there is no local module resolver at runtime** (the
loader's `require` serves external packages only). So extracted modules are stripped of their `export`s
at **build time** by `scripts/build-client.mjs`, following the `INLINE_MODULES` list, and injected into
the **same factory scope** of `lib/client.js`.

```mermaid
graph LR
    subgraph SRC["src/** (hand-written source of truth for the browser half)"]
        C["src/client.js<br/>the body"]
        A["src/styles.js<br/>pure data: the whole stylesheet"]
        B["src/panel-tabs.js · src/picker-*.js<br/>UI surface"]
        D["src/live-layer.js · src/media-prep.js · src/transcode.js<br/>behavioural surface"]
        E["src/font/*<br/>font system"]
        F["lib/settings-schema.js<br/>the one shared kernel"]
    end
    C --> BUILD["scripts/build-client.mjs<br/>INLINE_MODULES + markers assertions"]
    A --> BUILD
    B --> BUILD
    D --> BUILD
    E --> BUILD
    F --> BUILD
    BUILD -->|strip export, inline in order| OUT["lib/client.js<br/>(generated, committed, never hand-edited)"]
```

The trade-offs are recorded in [`adr/0003`](../adr/0003-build-time-module-inlining.md).

---

## 4. Where a new file goes (the decision procedure)

Ask five questions in order; stop at the first hit:

1. **Does it have to run in the browser?**
   → `src/**`, **and it must be registered in `INLINE_MODULES`** in `scripts/build-client.mjs` (with its
   `markers` anchors). ⚠️ Forgetting to register **does not error** — the file simply never reaches the
   artifact (this repo has been bitten once).
   **`src/` is flat by default**: the root is the default landing spot. A subdirectory is created only
   when a subsystem satisfies **both** conditions:
   - ① **its member count reaches the admission threshold** (`.js` count, nested included) — the
     **single source of truth** for the threshold is `SRC_DIR_MIN_MEMBERS` in the guard
     (`test/verify-module-layout.mjs`); this document does not copy the number;
   - ② **it has an authoritative document of its own**, whose **top-level heading** names the directory —
     the only instance is `src/font/` ([`FONT-SYSTEM.md`](../FONT-SYSTEM.md)'s H1 is `# src/font/ —— 字体系统`).
   **Why the bar is this high**: `src/` modules do not `import` each other (§5 item 4) — they are
   flattened into one factory scope at build time ⇒ a directory carries **no machine meaning** on this
   side: there is no resolver and no guard that could verify "layering". Its only job is to let a reader
   see at a glance that these pieces belong together, and a directory of one or two files fails at that
   while still costing a path segment and a move.
   On the `lib/` side directories **carry weight** (Node really resolves relative specifiers, and `files`
   registers file by file) ⇒ the admission conditions differ; do not copy one side's rules to the other.
   Judged by: `test/verify-module-layout.mjs` section ⑥『`src/` 子目录准入』(member count + H1 naming,
   each with a negative control).
2. **Do both sides need it?** (the same data/rules consumed by host and client)
   → put it in `lib/` (host ES `import`) **and** register it in `INLINE_MODULES` (client build-time
   inlining). This is the shape of `lib/settings-schema.js` (the single source of truth for settings
   keys), which is why it is also bound by every constraint in §5 (browser safety).
   **This is the only permitted shared form**; a second shared kernel must be registered explicitly
   (§6's shared-kernel allowlist).
3. **Is it the host's own implementation?**
   → `lib/<semantic-name>.js` **and add it to `files`**. Group by responsibility into subdirectories
   (currently `lib/media/`, `lib/routes/`). The facade `lib/index.js` only registers and aggregates the
   protocol — **it holds no new logic**.
   → **Data files that ship with the package** (not code, but they must travel with it) also live in
   `lib/<semantic-name>/` and **must also be added to `files`**: currently `lib/fontsets/` (shipped
   presets, read-only; user edits land in the plugin data directory via copy-on-write).
   `verify-package-files` P1 requires `files` to cover **every** file under `lib/` — miss one and it goes
   red here.
4. **Is it a third-party copy / type declaration?**
   → vendored code goes in `lib/vendor/` (inlined copy) or `lib/webwallgl/` (a shim injected as text),
   **must not be modified**, and is synced via `test/tools/sync-webwallgl.mjs`;
   → types go in `lib/types/*.d.ts` and **must match the code**.
5. **Is it dev-surface?** (it does not ship)
   → **guards and smoke tests → `test/`** (`verify-*.mjs` structural guards, `*-smoke.mjs` node-level
   smoke, `e2e-*.mjs` real-browser end-to-end);
   → **diagnostics / analysis / generators → `test/tools/`** (manual tools with no CI consumer);
   → **build- and publish-time scripts → `scripts/`** (only things the user or the publish flow actually
   runs, like `build-client.mjs` / `prepare.mjs`).
   ⚠️ `test/tools/` is **one level deeper** than `test/` ⇒ when deriving the repo root from
   `import.meta.url` you must go up **two** levels (pinned by `verify-module-layout`'s
   『相对说明符必须解析到真实文件』).

**One-liner**: *hand-written browser code → `src/` and register the inline; used by both sides → `lib/`
and register the inline; host only → `lib/` and register in `files`; third-party → a vendored
subdirectory; guards → `test/`; tools → `test/tools/`; user scripts → `scripts/`.*

**Anti-patterns (don't do these)**
- Putting a "utility function I extracted along the way" in `lib/` and then inlining it into the browser
  — that is where the boundary starts rotting.
- Creating a file under `src/` without registering it — it silently does nothing (this happened once here).
- Moving a host module into `src/` (or back) to avoid touching an import — the dependency direction
  between the two sides is **one-way** (§6).
- Hand-editing `lib/client.js` so the artifact "looks right".
- Throwing a one-off diagnostic script back into `scripts/` — that directory is only for scripts the user
  or the publish flow actually runs (`test/tools/` is where manual tools live).

### 4.1 Extension points at a glance (where an addition lands)

| What you are adding | Where it lands | What else must be registered |
|---|---|---|
| A host route | `lib/routes/<family>.js` (its own file only once the family is big enough, otherwise nearby) | the route index is recomputed by the generator |
| A setting | `DEFAULTS` + `KINDS` in `lib/settings-schema.js` | the panel reads it — **do not write a second UI table** |
| A piece of browser UI / behaviour | `src/<semantic-name>.js` | `INLINE_MODULES` (**forgetting is silently ineffective**) |
| Anything font-related | `src/font/` (the subdirectory has admission conditions) | see [`FONT-SYSTEM.md`](../FONT-SYSTEM.md) |
| A data file that ships | `lib/<semantic-name>/` | `package.json`'s `files` (P1 checks it) |
| A guard | `test/` (guards) or `test/tools/` (manual tools) | the right chain: `verify` vs `verify:docs` |

Step-by-step recipes (including "what happens if you get it wrong") are in [`DEV-GUIDE.md`](../DEV-GUIDE.md).

---

## 5. Hard constraints (all backed by build- or package-time assertions, not suggestions)

1. **Inlined modules must be browser-safe**: no `import` / `require(` / `export default` / `process.*` /
   `__dirname` / `__filename` (`build-client.mjs` asserts each one, **after stripping comments**).
2. **Inlined modules must not have top-level statements that read host state**: they are injected at the
   **top** of the bundle (before the `src/client.js` body), so a top-level read of a `const` declared in
   the body hits a TDZ.
3. **Names must be unique**: they end up in the same scope as `src/client.js` ⇒ duplicates are
   machine-extracted and asserted at build time; a conflict fails the build.
4. **`src/` modules must not `import` each other**: they cooperate through "the same scope", using the
   **contract** written in their file headers (what they need from outside, what they expose) rather than
   explicit dependencies.
5. **Export shape**: `src/` modules list their public names with `export { … }`; the build strips the
   `export` keyword and `export {}` blocks. **That export list is also the guards' interface** (guards
   `import` modules directly to assert behaviour).
6. **The artifact is committed**: `lib/client.js` is generated but **submitted**; CI asserts
   「after a rebuild, `git diff --exit-code -- lib/client.js` is clean」. **Never hand-edit it.**
7. **Packaging surface**: `files` covers every runtime file under `lib/` (P1); named entries both exist
   and ship (P3); every runtime module's **relative import targets exist on disk** (P7); every
   `dependencies` entry is actually imported by `lib/` (P4); build/verify/smoke chains have **zero bare
   dependencies** (P5); published files **carry no UTF-8 BOM** (P8).
8. **The publish surface must "work once installed, and carry nothing extra"** (the four npm-direction
   rules, see `verify-package-publish`):
   ① every file the live code needs (the **reachable closure** from `lib/index.js`) must be in `files`,
      and every relative import target inside that closure must **exist on disk** — an import pointing at
      a missing file is a dead path in the repo and only blows up on a user's machine as
      `ERR_MODULE_NOT_FOUND`;
   ② the published set must contain no dev directories (`src/` `scripts/` `test/` `docs/`); there is
      exactly one allowlisted exception, `scripts/prepare.mjs` — `prepare` really does run on a git
      install or when the package is executed as a root project, so not shipping it means
      `MODULE_NOT_FOUND` on first run;
   ③ published text must not carry a **sibling machine's** home directory path (placeholders don't count)
      — that is irreproducible metadata;
   ④ every `dependencies` entry must be loaded by the **reachable closure** (an import from dead code
      does not count ⇒ otherwise it is a download for nothing).

### 5.1 Boundaries between layers (what counts as crossing one)

| Boundary | Rule | Backed by |
|---|---|---|
| Host ↔ browser | only through **same-origin HTTP routes**; the browser half must not `import` host code | no local module resolver (structurally impossible) |
| `lib/` → `src/` | **forbidden**: `lib/**` must not import `src/**` (the dependency direction is one-way) | `verify-module-layout` section ② (zero tolerance) |
| Publish surface | everything left in `lib/` ships ⇒ dead code may not stay | `verify-package-files` · `verify-reachability` |
| The facade | `lib/index.js` only registers and aggregates; it holds no new logic | `verify-module-layout` 『路由模块不得继承门面 import』 |
| Comments and docs | mechanisms in file headers, decisions in ADRs, numbers pointing at sources of truth | **convention** (no guard, see [`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md)) |

---

## 6. Guards (registered rules are machine-decided; unregistered ones hold by convention)

> **Only the rules in this table have machine judgement.** A rule that is not here is **not "no rule"** —
> it holds by convention; see the preamble and
> [`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md):
> **guards that read code stay; guards that read prose are not added.**
> The two tiers and the per-item conventions are in [`DEV-GUIDE.md`](../DEV-GUIDE.md) §4.

| Rule | Status | Gap |
|---|---|---|
| Inlined modules are browser-safe / `markers` present / names don't collide with the body | ✅ `scripts/build-client.mjs` (hard build failure) | — |
| `files` covers `lib/`; named entries exist; relative import targets are on disk; no dead dependency declarations; zero bare deps in the toolchain; **no BOM on the publish surface** | ✅ `test/verify-package-files.mjs` P1–P8 (each with negative controls) | — |
| **Publish surface is self-consistent (npm direction)**: reachable closure ⊆ `files` and closure targets exist on disk; no dev directories in the published set (only `scripts/prepare.mjs` is allowlisted); published text carries no **sibling machine** home path; every `dependencies` entry is loaded by **live code**; entry/export targets are inside the package; the published `lib/client.js` is loader-shaped and parses; install-time scripts reference no file that isn't shipped | ✅ `test/verify-package-publish.mjs` (seven groups, each with negative controls) | — |
| `lib/client.js` is in sync with `src/` | ✅ CI (after a rebuild, `git diff --exit-code`) | — |
| **No `src/` orphans**: apart from `src/client.js`, every file must be in `INLINE_MODULES` | ✅ `test/verify-module-layout.mjs` ① (full scan + negative control) | — |
| **One-way dependency direction**: `lib/**` must not import `src/**` | ✅ same guard ② (zero tolerance, no ratchet needed) | — |
| **Shared-kernel allowlist**: the only `lib/**` file allowed to be inlined into the browser comes from an explicit list (see `SHARED_KERNEL_WHITELIST` in the guard) | ✅ same guard ③ (adding one requires editing the list ⇒ sharing is a **decision**, not a convenience) | — |
| **`src/` subdirectory admission**: member count reaches the threshold and an evergreen document's top-level heading names it (the two bars in §4 item 1) | ✅ same guard ⑥『`src/` 子目录准入』(both criteria with negative *and* positive controls) | — |
| **Relative specifiers must resolve to real files**: after moving code, relative paths are re-resolved from the new location (a dynamic `import()` failure happens at runtime and is often swallowed as a business error ⇒ it must be decided statically) | ✅ same guard ④『相对说明符必须解析到真实文件』(Node-style resolution + negative control) | — |
| **The type surface and the code share one source**: `lib/types/*.d.ts` must match the implementation | ✅ `test/verify-types.mjs` (derives the key set from the implementation) | — |

**Removed from this table** (each reason is recorded in its ADR):

| Rule that used to be guarded | Why it was removed |
|---|---|
| **Numbers in this document's prose must be recomputed** (inline module count == build list length) | It guarded **wording**: once a sentence is rephrased, the assertion degrades from "recompute the number" to "keep those two sentences", and it starts blocking edits rather than rot. Values are now carried by **symbol references**. See [`adr/0006`](../adr/0006-comment-discipline-as-written-convention.md) |

**When this document counts as a "specification"**: when §5's hard constraints and §6's registered guards
both hold — both do now. The **process record** of how it got there (how each of the four deviations was
closed) is history and lives in [`archive/REFACTOR-ASSESSMENT.md`](../archive/REFACTOR-ASSESSMENT.md) and
`wip/OPEN-ITEMS.md`; this document does not repeat it.

---

## 7. Where state lives (the source-of-truth list)

| State | Source of truth | Who reads it | Shape |
|---|---|---|---|
| **Every settings key** (defaults / ranges / enums) | `lib/settings-schema.js` | host **and** client | build-time-inlined into the browser (the one shared kernel) |
| **Persisted values** | the host's `config.json` | the host writes; the client reads via the inventory / save endpoints | client `localStorage` is only a cache |
| **The route table** | `docs/ROUTE-INDEX.md` (generated) | humans + guards | recomputed by `test/tools/host-route-index.mjs` |
| **The build-time inline list** | `INLINE_MODULES` in `scripts/build-client.mjs` | the build + guards | carries `markers` anchors |
| **The publish surface** | `package.json`'s `files` | guards P1–P8 | everything left in `lib/` ships |
| **Retired lines / dead-code baseline** | `test/verify-retired-lines.mjs` · `test/verify-reachability.mjs` | guards | may only shrink |

> **Documents never copy these values.** To find the current value: settings in
> `lib/settings-schema.js`, routes in the generated index, counts in `package.json`'s scripts — a copy is
> one more thing nobody recomputes.

---

## 8. The lifecycle of one wallpaper (data flow)

```mermaid
graph TB
    START["user picks a wallpaper (or rotation fires)"] --> ENABLE{"live rendering available?"}
    ENABLE -->|switch off / failure memory / loose scene.json| CHAIN
    ENABLE -->|yes| LIVE["render page iframe<br/>/scene-live + /scene-files"]
    LIVE --> LIVE_OK{"first frame confirmed?"}
    LIVE_OK -->|yes| SHOW["wallpaper layer shown"]
    LIVE_OK -->|no| CHAIN["out-figure chain<br/>(order defined in HOW-IT-WORKS.md)"]
    CHAIN --> PERSIST
    SHOW --> PERSIST["state persisted"]
    PERSIST --> CFG["host config.json<br/>(the only persistent source of truth)"]
    PERSIST --> LS["localStorage<br/>(client cache / device-local fields only)"]
```

> **The members and order of the degradation chain are defined in exactly one place,
> [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)** — this document only draws it as a structural node and
> **does not copy its steps** (a copy would be one more place to forget when the order changes).

**Key structural properties**:

- **Degradation is a chain, not a binary**: every tier that fails hands over to the next, and the last
  one is allowed to stay **honestly empty**.
- **Failure memory has two layers**: **shared settings** (used by every window, persisted) and
  **session-local soft failures** (not persisted). Transfer-class failures only enter the latter — one
  starved transfer must not become a permanent downgrade for every window.
- **Hidden / non-playing instances never pull the payload at all**: the layer gets its `src` late, and
  going to the background swaps it for `about:blank`; otherwise it would compete for bandwidth and
  decoders with the instance that *is* visible.
