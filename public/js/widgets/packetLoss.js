/**
 * widgets/packetLoss.js — top-N monitored assets by recent probe packet loss
 * (failed-probe ratio %, computed server-side). Shares the _topnBar renderer;
 * data from noc-summary packetLoss[]. Defaults to hiding rows below 1%.
 */

(function () {
  var THRESHOLDS = [{ over: 25, color: "#ff1744" }, { over: 5, color: "#ffd600" }];
  var EMPTY = "No packet loss";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "%", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {},
    });
  }

  PolarisWidgets.register({
    type: "packetLoss",
    category: "Monitoring",
    label: "Packet Loss",
    description: "Monitored assets with the highest recent probe loss (failed-probe ratio).",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5, threshold: 1 },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function () {
      return PolarisWidgets.getNocSummary().then(function (d) { return (d && d.packetLoss) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary().then(function (d) { render(el, config, (d && d.packetLoss) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3, threshold: 1 }, [
        { id: "p1", hostname: "branch-fw-22", value: 40 },
        { id: "p2", hostname: "wan-rtr-03", value: 12.5 },
        { id: "p3", hostname: "ap-lobby-07", value: 3 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      PolarisTopN.renderConfig(el, config, onChange, {
        thresholdLabel: "Hide below %",
        thresholdOptions: [{ value: "", label: "Show all" }, { value: 1, label: "1%" }, { value: 5, label: "5%" }, { value: 25, label: "25%" }],
      });
    },
  });
})();
