import installHelloPlugin from "./HelloPlugin";
import openmct from "openmct";
import astonishingSparkline from './plugins/astonishing-sparkline.js';

(() => {
  const THIRTY_MINUTES = 30 * 60 * 1000;

  // 1. Instalar primero todos los plugins base del sistema
  installDefaultPlugins();
  openmct.install(installHelloPlugin());
  
  // 2. INSTALAR TU SPARKLINE (Esto faltaba en tu código)
  openmct.install(astonishingSparkline({
    maxSamples: 300,
    bgColor: "#0b1020",
    lineColor: "#00e0a3",
    lineWidth: 2,
    title: "Mi Sparkline NASA"
  }));

  // 3. Configurar el Conductor de tiempo
  openmct.install(
    openmct.plugins.Conductor({
      menuOptions: [
        {
          name: "Realtime",
          timeSystem: "utc",
          clock: "local",
          clockOffsets: {
            start: -THIRTY_MINUTES,
            end: 0,
          },
        },
        {
          name: "Fixed",
          timeSystem: "utc",
          bounds: {
            start: Date.now() - THIRTY_MINUTES,
            end: 0,
          },
        },
      ],
    }),
  );

  // 4. Arrancar Open MCT SIEMPRE al final de todo el flujo de configuración
  document.addEventListener("DOMContentLoaded", function () {
    openmct.start();
  });

  function installDefaultPlugins() {
    openmct.install(openmct.plugins.LocalStorage());
    openmct.install(openmct.plugins.MyItems());
    openmct.install(openmct.plugins.Espresso());
    openmct.install(openmct.plugins.example.Generator()); // <-- ESTE OBJETO TE SERVIRÁ PARA PROBARLO
    openmct.install(openmct.plugins.example.ExampleImagery());
    openmct.install(openmct.plugins.UTCTimeSystem());
    openmct.install(openmct.plugins.TelemetryMean());

    openmct.install(
      openmct.plugins.DisplayLayout({
        showAsView: ["summary-widget", "example.imagery", "yamcs.image"],
      }),
    );
    openmct.install(openmct.plugins.SummaryWidget());
    openmct.install(openmct.plugins.Notebook());
    openmct.install(openmct.plugins.LADTable());
    openmct.install(
      openmct.plugins.ClearData([
        "table",
        "telemetry.plot.overlay",
        "telemetry.plot.stacked",
      ]),
    );

    openmct.install(openmct.plugins.FaultManagement());
  }
})();
