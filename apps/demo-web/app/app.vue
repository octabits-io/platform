<script setup lang="ts">
import { provideLocaleFieldContext } from '@octabits-io/nuxt-ui-kit/locale'
import { LOCALE_FIELD_SOURCE } from '~/lib/contentLocales'

useHead({
  titleTemplate: (title) => (title ? `${title} · Contact Desk` : 'Contact Desk'),
})

/**
 * The locale-field context, provided once at the root — `LocaleInput` /
 * `LocaleTextarea` / `TranslationBadge` resolve it wherever they mount.
 *
 * `useSource` is a *factory the kit calls during the field's own setup*, not a
 * value: a real app resolves the tenant's configured locales from a store or
 * the route there. This demo's set is static, so it just hands back the
 * constant.
 *
 * `useTranslate` is deliberately omitted. It is the seam behind the fields'
 * sparkle button, and without it the button never renders — which is exactly
 * what a deployment with no translation backend should get, rather than a
 * button that fails when pressed.
 */
provideLocaleFieldContext({ useSource: () => LOCALE_FIELD_SOURCE })
</script>

<template>
  <!-- UApp provides the toast/overlay portals the kit's ConfirmDialog and the
       pages' toasts render into. -->
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
