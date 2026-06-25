/**
 * widgets/topCpu.js — top-N monitored assets by latest CPU%. Thin wrapper over
 * the shared _topnBar renderer; data from /dashboard/noc-summary topCpu[].
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No CPU telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
    });
  }

  PolarisWidgets.register({
    type: "topCpu",
    category: "Monitoring",
    label: "Highest CPU",
    description: "Monitored assets with the highest average CPU load (last 10 polls).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5, threshold: null, regionScope: "all" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { return (d && d.topCpu) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config)).then(function (d) { render(el, config, (d && d.topCpu) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "core-sw-01", value: 93 },
        { id: "p2", hostname: "edge-fw-02", value: 78 },
        { id: "p3", hostname: "app-srv-11", value: 54 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: the list always shows every red row (≥90%) and
      // pads to a 20-row floor with the next-highest (see _topnBar fillTo).
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
