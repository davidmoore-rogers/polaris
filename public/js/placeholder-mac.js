// public/js/placeholder-mac.js
//
// One generator for the reserve modals' "Generate" MAC button, shared by the
// desktop IP panel and the mobile subnet sheet. Both had their own byte-for-byte
// copy of this before, which is how the mobile edit path ended up with no button
// at all — a shared helper is what keeps the two surfaces from drifting again.
//
// The MAC is a PLACEHOLDER: a DHCP reservation is a MAC→IP binding, so reserving
// an IP for a device that isn't racked yet needs a MAC before there is a device
// to supply one. The prefix marks it as synthetic so Fortinet discovery can
// later replace it with the real device's MAC and re-push the corrected binding
// (see src/services/placeholderMacAdoptionService.ts). Server-side mirror of the
// same vocabulary lives in src/utils/mac.ts — keep the default in step.

(function () {
  var DEFAULT_PREFIX = "02:0F:5E";

  // Mirrors normalizePlaceholderPrefix() in src/utils/mac.ts: 1–5 hex octets
  // whose first octet is locally-administered unicast. A prefix that fails here
  // falls back to the default rather than producing a MAC outside the space
  // discovery will recognize.
  function normalizePrefix(raw) {
    if (raw === null || raw === undefined) return null;
    var hex = String(raw).toUpperCase().replace(/[^0-9A-F]/g, "");
    if (!hex.length || hex.length % 2 !== 0) return null;
    if (hex.length / 2 > 5) return null;
    var first = parseInt(hex.slice(0, 2), 16);
    if ((first & 0x02) !== 0x02 || (first & 0x01) !== 0) return null;
    return hex.match(/.{2}/g).join(":");
  }

  function generate(prefix) {
    var normPrefix = normalizePrefix(prefix) || DEFAULT_PREFIX;
    var octets = normPrefix.split(":");
    var need = 6 - octets.length;
    var bytes = new Uint8Array(need);
    // crypto.getRandomValues, not Math.random — the value ends up as a DHCP
    // binding on a production gate, and two operators reserving at the same
    // moment must not draw the same one.
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < need; i++) {
      var b = bytes[i].toString(16).toUpperCase();
      octets.push(b.length < 2 ? "0" + b : b);
    }
    return octets.join(":");
  }

  var HINT = "Generate a placeholder MAC for a device that isn't racked yet — "
    + "discovery replaces it with the real one once the device appears at this IP.";

  window.PolarisPlaceholderMac = {
    DEFAULT_PREFIX: DEFAULT_PREFIX,
    normalizePrefix: normalizePrefix,
    generate: generate,
    buttonHint: HINT,
  };
})();
