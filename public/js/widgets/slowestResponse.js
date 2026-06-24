/**
 * widgets/slowestResponse.js — top-N monitored assets by latest probe response
 * time (ms). Shares the _topnBar renderer; data from noc-summary
 * slowestResponse[].
 */

(function () {
  var THRESHOLDS = [{ over: 500, color: "#ff1744" }, { over: 200, color: "#ffd600" }];
  var EMPTY = "No response-time data";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "ms", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {},
    });
  }

  PolarisWidgets.register({
    type: "slowestResponse",
    category: "Monitoring",
    label: "Slowest Response",
    description: "Monitored assets with the highest last-probe response time.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 5, threshold: null },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function () {
      return PolarisWidgets.getNocSummary().then(function (d) { return (d && d.slowestResponse) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary().then(function (d) { render(el, config, (d && d.slowestResponse) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "branch-fw-22", value: 640 },
        { id: "p2", hostname: "wan-rtr-03", value: 280 },
        { id: "p3", hostname: "core-sw-01", value: 90 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      PolarisTopN.renderConfig(el, config, onChange, {
        thresholdLabel: "Hide below (ms)",
        thresholdOptions: [{ value: "", label: "Show all" }, { value: 75, label: "75 ms" }, { value: 200, label: "200 ms" }, { value: 500, label: "500 ms" }],
      });
    },
  });
})();
