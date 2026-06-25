/**
 * widgets/diskUsage.js — top monitored filesystems by used %. One row PER VOLUME
 * (host + mount path), ranked fullest-first. Thin wrapper over the shared
 * _topnBar renderer; data from /dashboard/noc-summary diskUsage[]. Like Highest
 * CPU/Memory it shows every red row (≥90%) and pads to a 20-row floor.
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No storage telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
    });
  }

  PolarisWidgets.register({
    type: "diskUsage",
    category: "Monitoring",
    label: "Highest Disk Usage",
    description: "Monitored filesystems with the highest used percentage, per volume.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { regionScope: "all" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { return (d && d.diskUsage) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { render(el, config, (d && d.diskUsage) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, {}, [
        { id: "p1", hostname: "db-srv-04", detail: "/var", value: 96 },
        { id: "p2", hostname: "vm-host-09", detail: "C:", value: 82 },
        { id: "p3", hostname: "app-srv-11", detail: "/", value: 57 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: shows every red row (≥90%) + a 20-row floor.
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
