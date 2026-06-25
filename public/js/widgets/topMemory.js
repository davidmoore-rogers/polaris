/**
 * widgets/topMemory.js — top-N monitored assets by latest memory%. Shares the
 * _topnBar renderer + CPU thresholds; data from noc-summary topMemory[].
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No memory telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
    });
  }

  PolarisWidgets.register({
    type: "topMemory",
    category: "Monitoring",
    label: "Highest Memory",
    description: "Monitored assets with the highest average memory usage (last 10 polls).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5, threshold: null, regionScope: "all" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { return (d && d.topMemory) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { render(el, config, (d && d.topMemory) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "db-srv-04", value: 95 },
        { id: "p2", hostname: "vm-host-09", value: 81 },
        { id: "p3", hostname: "core-sw-01", value: 60 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: the list always shows every red row (≥90%) and
      // pads to a 20-row floor with the next-highest (see _topnBar fillTo).
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
