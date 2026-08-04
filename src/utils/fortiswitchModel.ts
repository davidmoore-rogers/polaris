/**
 * src/utils/fortiswitchModel.ts — FortiSwitch model extraction from fsSysVersion.
 *
 * FORTINET-FORTISWITCH-MIB::fsSysVersion (1.3.6.1.4.1.12356.106.4.1.1) is the
 * only SNMP object on a FortiSwitch that carries the hardware model, but it's
 * a combined string: the model token followed by the firmware version, e.g.
 *
 *   "S548DF-v7.2.5-build0453,230511 (GA)"   → model "S548DF"
 *   "S124EN-v6.4.6-build470,210316 (GA)"    → model "S124EN"
 *
 * FMG / FortiGate discovery has no model field for managed switches (the
 * observed blob carries the literal "FortiSwitch"), so this parse — run during
 * the direct-SNMP system-info scrape — is the only source of the real model.
 *
 * The returned value is prefixed "FortiSwitch " (e.g. "FortiSwitch S548DF").
 * That prefix is LOAD-BEARING, not cosmetic: vendor telemetry profile matching
 * (`pickVendorProfile`) tests /fortiswitch/i against the haystack
 * `${manufacturer} ${os} ${model}`, and FortiSwitch assets carry no `os` — so
 * a bare "S548DF" model would drop the asset out of the FortiSwitch profile
 * into the generic Fortinet/FortiGate one, whose OIDs (12356.101 root) a
 * FortiSwitch doesn't expose. The persisted ManufacturerProfile override's
 * modelPattern ("FortiSwitch", regex-tested against the model) keeps matching
 * for the same reason.
 */

/**
 * Extract the model from a raw fsSysVersion string. Returns the display model
 * ("FortiSwitch <token>") or null when the string doesn't carry a
 * recognizable model prefix (empty value, firmware-only string, etc.).
 */
export function fortiswitchModelFromFsSysVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Model token = everything before the first "-v<digit>" firmware marker.
  // Non-greedy so a hypothetical hyphenated model token still stops at the
  // first version-looking segment.
  const m = /^(.+?)-v\d/.exec(trimmed);
  const token = m?.[1]?.trim();
  if (!token) return null;
  // A string that STARTS with the firmware marker has no model prefix.
  if (/^v\d/i.test(token)) return null;
  return `FortiSwitch ${token}`;
}
