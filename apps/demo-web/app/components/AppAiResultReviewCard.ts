/**
 * The kit's AI result-review card, registered under an app-owned name — the
 * same one-line re-export pattern as `AppConfirmDialog.ts`. Adopting it here
 * also puts the SFC under this app's `nuxt typecheck`, which is the repo's
 * only vue-tsc coverage of kit components.
 * i18n contract: `ai.review.{title,description,currentValue,apply,dismiss}`.
 */
export { default } from '@octabits-io/nuxt-ui-kit/components/AiResultReviewCard.vue'
