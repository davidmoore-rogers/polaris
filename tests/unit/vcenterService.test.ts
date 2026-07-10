/**
 * tests/unit/vcenterService.test.ts
 *
 * Pure helpers of the vCenter discovery service: external-id selection,
 * cluster mapping, the vMotion-safe dependency-edge builder, VM name
 * filtering, NAA vendor identification, SOAP response parsing, and the
 * REST VM-detail parser.
 */

import { describe, it, expect } from "vitest";

import {
  pickVmExternalId,
  hostExternalId,
  buildClusterHostMap,
  buildVcenterDependencyEdges,
  matchesVmWildcard,
  filterVms,
  vendorFromNaa,
  backingLabelFor,
  extractObjectBlocks,
  parseObjRef,
  parsePropValue,
  parseQuickStatsBlock,
  parseDatastoreBlock,
  parseVmDetail,
} from "../../src/services/vcenterService.js";

const INTG = "11111111-2222-3333-4444-555555555555";

// ─── external ids ───────────────────────────────────────────────────────────

describe("pickVmExternalId / hostExternalId", () => {
  it("prefers instanceUuid (survives vMotion, unique per vCenter)", () => {
    expect(pickVmExternalId({ moref: "vm-42", instanceUuid: "50aa-bb" }, INTG)).toBe("50aa-bb");
  });

  it("falls back to the integration-scoped moref when the uuid is missing", () => {
    expect(pickVmExternalId({ moref: "vm-42", instanceUuid: null }, INTG)).toBe(`${INTG}:vm-42`);
  });

  it("host externalId is always integration-scoped (morefs repeat across vCenters)", () => {
    expect(hostExternalId("host-10", INTG)).toBe(`${INTG}:host-10`);
  });
});

// ─── cluster map + dependency edges ─────────────────────────────────────────

describe("buildClusterHostMap", () => {
  it("maps cluster morefs to member host morefs", () => {
    const map = buildClusterHostMap([
      { clusterMoref: "domain-c8", hostMorefs: ["host-1", "host-2"] },
      { clusterMoref: "domain-c9", hostMorefs: ["host-3"] },
    ]);
    expect(map.get("domain-c8")).toEqual(["host-1", "host-2"]);
    expect(map.get("domain-c9")).toEqual(["host-3"]);
  });
});

describe("buildVcenterDependencyEdges — vMotion-safe multi-parent", () => {
  const hostAssets = new Map([
    ["host-1", "asset-h1"],
    ["host-2", "asset-h2"],
    ["host-3", "asset-h3"],
  ]);
  const clusterByHost = new Map([
    ["host-1", "domain-c8"],
    ["host-2", "domain-c8"],
  ]);
  const clusterMembers = new Map([["domain-c8", ["host-1", "host-2"]]]);

  it("clustered VM gets one edge per cluster-member host (all-down semantics)", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm1", hostMoref: "host-1" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([
      { assetId: "asset-vm1", parentAssetId: "asset-h1" },
      { assetId: "asset-vm1", parentAssetId: "asset-h2" },
    ]);
  });

  it("standalone host → single edge", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm2", hostMoref: "host-3" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([{ assetId: "asset-vm2", parentAssetId: "asset-h3" }]);
  });

  it("hosts without a Polaris asset are skipped, not fabricated", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm3", hostMoref: "host-unknown" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([]);
  });

  it("dedupes repeated (vm, parent) pairs and never self-parents", () => {
    const selfMap = new Map([["host-1", "asset-vm4"]]); // pathological: vm IS the host asset
    const edges = buildVcenterDependencyEdges(
      [
        { vmAssetId: "asset-vm4", hostMoref: "host-1" },
        { vmAssetId: "asset-vm4", hostMoref: "host-1" },
      ],
      selfMap,
      new Map(),
      new Map(),
    );
    expect(edges).toEqual([]);
  });
});

// ─── VM name filter ─────────────────────────────────────────────────────────

describe("matchesVmWildcard / filterVms", () => {
  it("supports prefix, suffix, contains, exact, and star", () => {
    expect(matchesVmWildcard("prod-*", "PROD-SQL01")).toBe(true);
    expect(matchesVmWildcard("*-template", "win2022-template")).toBe(true);
    expect(matchesVmWildcard("*sql*", "prod-SQL01")).toBe(true);
    expect(matchesVmWildcard("exact", "exact")).toBe(true);
    expect(matchesVmWildcard("*", "anything")).toBe(true);
    expect(matchesVmWildcard("prod-*", "dev-sql")).toBe(false);
  });

  it("include wins over exclude when both are set (AD OU-filter semantics)", () => {
    const vms = [{ name: "prod-a" }, { name: "dev-b" }];
    expect(filterVms(vms, ["prod-*"], ["*"])).toEqual([{ name: "prod-a" }]);
    expect(filterVms(vms, [], ["dev-*"])).toEqual([{ name: "prod-a" }]);
    expect(filterVms(vms, [], [])).toEqual(vms);
  });
});

