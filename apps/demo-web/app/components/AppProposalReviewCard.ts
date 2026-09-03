/**
 * The kit's generic proposal review card, registered under an app-owned name —
 * the same one-line re-export pattern as `AppAiResultReviewCard.ts`. Adopting
 * it here also puts the SFC under this app's `nuxt typecheck`, which is the
 * repo's only vue-tsc coverage of kit components.
 *
 * Renders a `Proposal` (`@octabits-io/framework/proposal`) and emits a
 * `ProposalDecision`; the host posts that to whatever applies it
 * (`POST /api/ai/workflows/:id/apply` in the demo server).
 * i18n contract: `ai.review.*` from `kitMessagesEn`, plus whatever `labelKey`s
 * the producer put on its operations (`ai.brief.fields.*` here).
 */
export { default } from '@octabits-io/nuxt-ui-kit/components/ProposalReviewCard.vue'
