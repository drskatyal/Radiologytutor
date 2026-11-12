# C1 public origin trust boundary

`lib/trustedHost.ts` is the single server/Edge origin policy. The Worker sends
`X-FlowRad-Proxy-Secret`, matched against server-only `TRUSTED_PROXY_SECRET`, and
overwrites `X-Forwarded-Host` with its configured public hostname. Never forward
client values for either header. Provision the shared value in the Worker and
Cloud Run outside this repository; never put it in a public env variable, URL,
response or log. The example env file intentionally contains no value.

Comparison uses native Web Crypto HMAC verification over a fixed public message:
SHA-256 hashes each secret to a fixed 32-byte key before signing/verifying. This
also avoids raw HMAC keys' equivalence under trailing NUL padding. The configured
secret's derived key signs and the supplied secret's derived key verifies.
The native fixed-size MAC comparison is constant-time; JavaScript never compares
secret strings or exits on a matching prefix. Missing/empty secrets and oversized
headers are rejected; crypto errors fail closed without logging their inputs.
The module works in both Node route handlers and Next's Edge middleware.

Only after authentication does the helper accept a single ASCII DNS hostname
(including ASCII punycode). It rejects ports, URL components, whitespace, header
lists, escaped characters, invalid DNS labels and noncanonical numeric IP forms.
Authenticated origins use HTTPS; forwarded protocol headers have no authority.
No host selection depends on ordinary `Host`, `Forwarded` or `NEXT_PUBLIC_APP_URL`.

Every unsuccessful authentication/validation path uses the origin of
`BETTER_AUTH_URL`. If that variable is absent, the existing fixed local-development
default is `http://localhost:3000`, never a request-derived value. Configure
BETTER_AUTH_URL explicitly for deployment. Invalid schemes or userinfo fail with
a generic configuration error that contains no supplied value. Paths on the
configured URL are stripped when deriving its origin.

Audited consumers:

- Robots, sitemap, layout and landing metadata call `seoForRequest`, which uses
  the shared helper. The existing known-public-domain allowlist still controls
  indexing; unrecognized preview/local domains disallow crawling and have empty
  sitemaps. Configured schemes/ports are preserved on recognized origins.
- Viewer canonical, Open Graph and Twitter metadata use the helper directly.
- Middleware resolves the trusted origin before applying the existing product
  redirects, replacing both upstream hostname and port while preserving query
  parameters. It never clones a public redirect onto `run.app`.
- Relative studio voice-sample URLs use the same helper. No provider or remote
  voice request is made by C1 tests.
- Better Auth's module-level baseURL and origin allowlist remain pinned to
  `configuredPublicOrigin()` (BETTER_AUTH_URL), rather than widened by requests.
  Its old NEXT_PUBLIC_APP_URL fallback is removed.

Client-side `window.location.origin` checks are browser same-origin boundaries
for postMessage, local caches and local share links. They cannot access the Worker
secret and do not derive a server public origin from headers. Fixed product links
and the explicit learn-to-viewer redirect destination remain product routing.
Upstream DICOM/CDN/provider URLs are separate backend configuration.

Tests use public synthetic secret strings only. Unit console spies assert that
the configured secret is absent from logs, generated SEO, middleware responses
and errors. Real localhost Playwright routes cover robots, sitemap, page metadata
and redirects without following public-domain redirects or contacting a Worker.
Production Worker/Cloud Run configuration and cutover are **not verified here**.
All Gemini behavior remains mocked: **live contract not verified**.
