/**
 * widgets/topMemory.js — top-N monitored assets by latest memory%. Shares the
 * _topnBar renderer + CPU thresholds; data from noc-summary topMemory[].
 */

(function () {
  var THRESHOLDS = [{ over: 90, color: "#ff1744" }, { over: 75, color: "#ffd600" }];
  var EMPTY = "No memory telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {},
    });
  }

  PolarisWidgets.register({
    type: "topMemory",
    category: "Monitoring",
    label: "Highest Memory",
    description: "Monitored assets with the highest recent memory usage.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5, threshold: null },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function () {
      return PolarisWidgets.getNocSummary().then(function (d) { return (d && d.topMemory) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary().then(function (d) { render(el, config, (d && d.topMemory) || []); }).catch(function () {});
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
      PolarisTopN.renderConfig(el, config, onChange, {
        thresholdLabel: "Hide below %",
        thresholdOptions: [{ value: "", label: "Show all" }, { value: 50, label: "50%" }, { value: 70, label: "70%" }, { value: 90, label: "90%" }],
      });
    },
  });
})();
