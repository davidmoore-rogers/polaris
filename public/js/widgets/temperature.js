/**
 * widgets/temperature.js — hottest hardware temperature sensors, PER SENSOR
 * (one row per (asset, sensor name), latest reading, always °C). Thin wrapper
 * over the shared _topnBar renderer; data from /dashboard/noc-summary
 * temperature[]. Like Highest CPU/Memory/Disk the Row limit governs the top-N
 * shown and every red row (≥80 °C) always shows even past the limit.
 */

(function () {
  var THRESHOLDS = [{ over: 80, color: "#ff1744" }, { over: 65, color: "#ffd600" }];
  var EMPTY = "No temperature telemetry";

  function render(el, config, rows) {
    PolarisTopN.renderRows(el, rows || [], {
      unit: "°C", thresholds: THRESHOLDS, baseColor: "#4fc3f7", emptyText: EMPTY, config: config || {}, fillTo: 20,
    });
  }

  PolarisWidgets.register({
    type: "temperature",
    category: "Monitoring",
    label: "Highest Temperature",
    description: "Hottest hardware temperature sensors across monitored assets, per sensor.",
    defaultSize: { width: 4, height: 1 },
    minSize: { width: 3, height: 1 },
    defaultConfig: { rowLimit: 20, regionScope: "mine" },
    requiredPermission: { key: "assets", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["temperature"]).then(function (d) { return (d && d.temperature) || []; }).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      render(el, config, data);
      var timer = setInterval(function () {
        PolarisWidgets.getNocSummary(PolarisWidgets.nocFilterOpts(config), ["temperature"]).then(function (d) { render(el, config, (d && d.temperature) || []); }).catch(function () {});
      }, 60000);
      ctx.onUnmount(function () { clearInterval(timer); });
    },

    renderPreview: function (el) {
      render(el, { rowLimit: 3 }, [
        { id: "p1", hostname: "fgt-plant-a", detail: "CPU Temp", value: 84 },
        { id: "p2", hostname: "core-sw-01", detail: "Intake", value: 68 },
        { id: "p3", hostname: "fgt-dc-west", detail: "PS1 Temp", value: 46 },
      ]);
    },

    renderConfig: function (el, config, onChange) {
      // No "Hide below" control: Row limit governs the top-N shown; every red
      // row (≥80 °C) always shows even past the limit.
      PolarisTopN.renderConfig(el, config, onChange, {});
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, true);
    },
  });
})();
