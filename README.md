# NASA Open MCT Astonishing Sparkline Plugin

An external plugin for [NASA Open MCT](https://github.com/nasa/openmct) that introduces a telemetry-driven sparkline plotting visualization component. This plugin extends Open MCT's core visualization capabilities by providing compact, high-density inline charts designed for rapid situational awareness in mission control environments.

## Table of contents

- [Features](#features)
- [Setup & Installation](#setup--installation)
- [Usage & Architecture](#usage--architecture)
- [Automated Testing](#automated-testing)
- [License](#license)

## Features

- **Real-time sparklines:** Subscribes to real-time telemetry streams using the Open MCT Telemetry API to render instantaneous trend updates.
- **Historical data plotting:** Requests and populates historical telemetry intervals to provide immediate context upon layout initialization.
- **High performance:** Optimized for multi-signal tracking dashboards without degrading dashboard UI responsiveness.

## Setup & Installation

Follow these steps to run the plugin development server locally or package it for production:

1. **Node environment:** Ensure `nvm` (Node Version Manager) is installed on your system.
2. **Version matching:** Open a terminal at the project root directory and run:
   ```bash
   nvm install
   nvm use
   ```
   *This automatically locks into the proper Node.js version specified in the project's `.nvmrc` file.*
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Local development:** Run the local development server with hot-reloading:
   ```bash
   npm start
   ```
5. **Production build:** Compile and minify the sparkline plugin artifact for distribution:
   ```bash
   npm run build
   ```

## Usage & Architecture

The plugin interfaces directly with the Open MCT API layer. It showcases advanced implementation patterns for:
- **TelemetryCollection:** Manages real-time data subscriptions and triggers sub-second graph redraws.
- **CompositionCollection:** Dynamically hooks into parameter dictionaries and dictionary layouts.

To integrate this visualization into an Open MCT application instance, import the build distribution file and register it inside your main application configuration sequence:

```javascript
import OpenMCTSparklinePlugin from 'nasa-openmct-astonishing-sparkline';

openmct.install(OpenMCTSparklinePlugin());
```

## Automated testing

The project includes an end-to-end (E2E) testing suite engineered for Open MCT plugin infrastructure:

- **E2E test execution:** Run the automated browser verification suites locally via:
  ```bash
  npm run test:e2e:ci
  ```
- **Visual regression testing:** Validate component rendering integrity across design iterations:
  ```bash
  npm run test:e2e:visual
  ```

## License

This project is licensed under the Apache License 2.0. See the `LICENSE` file for the full legal text.