// ─── NAA vendor identification ──────────────────────────────────────────────

describe("vendorFromNaa / backingLabelFor", () => {
  it("identifies known array vendors by NAA OUI prefix", () => {
    expect(vendorFromNaa("naa.624a9370f8a5c2e1d4b3000011112222")).toBe("Pure Storage");
    expect(vendorFromNaa("NAA.624A9370AABBCCDD")).toBe("Pure Storage"); // case-insensitive
    expect(vendorFromNaa("naa.600a098038314c65")).toBe("NetApp");
    expect(vendorFromNaa("naa.60060160abcd")).toBe("Dell EMC Unity/VNX");
    expect(vendorFromNaa("naa.6000c295деад")).toBe("VMware Virtual Disk");
  });

  it("returns null for unknown prefixes and empty input", () => {
    expect(vendorFromNaa("naa.6999999900000000")).toBeNull();
    expect(vendorFromNaa("")).toBeNull();
    expect(vendorFromNaa(null)).toBeNull();
  });

  it("backing label joins distinct VMFS vendors and labels NFS by remote host", () => {
    expect(
      backingLabelFor({
        vmfs: [
          { diskName: "naa.624a9370aa", vendor: "Pure Storage" },
          { diskName: "naa.624a9370bb", vendor: "Pure Storage" },
        ],
      }),
    ).toBe("Pure Storage");
    expect(backingLabelFor({ nas: { remoteHost: "filer01.corp", remotePath: "/vol/ds1" } })).toBe("NFS: filer01.corp");
    expect(backingLabelFor({ vmfs: [{ diskName: "naa.unknown", vendor: null }] })).toBeNull();
    expect(backingLabelFor(null)).toBeNull();
  });
});

// ─── SOAP parsing ───────────────────────────────────────────────────────────

const QUICKSTATS_XML =
  `<returnval><objects>` +
  `<obj type="VirtualMachine">vm-42</obj>` +
  `<propSet><name>config.hardware.memoryMB</name><val xsi:type="xsd:int">8192</val></propSet>` +
  `<propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">50aa-bb</val></propSet>` +
  `<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>` +
  `<propSet><name>summary.quickStats.guestMemoryUsage</name><val xsi:type="xsd:int">2048</val></propSet>` +
  `<propSet><name>summary.quickStats.overallCpuUsage</name><val xsi:type="xsd:int">450</val></propSet>` +
  `<propSet><name>summary.runtime.maxCpuUsage</name><val xsi:type="xsd:int">4400</val></propSet>` +
  `</objects><objects>` +
  `<obj type="VirtualMachine">vm-43</obj>` +
  `<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOff</val></propSet>` +
  `</objects></returnval>`;

describe("SOAP quickStats parsing", () => {
  it("splits object blocks and reads the moref", () => {
    const blocks = extractObjectBlocks(QUICKSTATS_XML);
    expect(blocks).toHaveLength(2);
    expect(parseObjRef(blocks[0])).toBe("vm-42");
    expect(parseObjRef(blocks[1])).toBe("vm-43");
  });

  it("parses scalar propSet values by name", () => {
    const block = extractObjectBlocks(QUICKSTATS_XML)[0];
    expect(parsePropValue(block, "config.instanceUuid")).toBe("50aa-bb");
    expect(parsePropValue(block, "runtime.powerState")).toBe("poweredOn");
    expect(parsePropValue(block, "missing.property")).toBeNull();
  });

  it("maps a full block to quickStats and degrades absent fields to null", () => {
    const blocks = extractObjectBlocks(QUICKSTATS_XML);
    const full = parseQuickStatsBlock(blocks[0]);
    expect(full).toEqual({
      moref: "vm-42",
      instanceUuid: "50aa-bb",
      cpuUsageMhz: 450,
      cpuMaxMhz: 4400,
      guestMemUsageMB: 2048,
      hostMemUsageMB: null,
      memTotalMB: 8192,
      powerState: "poweredOn",
    });
    const sparse = parseQuickStatsBlock(blocks[1]);
    expect(sparse?.moref).toBe("vm-43");
    expect(sparse?.cpuUsageMhz).toBeNull();
    expect(sparse?.instanceUuid).toBeNull();
  });
});

const DATASTORE_VMFS_XML =
  `<objects>` +
  `<obj type="Datastore">datastore-7</obj>` +
  `<propSet><name>host</name><val xsi:type="ArrayOfDatastoreHostMount">` +
  `<DatastoreHostMount><key xsi:type="ManagedObjectReference" type="HostSystem">host-1</key><mountInfo/></DatastoreHostMount>` +
  `<DatastoreHostMount><key xsi:type="ManagedObjectReference" type="HostSystem">host-2</key><mountInfo/></DatastoreHostMount>` +
  `</val></propSet>` +
  `<propSet><name>info</name><val xsi:type="VmfsDatastoreInfo">` +
  `<vmfs><extent><diskName>naa.624a93701234</diskName><partition>1</partition></extent></vmfs>` +
  `</val></propSet>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">pure-ds01</val></propSet>` +
  `<propSet><name>summary.accessible</name><val xsi:type="xsd:boolean">true</val></propSet>` +
  `<propSet><name>summary.capacity</name><val xsi:type="xsd:long">1000</val></propSet>` +
  `<propSet><name>summary.freeSpace</name><val xsi:type="xsd:long">400</val></propSet>` +
  `<propSet><name>summary.type</name><val xsi:type="xsd:string">VMFS</val></propSet>` +
  `<propSet><name>summary.uncommitted</name><val xsi:type="xsd:long">250</val></propSet>` +
  `</objects>`;

