---
'@octabits-io/nuxt-ui-kit': minor
---

PageAction: new `disabledReason` prop. When set, the button renders disabled and the tooltip shows "label — reason", so a blocked action keeps its purpose visible instead of the reason replacing the label. The disabled-hover span wrapper (disabled buttons don't dispatch pointer events) is handled internally — consumers no longer need the outer-UTooltip + `pointer-events-none` workaround.
