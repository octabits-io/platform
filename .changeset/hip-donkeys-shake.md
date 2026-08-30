---
'@octabits-io/nuxt-ui-kit': patch
---

PageActions: don't draw the utility separator when nothing precedes it

The vertical rule before the utility cluster was rendered whenever a utility
region existed, without checking that anything had been rendered to its left.
A header whose only content is the Help trigger — a record route that declares
no actions of its own — therefore drew a rule dividing Help from nothing.

It is now gated on there being leading content: inline actions, the AI cluster,
or a non-empty overflow menu.