const DATASTORE_NAS_XML =
  `<objects>` +
  `<obj type="Datastore">datastore-9</obj>` +
  `<propSet><name>info</name><val xsi:type="NasDatastoreInfo">` +
  `<nas><remoteHost>filer01.corp</remoteHost><remotePath>/vol/ds1</remotePath></nas>` +
  `</val></propSet>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">nfs-ds01</val></propSet>` +
  `<propSet><name>summary.type</name><val xsi:type="xsd:string">NFS</val></propSet>` +
  `</objects>`;

describe("SOAP datastore parsing", () => {
  it("parses a VMFS datastore: host mounts, backing extents, provisioned math", () => {
    const block = extractObjectBlocks(`<r>${DATASTORE_VMFS_XML}</r>`)[0];
    const ds = parseDatastoreBlock(block);
    expect(ds).toMatchObject({
      moref: "datastore-7",
      name: "pure-ds01",
      dsType: "VMFS",
      capacityBytes: 1000,
      freeBytes: 400,
      // capacity - free + uncommitted = 1000 - 400 + 250
      provisionedBytes: 850,
      accessible: true,
      hostMorefs: ["host-1", "host-2"],
      backingLabel: "Pure Storage",
    });
    expect(ds?.backing?.vmfs).toEqual([{ diskName: "naa.624a93701234", vendor: "Pure Storage" }]);
  });

  it("parses an NFS datastore into nas backing with an NFS label", () => {
    const block = extractObjectBlocks(`<r>${DATASTORE_NAS_XML}</r>`)[0];
    const ds = parseDatastoreBlock(block);
    expect(ds?.backing).toEqual({ nas: { remoteHost: "filer01.corp", remotePath: "/vol/ds1" } });
    expect(ds?.backingLabel).toBe("NFS: filer01.corp");
    expect(ds?.provisionedBytes).toBeNull(); // no capacity trio → no math
  });
});

// ─── REST VM detail parsing ─────────────────────────────────────────────────

describe("parseVmDetail", () => {
  const dsByName = new Map([["pure-ds01", "datastore-7"]]);

  it("parses identity, hardware, NICs (connected flag), and disks with datastore names", () => {
    const vm = parseVmDetail("vm-42", "host-1", "list-name", "POWERED_ON", {
      name: "prod-sql01",
      power_state: "POWERED_ON",
      identity: { instance_uuid: "50aa-bb", bios_uuid: "42aa-cc" },
      cpu: { count: 4 },
      memory: { size_MiB: 8192 },
      nics: {
        "4000": { mac_address: "00:50:56:aa:bb:cc", state: "CONNECTED" },
        "4001": { mac_address: "00:50:56:dd:ee:ff", state: "NOT_CONNECTED" },
      },
      disks: {
        "2000": { label: "Hard disk 1", capacity: 107374182400, backing: { vmdk_file: "[pure-ds01] prod-sql01/prod-sql01.vmdk" } },
      },
    }, dsByName);
    expect(vm.instanceUuid).toBe("50aa-bb");
    expect(vm.biosUuid).toBe("42aa-cc");
    expect(vm.name).toBe("prod-sql01");
    expect(vm.cpuCount).toBe(4);
    expect(vm.memoryMiB).toBe(8192);
    expect(vm.nicMacs).toEqual([
      { mac: "00:50:56:aa:bb:cc", connected: true },
      { mac: "00:50:56:dd:ee:ff", connected: false },
    ]);
    expect(vm.disks).toEqual([
      {
        key: "2000",
        label: "Hard disk 1",
        capacityBytes: 107374182400,
        datastoreName: "pure-ds01",
        datastoreMoref: "datastore-7",
      },
    ]);
  });

  it("degrades gracefully on a sparse detail body (falls back to list values)", () => {
    const vm = parseVmDetail("vm-9", "host-2", "orphan-vm", "POWERED_OFF", {}, new Map());
    expect(vm.moref).toBe("vm-9");
    expect(vm.hostMoref).toBe("host-2");
    expect(vm.name).toBe("orphan-vm");
    expect(vm.powerState).toBe("POWERED_OFF");
    expect(vm.instanceUuid).toBeNull();
    expect(vm.nicMacs).toEqual([]);
    expect(vm.disks).toEqual([]);
  });
});
