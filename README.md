# HEPTA-SAT Grand Station Simulator Web

A browser-based ground station simulator for HEPTA-SAT training. This repository contains a static web application designed for deployment with GitHub Pages.

## Live Site

https://hepta-sat-training.github.io/HEPTA-SAT-Grand-Station-Simulator-Web/

## Features

- Real-time ground station dashboard
- Satellite orbit and ground-track visualization
- Telemetry reception, decoding, and display
- Web Serial communication with supported serial devices
- Modular feature selector for future extensions

## Project Structure

- `index.html`: Application entry point and feature view container
- `features.js`: Feature definitions
- `app.js`: Feature selection logic
- `styles.css`: Application shell and feature selector styles
- `public/ground-station.html`: Ground station interface
- `public/`: Maps, orbit libraries, and Three.js assets
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow

The ground station iframe remains mounted when switching features so that the serial connection and application state are preserved.

## Adding a New Feature

1. Add the feature definition to `features.js`.
2. Add a matching `data-feature-view` section to `index.html`.
3. Add any required JavaScript and CSS as separate files.

## Local Development

Serve the repository through a local HTTP server instead of opening the files directly:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/` in Chrome or Edge. Web Serial requires a secure context, such as HTTPS or localhost, and a compatible browser.

## HEPTA XBee / Lab5-03 compatibility

Web Serial opens the XBee adapter at **9600 baud**, matching
`HEPTA-SAT-Flight-Software/GS/Hepta_sat_flightsoftware/main.cpp`. The receiver buffers arbitrary
Web Serial chunks until LF, matching the line-oriented behavior of HEPTA-SAT Serial
Monitor. It accepts both the Lab5-03 `TEMP=...,BUS=...,V5=...` line and Flightware
`V=...,TEMP=...,AX=...` fields. Received hardware telemetry is displayed during
bench tests regardless of the simulated satellite elevation.

Binary HK telemetry uses the reference 30-byte frame and conversions: voltage
ADC count (`V / (3.3 * 1.431) * 4096`), temperature (`degC * 10`), acceleration
(`m/s2 / 9.8 * 512`), gyro (`deg/s * 2048 / 125`), and integer magnetometer uT.
