// Sets the flag that suppresses the legacy auto-init in blocks.js + subnets.js.
// Must load BEFORE blocks.js and subnets.js so their `if (!window.__polarisIpamTabs)`
// guards see the flag and skip their DOMContentLoaded handlers — ipam.js
// (loaded later) calls _initBlocksPage() / _initSubnetsPage() on demand when
// the operator switches tabs. This was an inline `<script>` in ipam.html until
// CSP `script-src 'self'` started blocking it; externalizing keeps the same
// behavior without needing a CSP nonce or hash.
window.__polarisIpamTabs = true;
