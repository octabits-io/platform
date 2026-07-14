<script setup lang="ts">
/**
 * Never actually rendered: the global auth middleware sends `/` to
 * `/dashboard` (its `afterAuthenticated` policy hook) or to `/login`. The route
 * still has to exist for the router to match `/` and run that middleware.
 */
definePageMeta({ layout: false })
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <UIcon name="i-lucide-loader-2" class="size-6 animate-spin text-primary" />
  </div>
</template>
