---
"@octabits-io/framework": patch
---

`./mail/smtp`: the optional `nodemailer` peer range now accepts v10 (`^7 || ^8 || ^9 || ^10`). Nodemailer 10's only breaking change is requiring Node 20+; it now ships its own type declarations, so a consumer on v10 no longer needs `@types/nodemailer`.
