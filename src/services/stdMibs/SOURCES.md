# Standard MIB sources

These seven canonical MIB modules back the SNMP Walk tab's browse tree for
built-in MIBs (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`,
`std:entity`, `std:entity-sensor`, `std:lldp`). They are loaded by
[../stdMibLibrary.ts](../stdMibLibrary.ts) at first use.

Re-pull via:

```
node scripts/fetch-std-mibs.mjs
```

Source mirror: <https://mibs.pysnmp.com/> (tracks IETF + IEEE upstreams).

## Files

| Module | std key | Root OID | Source URL | SHA-256 | Bytes |
|---|---|---|---|---|---|
| `SNMPv2-MIB` | `std:system` | `1.3.6.1.2.1.1` | <https://mibs.pysnmp.com/asn1/SNMPv2-MIB> | `0990746329a32c698157c633aa70d31b3c638e397ec15477ddaccc544a5473c4` | 31542 |
| `IF-MIB` | `std:interfaces` | `1.3.6.1.2.1.2` | <https://mibs.pysnmp.com/asn1/IF-MIB> | `91df18ae09db2df6a85d519c23533514c81e5464d44da4f21a4465ec9449e752` | 71751 |
| `HOST-RESOURCES-MIB` | `std:host-resources` | `1.3.6.1.2.1.25` | <https://mibs.pysnmp.com/asn1/HOST-RESOURCES-MIB> | `d3fd6069f18055375e1fbb1708f31c13f71528b8addb2ffd5bddc69e58d3c876` | 56653 |
| `ENTITY-MIB` | `std:entity` | `1.3.6.1.2.1.47` | <https://mibs.pysnmp.com/asn1/ENTITY-MIB> | `e56b77653a23171405dbae2431ed3f411dbe311e6ce1222cfd4cffd29dfe2e0c` | 65951 |
| `ENTITY-SENSOR-MIB` | `std:entity-sensor` | `1.3.6.1.2.1.99` | <https://mibs.pysnmp.com/asn1/ENTITY-SENSOR-MIB> | `51e878b065f5cd70361173ca3f37f8bb20509556eb82cd086a057dce66a66fa1` | 16145 |
| `LLDP-MIB` | `std:lldp` | `1.0.8802.1.1.2` | <https://mibs.pysnmp.com/asn1/LLDP-MIB> | `be01b2eecf2fc2031219fd4a676e2341ccf7be9d98b03794c422f7a7db117c74` | 77320 |

## Licensing

- **IETF RFC-derived MIBs** (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB,
  ENTITY-SENSOR-MIB) carry the IETF Trust legal provisions — permissive, allows
  bundling and redistribution.
- **LLDP-MIB** (IEEE 802.1AB) carries an IEEE-specific copyright header. IEEE
  historically allows reproduction of standalone MIB modules; the boilerplate is
  preserved in the file. Re-read the in-file header on every refresh and have a
  human verify before committing significant version changes.
