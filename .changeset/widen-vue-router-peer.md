---
'@octabits-io/nuxt-ui-kit': patch
---

Widen the `vue-router` peer range from `^4` to `^4.5.0 || ^5.0.0` (matching `@nuxt/ui`). Nuxt 4.4+ ships vue-router 5, so the old range left the peer unlinkable — pnpm resolved a second router copy for the kit's source-shipped SFCs (`SubSidebar.vue`, `PageHeader.vue`), whose `useRoute()`/`useRouter()` then found no injection and crashed at render time, forcing consumers to work around it with `resolve.dedupe: ['vue-router']`. The kit only uses `useRoute`, `useRouter`, and `RouteLocationRaw`, which are identical across both majors. After bumping, consumers can drop the dedupe workaround.
