---
'@octabits-io/framework': minor
---

elysia client-ip: trusted proxies now accept CIDR ranges (`10.0.0.0/8`, `2001:db8::/32`) alongside exact IPs and `'*'`. Enables replacing `trustedProxies: ['*']` with the actual proxy networks in environments where proxy addresses are ephemeral (Kubernetes ingress/sidecar pods), closing the spoofed-XFF rate-limit bypass. IPv4/IPv6 with embedded-v4 and v6-mapped forms handled; invalid entries are still silently dropped (a typo narrows trust, never widens it).
