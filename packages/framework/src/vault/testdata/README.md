# Test fixtures — not secrets

Self-signed `CN=localhost` certificate + private key used only by
`loadVaultSecrets.test.ts` to spin up an in-process HTTPS server and exercise
the `VAULT_CACERT` code path. Generated with a 100-year validity; regenerate
with:

```bash
openssl req -x509 -newkey rsa:2048 -keyout self-signed-localhost.key.pem \
  -out self-signed-localhost.cert.pem -days 36500 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
