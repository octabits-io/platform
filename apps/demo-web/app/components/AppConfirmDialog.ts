/**
 * The kit's confirm-dialog renderer, registered under an app-owned name.
 *
 * One-line re-export is the documented way to adopt a source-shipped kit SFC:
 * Nuxt picks the component up by filename, and the SFC itself is compiled by
 * this app's Vite.
 *
 * Mounted exactly once (in `layouts/default.vue`). That matters: `useConfirm`'s
 * state is module-scoped inside the kit, and the renderer reaches it by
 * importing the kit's package *root* — the same specifier feature code uses —
 * so both resolve to one module instance and one dialog.
 */
export { default } from '@octabits-io/nuxt-ui-kit/components/ConfirmDialog.vue'
