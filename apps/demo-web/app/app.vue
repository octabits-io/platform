<script setup lang="ts">
useHead({
  titleTemplate: (title) => (title ? `${title} · Contact Desk` : 'Contact Desk'),
})
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
