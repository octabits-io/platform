---
"@octabits-io/nuxt-ui-kit": patch
---

Add `@octabits-io/nuxt-ui-kit/styles.css` — registers the source-shipped
components as Tailwind v4 sources via `@source "./components"`. Without it,
utility classes used only inside kit SFCs (e.g. `SubSidebar`'s default
`w-[240px]`) are missing from consumer builds because Tailwind's automatic
source detection skips `node_modules`, letting long sidebar item text stretch
the layout. Consumers add `@import "@octabits-io/nuxt-ui-kit/styles.css";`
after their Tailwind/`@nuxt/ui` imports.
