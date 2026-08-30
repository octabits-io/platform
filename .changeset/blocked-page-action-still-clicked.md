---
"@octabits-io/nuxt-ui-kit": patch
---

`PageAction`: a button blocked with `disabledReason` no longer fires its click handler.

The blocked branch's root is the tooltip, whose trigger is `as-child`, so an inherited `@click` landed on the hover span — and because the disabled button beneath it is `pointer-events-none`, every click on it reached the span and ran the parent's handler. "Send Proposal" and "Confirm & Publish" on a request with missing fields rendered disabled and still opened their dialogs. Attrs are now bound onto the button explicitly (`inheritAttrs: false`), where a disabled control is inert.
