# @octabits-io/nuxt-ui-kit

## 0.22.0

### Minor Changes

- [`36f21d2`](https://github.com/octabits-io/platform/commit/36f21d268ff88b39cefb65cf70ad2e4a63a91556) - `LocaleInput` / `LocaleTextarea`: `placeholder` accepts a `LocaleMap<string>` beside a plain string, resolved for the active tab through the usual fallback chain (`resolveFieldPlaceholder`, exported from `./locale`). The `#ai` slot scope gains `activeLocale`, so a slotted action can write into the tab the operator is looking at.

## 0.21.0

### Minor Changes

- [`f15e013`](https://github.com/octabits-io/platform/commit/f15e013687333efe58f8bb2c9a552ca77c7bf94f) - `ProposalReviewCard` takes an optional `formatValue(value, operation)` prop: the host's one-line rendering of a structured value, used for the "Current" line of rich-text and JSON-shaped slots. Without it a document still falls back to its compact JSON — faithful, but a reviewer then sees the rich-text editor's document model as raw JSON above every rich-text field.

## 0.20.0

### Minor Changes

- [`ef94c3e`](https://github.com/octabits-io/platform/commit/ef94c3e6b478eac76d7b5d1e4ab9173de750bad0) - Split the AI-UX layer into a framework-free core and Vue bindings.
  
  `@octabits-io/nuxt-ui-kit/ai/core` is new: the workflow poller, the
  cross-page progress store, the card state machine, the active-workflow probe,
  the rehydrate-and-trigger guard, the pausable interval, and the typed workflow
  registry — with no import from Vue, from the rest of the kit, or from any
  vendor (lint-enforced). Each state machine is an observable (`get()` +
  `subscribe()`) plus actions; derived values are pure functions. That is the
  shape React's `useSyncExternalStore` consumes and the shape a Vue `shallowRef`
  mirrors in three lines, so a second framework adapter is a thin file.
  
  The existing composables on `./ai` keep their signatures and behaviour and are
  now those thin files: `useAiWorkflow`, `useAiWorkflowGuard`,
  `createAiProgressCore`, `useAiCardState`, `useActiveAiWorkflowProbe`. Two
  small changes at the edges: the refs they return are read-only computeds
  (nothing was writing to them), and each exposes its core object (`poller`,
  `store`) for hosts that drive it from a push channel. `./ai` re-exports the
  core, so nothing needs a new import path.

- [`a29b501`](https://github.com/octabits-io/platform/commit/a29b5010fe78f44f2b137a99e38c040e373ba6da) - `PageHeader`: a `headingMinWidth` prop for compact record headers whose title
  is content, not chrome.
  
  The compact heading is `flex: 1 1 0%`, so its hypothetical width is zero and
  the action cluster never wraps — the heading takes whatever the buttons leave.
  In a 508px split pane with two labeled actions that was 148px, and a CMS
  page's 78-character title rendered one word per line, 297px tall.
  `headingMinWidth` (px) sets the heading's flex-basis instead, so once the
  floor plus the cluster no longer fit, the cluster wraps under the heading and
  the heading fills the first row. Unset keeps today's behaviour exactly.
  
  The action cluster is also `justify-end` now, so when it wraps internally the
  overflow row keeps the cluster's right edge.

- [`8cc3970`](https://github.com/octabits-io/platform/commit/8cc3970c1d1719927603ce104364504b5bf63e1d) - Add `@octabits-io/framework/proposal` — the reviewable-outcome contract — and a
  generic `ProposalReviewCard.vue` in the kit that renders it.
  
  A workflow outcome expressed as a **set of operations against data that already
  exists**, rather than a value the caller must interpret. `current` is mandatory
  on anything that replaces something, and is captured on the server at emit
  time, so the diff is a stored, auditable artifact rather than something a
  review surface reconstructs by re-reading the entity in a browser.
  
  Four operations, derived from a survey of real multi-step AI workflows rather
  than guessed:
  
  - **`update`** — field values on an existing entity, optionally across a second
    axis (`variant`) such as locale, addressed by a structured `path` that
    reaches leaves inside nested documents and arrays.
  - **`create`** — new rows, including whole trees. A create declares a `ref`
    that other operations anchor to, so a child can name a parent that does not
    exist yet; `existing` marks a create the producer believes is really a link
    to something the host already has.
  - **`delete`** — removal, carrying what is being removed.
  - **`reorder`** — ordered collections, able to place pending creates among
    existing members.
  
  Supporting pieces: `validateProposal`, `orderOperations`, `resolveDecision`,
  `danglingAfterDecision`, `derivedFrom`, `guard` (drift digest), `skipped[]`,
  optional `display` metadata, and zod schemas for both directions of the wire.
  
  The module depends on nothing but zod, imports no other framework module, and
  no other module imports it (lint-enforced as a leaf), so browsers can import it
  and it can be lifted into its own package later without touching anything else.
  It is deliberately **not** part of octaflow: a proposal is defined against a
  step's output schema, never its execution trace, so any engine can emit one.
  
  The kit's `ProposalReviewCard.vue` renders every operation kind, defaults to
  accepting, and emits a `ProposalDecision`; it needs framework `>=0.36.0` (the
  peer range moves accordingly) and ships its `ai.review.*` messages in
  `kitMessagesEn`.

### Patch Changes

- [`e2038e4`](https://github.com/octabits-io/platform/commit/e2038e42e4f08eab3672eb14d5d8414be36241e7) - `./ai`: two fixes found by driving the review loop in a browser.
  
  - `useAiWorkflowGuard` rehydrating an already-terminal run now attaches the
    poll function without polling (`poller.attach`), so `refresh()` re-reads
    the run on demand — an apply's `appliedAt` reaches the surface without a
    page reload. Before, `refresh()` was silently a no-op for a run that was
    finished when the page mounted.
  - The workflow poller fires `onCompleted`/`onFailed`/`onCancelled` on the
    transition into a terminal status only. Re-reading a run that was already
    terminal no longer re-fires the callback (which surfaced as a duplicate
    "ready" toast after every apply).

## 0.19.1

### Patch Changes

- [`3171e02`](https://github.com/octabits-io/platform/commit/3171e028522e8ceea5fb9f36c550e3eeb332d414) - `PageHeader density="compact"` now keeps its one-row promise when the title comes from the `#title` slot.
  
  A wrap container places items by their hypothetical size, so a heading with `basis: auto` claimed its full content width and pushed the action cluster onto a second row before it was ever asked to shrink — the exact failure the prop path already fixed with `flex-1`. Measured on a record header with a slotted identity, three badges and five actions: 93px against the 53px the density delivers.
  
  Slot content must be shrinkable (`min-w-0` + `truncate` on the text inside it). The baseline-aligned inline heading is unchanged.

## 0.19.0

### Minor Changes

- [`dc0a478`](https://github.com/octabits-io/platform/commit/dc0a478da81071e4d01eae75ad6430f944acea8b) - feat(kit): DateRangeInput reports the month on screen, and marks days that are gone
  
  `blockedDates` is a prop, so a parent can only ever have fetched a finite
  window — but the calendar pages anywhere, and past the fetched edge a blocked
  day renders as free. `DateRangeInput` now emits `visible-month` (the ISO first
  day of the month) when a popover opens and on every navigation inside it, so
  the parent can widen its fetch to what is actually being looked at.
  
  Days before today are dimmed (`text-dimmed`) in both popovers, and a period
  that lies entirely in the past says so under the inputs
  (`dateRange.pastPeriod`, added to `kitMessagesEn`). Neither disables anything:
  recording a stay that already happened is ordinary work — misreading which
  year you are paging through is the mistake worth catching.

- [`51e47af`](https://github.com/octabits-io/platform/commit/51e47afe0b28a7011e1ece51aea0ef09b397aa61) - `./i18n`: `KitMessages` now covers every namespace the kit actually reads.
  
  The fragment documented itself as "the reference for the full key set" while
  carrying four of them — `errors`, `auth`, `localeField`, `pageChrome`. The
  components' own contracts (`dateInput.clear`, `dateRange.*`, `flexPeriod.*`,
  `period.*`, `ai.review.*`) were missing, so a consumer that merged
  `kitMessagesEn` and trusted the type still had to discover those keys by
  watching a raw key path render in a date picker. All of them ship now, with
  English defaults, and a test derives the required set from the component
  sources so the type cannot drift from the components again.
  
  **Type-level breaking for apps that build their own locales:** `KitMessages`
  is exhaustive by design (that is what makes it a checklist), so a
  `const de: KitMessages = { … }` object now fails to compile until the new
  namespaces are translated. Spreading `kitMessagesEn` as a base is unaffected,
  and no runtime behaviour changes.

### Patch Changes

- [`5acce36`](https://github.com/octabits-io/platform/commit/5acce362976cb7f5bb3ba25bcb205dcb2e8b3111) - `PageHeader`: make `density="compact"` actually hold one row.
  
  Truncating the subtitle (0.9.3) was only half the fix. A `flex-wrap` container
  places its items by their *hypothetical* size, and for a `truncate`d line
  (`white-space: nowrap`) that is still the full text width — so the heading was
  allowed to claim the row and the action cluster wrapped onto a second one
  *before* the subtitle was ever asked to shrink. The band that promises one row
  still became two whenever the subtitle was long and the pane narrow (observed
  in a ~600px detail pane in `apps/demo-web`).
  
  The heading is now `flex: 1 1 0%`, whose hypothetical size is zero: it can
  never push a sibling onto another row, and it grows into whatever the action
  bar leaves. The compact title truncates too, for the same reason the subtitle
  does — a title long enough to wrap makes the band the exact height `compact`
  exists to avoid.
  
  The subtitle now also yields before the title does (`basis-0 grow` instead of
  sharing the shrink): with both merely truncating, a ~350px detail pane clipped
  the record's own name to a letter or two while its timestamp still read in
  full — the wrong half survived. It now takes only the width the title leaves.
  
  Only `density="compact"` is affected; `default` and `flush` are unchanged, as
  are compact headers that fill the `#title` slot themselves.

- [`5acce36`](https://github.com/octabits-io/platform/commit/5acce362976cb7f5bb3ba25bcb205dcb2e8b3111) - `pruneLocaleMap` now returns a dense `Record<string, string>` instead of
  `LocaleMap<string>`.
  
  Emptiness is exactly what the function removes, so the sparse return type made
  every caller cast: an API whose request body is `Record<string, string>` — the
  shape a validator normally infers for a per-locale map — rejects values typed
  `string | undefined`, which is the one thing a pruned map is guaranteed not to
  contain. Assigning the result back into a `LocaleMap<string>` stays legal, so
  existing callers keep compiling.

## 0.18.0

### Minor Changes

- [`b9bd6c9`](https://github.com/octabits-io/platform/commit/b9bd6c9b6d7cf3b7e2a7c6b7de43a97fe2c4588d) - `DateInput`: add `size` and `clearable`.
  
  `size` forwards to the trigger button (the calendar popover itself never
  shrinks — a hard-to-hit day cell is a worse trade than a tall button), so the
  input can sit in a dense filter panel of `xs` controls without standing a head
  taller than everything around it.
  
  `clearable` puts an × beside the trigger once a date is set, emitting `''`. A
  calendar can only ever PICK — clicking the selected day again re-selects it —
  so until now there was no way back to "no date". That is fine for a required
  field and wrong for anything optional, a filter bound above all. Off by
  default, so existing required fields are unchanged.
  
  Two `DateInput`s are also now the documented way to build an **open-ended**
  range ("since March"); `DateRangeInput` models a stay and therefore wants both
  bounds and at least one day between them.
  
  New optional i18n key: `dateInput.clear` (falls back to "Clear" when absent).

## 0.17.5

### Patch Changes

- [`82c61e2`](https://github.com/octabits-io/platform/commit/82c61e2e3ffd26c1b1470941c0ec7db975b152fd) - fix(kit): FlexiblePeriodInput's clear button no longer appears under the pointer — the first "+" on nights used to mount the X beside the input and shift the input left by one button, so the next click cleared the field. The X is now always in the layout and merely invisible until something is set. DateRangeInput caps each date field at 14rem when side by side (a date is a fixed-length value), and FlexiblePeriodInput keeps window, nights and clear together on the left instead of stretching the window across the row.

## 0.17.4

### Patch Changes

- [`5127fd0`](https://github.com/octabits-io/platform/commit/5127fd069ba99f847d5f5ba86f44af683b4faeb1) - `PageAction`: a button blocked with `disabledReason` no longer fires its click handler.
  
  The blocked branch's root is the tooltip, whose trigger is `as-child`, so an inherited `@click` landed on the hover span — and because the disabled button beneath it is `pointer-events-none`, every click on it reached the span and ran the parent's handler. "Send Proposal" and "Confirm & Publish" on a request with missing fields rendered disabled and still opened their dialogs. Attrs are now bound onto the button explicitly (`inheritAttrs: false`), where a disabled control is inert.

## 0.17.3

### Patch Changes

- [`e243baa`](https://github.com/octabits-io/platform/commit/e243baa038d7f40347a95eb22f4d3afcb25536f4) - **PageActions: a collapsed AI row no longer renders under Delete.**
  
  AI items bound to the overflow menu (explicit `visibility: 'menu'`, or `'auto'`
  in a header too narrow to hold them) were appended after every menu section.
  Destructive rows are the last-declared section by convention, so the AI group
  always landed below them — a "Generate page content" row reading as an
  afterthought to the deletion.
  
  They now sit with the other collapsed actions, ahead of the menu-only sections.
  The ordering rule moved out of the SFC into `buildMenuActionGroups` in
  `pageActions.ts`, where it is pure and tested.

## 0.17.2

### Patch Changes

- [`2692f4e`](https://github.com/octabits-io/platform/commit/2692f4e525f30976afe368d74a29e4eab76c7ae2) - PageActions: don't draw the utility separator when nothing precedes it
  
  The vertical rule before the utility cluster was rendered whenever a utility
  region existed, without checking that anything had been rendered to its left.
  A header whose only content is the Help trigger — a record route that declares
  no actions of its own — therefore drew a rule dividing Help from nothing.
  
  It is now gated on there being leading content: inline actions, the AI cluster,
  or a non-empty overflow menu.

## 0.17.1

### Patch Changes

- [`6c26780`](https://github.com/octabits-io/platform/commit/6c26780d8e9c07181da37275a1c9b791ef8155e4) - `PageHeader` `density="compact"`: a long inline subtitle now truncates instead of pushing the action cluster onto a second row.
  
  The wrapper is `flex-wrap`, so a subtitle without `min-w-0` + `truncate` kept its min-content width, won the line, and wrapped the actions below it — a "compact" band that came out taller (101px) than the stacked two-line version it replaced (85px). `compact` promises one row; a subtitle long enough to truncate belongs in a help panel, not in chrome.
  
  `SubSidebar`'s visually-hidden `<h1>` now renders only when `headerless`. Without it the rail draws its own visible heading, so a second invisible one for the same shell is noise — a nested settings layout announced "Settings" twice before the page's own name.

- [`6c26780`](https://github.com/octabits-io/platform/commit/6c26780d8e9c07181da37275a1c9b791ef8155e4) - useHelpPanel: a registration now belongs to the component that made it
  
  Consumers key help registrations by *surface*, so several pages legitimately
  share one tab value — an admin console where every flat page registers
  `'detail'` is the motivating case. On a client-side navigation Vue runs the
  incoming component's `setup()` before the outgoing one's `onUnmounted`, so the
  calls arrive as register(new) → unregister(old). Removal was by key alone, so
  the departing component deleted its successor's registration and the Help
  trigger disappeared for the rest of the session — every arrival wiped by the
  page it had just replaced.
  
  Removal is now owner-checked, and `register` returns a disposer that removes
  only its own registration (a stale disposer is a no-op). `unregister(tab)` is
  unchanged for existing callers; registrations made outside a component have no
  owner and are still removed unconditionally.

## 0.17.0

### Minor Changes

- [`a0e4955`](https://github.com/octabits-io/platform/commit/a0e4955831cbd0bce4f8b221ac234d963d87a015) - `PageHeader` `density="compact"` is now genuinely compact, and the heading block is optional.
  
  `compact` used to differ from `default` only in title size: it still spent `py-4` on a title with the subtitle stacked underneath, which on a split-pane view (`SubSidebar`'s `#header` slot sits outside the scroll container) is ~85px of chrome that never scrolls away.
  
  - Subtitle renders **beside** the title rather than under it, and the padding is sized to the action buttons (`py-2.5`) instead of to two text lines. Title drops `text-lg` → `text-base`. ~85px → ~53px.
  - The inline treatment applies only when `PageHeader` itself renders the heading. A `#title` slot carries its own layout, so slot users keep the wrapper they were laid out against.
  - The heading block is skipped entirely when there is no `title`, `subtitle`, `#title` slot or `loading` — a compact band may legitimately carry actions alone, where the page name is already in the breadcrumb above it.
  
  `SubSidebar` now renders a visually-hidden `<h1>` with its `title`, so a split view keeps a heading when its header slot no longer repeats the page name and nothing is selected in the detail column.

## 0.16.0

### Minor Changes

- [`f7c44c7`](https://github.com/octabits-io/platform/commit/f7c44c7e9d83c8e2e5149669a6377a8ea0859f96) - PageActions: decision groups — fold mutually exclusive answers into one inline control
  
  `PageActionsItem` gains an optional `group?: PageActionsGroup` descriptor. Items
  sharing a group render inline as a single outline trigger labeled with the
  question, with the members as dropdown rows; in the overflow menu they stay flat
  rows in a section of their own.
  
  The bar previously had exactly two inline weights — one solid primary and N
  identical ghosts — so a set of alternative outcomes ("record yes / no / no
  answer") was indistinguishable from the unrelated tools beside it. A group is
  the rank between "inline button" and "buried in ⋯".
  
  The trigger renders solid when any inline member carries `tone: 'primary'`, so
  the one-solid-primary rule survives folding. A group with a single available
  member unwraps to an ordinary button rather than a chevron over one row.
  
  Additive and backwards compatible: items without `group` are unchanged.
  
  **Also: `utilityCollapseBelow`** — an earlier collapse stage for the utility
  region alone (utility items + the Help trigger), so a header that does not fit
  sheds the things that change nothing before it sheds an action.
  
  Below `collapseBelow` the fallback was `flex-wrap`, so between that threshold
  and "actually fits" a crowded bar wrapped into two or three rows instead of
  collapsing — silently, and dropping nothing, so the wrap point was arbitrary.
  Defaults to `collapseBelow`, i.e. no separate stage and no change for any
  caller that does not ask for one.

### Patch Changes

- [`a4fd8a5`](https://github.com/octabits-io/platform/commit/a4fd8a5339b4eb8a3ac4c6775f66f5213309bb6c) - `usePagination`: accept an async `onPaginationChange`
  
  The hook is a fire-and-forget refetch notification, and the loader passed to
  it is almost always `async`. Typing it `() => void` made every such call site
  a `@typescript-eslint/no-misused-promises` finding at every call site for
  a shape that is correct by design. It now accepts `() => void | Promise<void>`
  and the watcher `void`s the result explicitly.

## 0.15.0

### Minor Changes

- [`55ef671`](https://github.com/octabits-io/platform/commit/55ef67140a2ceb486fb42be45a6b215320d1846c) - **Breaking:** remove the Eden Treaty client factory. `createTreatyClientFactory` and its `TreatyClientFactoryOptions` type are gone from `./api`, along with the `@elysiajs/eden` and `elysia` optional peer dependencies.

  `./api` keeps the two seams that were never Eden-specific — `resolveApiBaseUrl` and `createAccessTokenProvider` — so a consumer on Hono's `hc` only drops the factory. Build the client with `hc` (prefer the API package's pre-compiled `hcWithType`) and inject the bearer through `hc`'s own async `headers` thunk:

  ```ts
  const getToken = createAccessTokenProvider(getUserManager);
  const client = hcWithType(getBaseUrl(), {
    headers: async () => {
      const token = await getToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
  });
  ```

  Eden's `parseDate` has no counterpart and needs none: `hc` returns exactly what `res.json()` produced, so `YYYY-MM-DD` fields stay plain strings — the behavior the old factory had to opt into with `parseDate: false`.

  `createApiErrorMessenger` still unwraps `{ value }` error envelopes; that tolerance is kept and is simply inert for clients that don't box the body.

## 0.14.2

### Patch Changes

- [`f3bd07a`](https://github.com/octabits-io/platform/commit/f3bd07ac7cc68c0512c84bf7fad5b775f4f0957b) - Render page-header actions at `md` instead of `sm`

  `PageAction`, the built-in Help trigger, the ⋯ menu trigger, the back button and
  the header AI cluster all rendered at Nuxt UI's `sm` size, i.e. `text-xs`. Next
  to their own icons — and next to every `md`-sized button in the page body — the
  labels read as shrunken. They now render at `md` (`text-sm`, the Nuxt UI
  default), which keeps the same horizontal padding.

  `AiButton` keeps its `sm` default for in-page triggers; only the header cluster
  opts up.

## 0.14.1

### Patch Changes

- [`482d9a9`](https://github.com/octabits-io/platform/commit/482d9a981d035e81b773f1e3f228db1469f2aedc) - Locale field tabs now lead with the default content locale instead of following
  the app's stored locale order. `useLocaleTabs` already activates the default
  locale, so an app whose locale set is `['en', 'de']` with `de` as the default
  rendered `[EN][DE]` with DE selected — a strip that claims a primary language
  the field does not use, on every translatable field at once. The remaining
  locales keep their source order.

## 0.14.0

### Minor Changes

- [`52dfa78`](https://github.com/octabits-io/platform/commit/52dfa787bcd3188d726a83a74aeb7e3617b703dd) - DateRangeInput and FlexiblePeriodInput are now container-responsive for small/mobile widths. DateRangeInput stacks its two date inputs below 320px of own width (the arrow gives way to compact per-input labels); FlexiblePeriodInput drops the nights input + clear button to their own line below 512px, with the nights input gaining a compact label and full width when stacked.

  Sizing contract change: both roots are now inline-size `@container`s, so their intrinsic width is 0. Parents must provide a definite width (block/grid context, `flex-1`, or an explicit `w-*`/`basis-*`) — shrink-to-fit parents (e.g. an unconstrained `flex flex-wrap` filter bar) will collapse them and need an explicit width on the wrapping field.

## 0.13.0

### Minor Changes

- [`91c12a9`](https://github.com/octabits-io/platform/commit/91c12a968a5f0e684c3f0bdfa9659e75556a4082) - Add the events stack: cross-process, two-lane event fan-out with SSE delivery.

  framework:

  - `./events` — `EventEnvelope` (+ Zod schema), the notify wire codec, `createEventHub` (in-process per-scope fan-out with audience/permission filtering, fail-closed), `createEventPublisher` (`emit(event, tx?)`; durable events append to the outbox in the caller's transaction — throws so a failed append rolls the state change back), `createEventRelay` (notification → outbox → hub with per-scope watermark and bigserial-gap recovery), and `createEventStreamHandler` — the SSE endpoint as a **plain fetch handler** (heartbeats, capped connection age, `Last-Event-ID` replay with lookback, per-subscriber connection caps, `x-accel-buffering: no`), registrable via `.mount()` with zero Elysia type budget.
  - `./events/postgres` — `createPgNotifyListener`: one dedicated LISTEN connection per process (`pg` optional peer), full-jitter reconnect, `onReconnect` catch-up hook.
  - `./drizzle/event-outbox` — `eventOutboxColumns` (spreadable, no `pgTable`; bigserial `id` is the envelope `seq`) + `createDrizzleEventOutboxStore`: outbox INSERT + `pg_notify` pointer in the same transaction (durable), inline notify with an 8000-byte guard (ephemeral), `readSince`, `prune`.
  - `./elysia/events` — `createEventStreamRoute`, the thin `.use()`-style wrapper (literal-generic prefix) over the fetch handler.

  nuxt-ui-kit:

  - `./events` — `createEventStreamClient`: fetch-based SSE reader (header auth, so `Last-Event-ID`/reconnect are implemented here), full-jitter backoff with a `degraded` state past a threshold, durable-only watermark, bounded seen-id dedupe; `createSseFrameParser`; `useEventStream` Vue composable with reactive connection state.

## 0.12.0

### Minor Changes

- [`771692c`](https://github.com/octabits-io/platform/commit/771692c6f89a987b22ca7160c1064a965f72eb26) - AI trigger normalization: new `AiButton` primitive (sparkles + primary-soft + verb label — the single visual token for "AI acts on data"), and `PageActionsItem` gains `kind: 'ai'` + `description`. PageActions renders AI items as their own cluster: one inline item → verb-labeled AiButton, several → a labeled "AI ∨" dropdown (icons + descriptions per row, i18n key `pageChrome.ai`); collapsed AI items form their own group in the ⋯ menu.

## 0.11.0

### Minor Changes

- [`96bd71b`](https://github.com/octabits-io/platform/commit/96bd71b3ccd44ce6c9f8e115bd846e7dc62348bb) - PageActions: new `help` prop (default `true`) to suppress the built-in Help trigger in nested/panel headers where the page-level header already owns Help.

## 0.10.0

### Minor Changes

- [`ca1eae5`](https://github.com/octabits-io/platform/commit/ca1eae530fea37e481a04f7535a1dba963b9a074) - New `PageActions` component: a declarative, width-aware page-header action cluster. One `PageActionsItem[]` describes every action; `visibility: 'always' | 'auto' | 'menu'` controls placement, and below a header-width threshold (measured by `PageHeader` via ResizeObserver, provided as `PAGE_HEADER_WIDTH`) all `auto` items, utility items, and the Help trigger collapse into the ⋯ menu with their labels intact. Exports `PageActionsItem`, `PAGE_HEADER_WIDTH`, `PAGE_ACTIONS_COLLAPSE_BELOW`.

## 0.9.1

### Patch Changes

- [`be72fa8`](https://github.com/octabits-io/platform/commit/be72fa8e4bf2d30ccbc8ecc18beb3025770b756b) - PageHeader: the actions/utility cluster now wraps on narrow viewports. Previously it was a no-wrap flex row, so labeled actions pushed the overflow menu and Help button off-screen on mobile.

## 0.9.0

### Minor Changes

- [`053cf62`](https://github.com/octabits-io/platform/commit/053cf622544c6eef7bf30331f19354de646df1b0) - PageAction: new `disabledReason` prop. When set, the button renders disabled and the tooltip shows "label — reason", so a blocked action keeps its purpose visible instead of the reason replacing the label. The disabled-hover span wrapper (disabled buttons don't dispatch pointer events) is handled internally — consumers no longer need the outer-UTooltip + `pointer-events-none` workaround.

## 0.8.0

### Minor Changes

- [`16f9a89`](https://github.com/octabits-io/platform/commit/16f9a89235e47664c0413d4ccd7d5806043e5cf5) - Add `FlexiblePeriodInput` component (date window + stay length in nights, composing `DateRangeInput kind="travel"`) and `calculateNights` date helper (exclusive-end night count).

## 0.7.0

### Minor Changes

- [`abb78b7`](https://github.com/octabits-io/platform/commit/abb78b782e69ad01c956c24de2650850caf45bd4) - i18n fragments are English-only: `kitMessagesDe` and `kitMessagesDeFormal` removed

  The kit no longer ships translations beyond English. `kitMessagesEn` doubles as
  the reference for the full key set; apps define their other locales themselves
  as `KitMessages` objects, keeping every translation (and its register/voice)
  app-side. Consumers of the removed German fragments should copy them into their
  own locale files.

## 0.6.0

### Minor Changes

- [`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438) - i18n fragments gain `errors.exclusion_violation`

  Matches the framework's new `exclusion_violation` database error code (SQLSTATE
  23P01, e.g. overlapping range EXCLUDE constraints). `KitMessages` has a new
  required key, so hand-built message objects need the entry; consumers merging
  the shipped fragments are unaffected.

### Patch Changes

- Updated dependencies [[`b57afc7`](https://github.com/octabits-io/platform/commit/b57afc7618acf7f93182713442a92d9728b5e438)]:
  - @octabits-io/framework@0.4.0

## 0.5.0

### Minor Changes

- [`92208e9`](https://github.com/octabits-io/platform/commit/92208e9a2f310f9ee8be33487f92b8ea0371dbe3) - SubSidebar: new `railVisibilityClass` / `toggleVisibilityClass` props so consumers can drive the rail-vs-slideover switch from a container query instead of the viewport (defaults keep the previous `lg:` behavior).

## 0.4.0

### Minor Changes

- [`fc274ea`](https://github.com/octabits-io/platform/commit/fc274ead5423583626444fbd2122db794a1d372f) - `createAiProgressCore` accepts an optional `onTerminal(tracked)` callback, fired once per tracked workflow when polling observes its transition to a terminal status — alongside the existing `completionSignal` bump, but identifying which workflow finished. Enables per-workflow notifications (completion toasts, badges) in consumers.

## 0.3.2

### Patch Changes

- [`e97bfd8`](https://github.com/octabits-io/platform/commit/e97bfd8064067d3ea7f8d03c0d7cb03531af91f7) - Widen the `vue-router` peer range from `^4` to `^4.5.0 || ^5.0.0` (matching `@nuxt/ui`). Nuxt 4.4+ ships vue-router 5, so the old range left the peer unlinkable — pnpm resolved a second router copy for the kit's source-shipped SFCs (`SubSidebar.vue`, `PageHeader.vue`), whose `useRoute()`/`useRouter()` then found no injection and crashed at render time, forcing consumers to work around it with `resolve.dedupe: ['vue-router']`. The kit only uses `useRoute`, `useRouter`, and `RouteLocationRaw`, which are identical across both majors. After bumping, consumers can drop the dedupe workaround.

## 0.3.1

### Patch Changes

- [`130a3ce`](https://github.com/octabits-io/platform/commit/130a3ce838122433deb06810b3106fb2df26358a) - Add `@octabits-io/nuxt-ui-kit/styles.css` — registers the source-shipped
  components as Tailwind v4 sources via `@source "./components"`. Without it,
  utility classes used only inside kit SFCs (e.g. `SubSidebar`'s default
  `w-[240px]`) are missing from consumer builds because Tailwind's automatic
  source detection skips `node_modules`, letting long sidebar item text stretch
  the layout. Consumers add `@import "@octabits-io/nuxt-ui-kit/styles.css";`
  after their Tailwind/`@nuxt/ui` imports.

## 0.3.0

### Minor Changes

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - Split the root barrel by peer weight and add small drops:

  - **Breaking (pre-1.0 minor):** the OIDC harness moved to the new `./auth` subpath and the Eden Treaty client factory to `./api`. The root barrel keeps only the peer-light surface (composables, org store core), so importing a composable no longer welds `oidc-client-ts` / `@elysiajs/eden` to the consumer — both are now optional peers.
  - `createTreatyClientFactory` accepts a `headers` option, layered after the bearer injector, so consumers can add or override headers without losing Authorization injection.
  - New `resolveRuntimeConfigValue(appConfigKey, fallback?)` (root): the `window.__APP_CONFIG__` → build-time-fallback lookup, SSR-safe.
  - New `./i18n` subpath: `kitMessagesEn` / `kitMessagesDe` / `kitMessagesDeFormal` fragments covering the `errors.*` keys of `createApiErrorMessenger` and the `auth.*` session-lifecycle keys (German in both du/Sie registers).

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - New `./locale` subpath: the locale-map field editor subsystem (extraction catalog [#59](https://github.com/octabits-io/platform/issues/59), the UI half of framework's `LocaleMap`):

  - `useLocaleTabs` / `useLocaleField` — per-locale tab engine with completeness indicators, register-variant (`de-formal`) inheritance (hidden by default, blank override inherits its base, clearing deletes the key), and quick-translate source/target derivation. Locales come in as a reactive `{ locales, defaultLocale }` source param.
  - `createLocaleDisplay` — collapse a `LocaleMap` to its default-content-locale string for list surfaces.
  - `pruneLocaleMap` — drop `''` leaves so cleared tabs stop shadowing the fallback locale.
  - `LOCALE_FIELD_CONTEXT` + `provideLocaleFieldContext` / `useLocaleFieldContext` — app wiring for the components: a `useSource` factory and an optional `useTranslate` provider (the AI-translate button renders only when provided), both invoked in the component's own setup.
  - Source-shipped components: `LocaleInput.vue`, `LocaleTextarea.vue`, `LocaleTab.vue`, `TranslationBadge.vue` (i18n contract `localeField.*`, messages included in `./i18n`).

  `@octabits-io/framework` (`./utils` locale toolkit) becomes an optional peer, needed only for `./locale`.

- [`f71bc25`](https://github.com/octabits-io/platform/commit/f71bc25b357332461c535e100408948fc7e7f9fa) - Page-chrome layer (extraction catalog [#61](https://github.com/octabits-io/platform/issues/61)):

  - Source-shipped components `PageHeader.vue` / `PageAction.vue` / `PageActionMenu.vue` / `PageUtilityActions.vue` — standardized page header with enforced conventions (max 3 neutral inline icon actions, destructive actions only in the overflow menu, labeled utility buttons), density variants, tooltip/aria normalization. i18n contract `pageChrome.*` (messages included in `./i18n`).
  - `useHelpPanel` + `HELP_PANEL_KEY` (root): provide/inject registry for a per-tab contextual help panel — actions keyed by active tab, open state persisted to a configurable localStorage key, auto-close on tabs without actions.
  - `useWizardStepValidation` (on `./zod`): gates a stepper + form wizard by validating only the current step's fields via `schema.pick(...)` — `currentStepValid` / `goNext` / `goPrev` over structural form/stepper surfaces.

## 0.2.1

### Patch Changes

- [`78a2a88`](https://github.com/octabits-io/platform/commit/78a2a880710084db50ddbaa187928ca4b27c0273) - Fix a type error in `SubSidebar.vue`'s mobile toggle. The inline `@click="open = true"` compiled to a handler returning `boolean`, which is not assignable to `UButton`'s `onClick` type (`(event) => void | Promise<void>` — a union, so TypeScript's "a value-returning function is assignable to a void-returning signature" rule does not apply). Any consumer running `vue-tsc` over the source-shipped SFC hit `TS2322`. The handler is now a named `openSidebar()` function.

- [`3f6c42f`](https://github.com/octabits-io/platform/commit/3f6c42fcb36ffce685b3db89338a1c046f787bfb) - Fix `createApiErrorMessenger`'s validation lookups being undefinable: field paths and message texts are now slugged (lowercased, non-alphanumeric runs collapsed to `_`) before the `validation.fields.<slug>` / `validation.messages.<slug>` lookups, so dotted paths (`items.0.email` → `items_0_email`) and punctuated messages (`Expected string to match 'email'` → `expected_string_to_match_email`) resolve to flat, definable vue-i18n keys instead of always falling through to raw values.

## 0.2.0

### Minor Changes

- [`014a2f0`](https://github.com/octabits-io/platform/commit/014a2f0518169be0136a6466c784d404db6c01a7) - First release (extraction-catalog items 01 + 06 + 07 + 08 + 26 + 27 — the complete Phase B kit): OIDC session harness over `oidc-client-ts` (`createUserManagerFactory`, stale-key cleanup, unrecoverable-renew classification, `createLoginRedirector`, `attachSessionLifecycleHandlers`, Zitadel scope presets), dev/E2E `seedAuthBypassSession` with an unconditional production-build refusal, `createAuthSessionCore` + `createOrgStoreCore` store cores (the app wraps them in its own Pinia stores), `createAuthGuard` route-guard builder with an injected per-app policy hook, an Eden Treaty client factory (`createTreatyClientFactory`, bearer injection, `parseDate: false` default) with `createAccessTokenProvider` / `resolveApiBaseUrl`, `createApiErrorMessenger` (errors._ / validation._ i18n key convention, injected `t`/`te`), the promise-based `useConfirm`/`useConfirmState` pair with a `./components/ConfirmDialog.vue` renderer, `useDirtyTracking` + `usePagination`, `./components/SubSidebar.vue` (responsive list/detail layout with a configurable selection query key), `./zod` `setupZodLocaleSync`, `./dates` (`Period`/`calculateDays`/`shiftIso`, `useDateRangeInput`, `createDateFormatter` + source-shipped `DateInput`/`DateRangeInput`/`PeriodDisplay` components with travel/booking end-date semantics and injected blocked-dates/availability seams), and `./ai` (frontend AI-workflow engine: `useAiWorkflow`/`useAiWorkflowGuard` over injected transport, `createAiProgressCore` cross-page tracking with completion/applied signals, `useAiCardState`, `useActiveAiWorkflowProbe`, `createWorkflowRegistry`, `AiResultReviewCard.vue`). Components ship as `.vue` source with fully explicit imports (`@nuxt/ui/components/*.vue`); `@nuxt/ui`, `vue-i18n`, `vue-router`, `zod`, `date-fns`, and `@internationalized/date` are optional peers.
