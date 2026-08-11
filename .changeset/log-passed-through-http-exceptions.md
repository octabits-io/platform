---
'@octabits-io/framework': patch
---

fix(hono): log `HTTPException`s instead of passing them through silently

`registerErrorHandler`'s `onError` returned `error.getResponse()` for any
`HTTPException` before reaching the logger, so that branch — the one Hono's own
middleware uses — produced no server-side trace at all. Every other error path
was logged, which made the gap easy to miss: an API could serve a steady stream
of 400s while its logs showed nothing but pod lifecycle lines.

The errors this hid are the ones with no other trace either. Hono raises
`HTTPException` for a malformed JSON body, an unparseable `FormData` body and a
failed bearer check, and answers with a bare `text/plain` body — which a client
expecting the framework's JSON error envelope cannot read. Such a failure was
observable from neither side. (Found in reynt: a bodyless request that carried a
JSON content-type turned into `400 Malformed JSON in request body`, and the
console could only report a generic "Bad Request".)

`HTTPException`s are now logged before their response is returned: 5xx at error
level with the error itself, 4xx at warn, both carrying
`http.request.method`, `url.path` and `http.response.status_code`. The response
is unchanged. Only >= 400 is logged, since `HTTPException(status, { res })` is
also the supported way to answer with an exact `Response` from deep inside a
handler and a successful one of those is not an error event.
