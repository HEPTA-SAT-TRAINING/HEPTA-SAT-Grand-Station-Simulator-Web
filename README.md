# HEPTA-SAT Grand Station Simulator Web

A browser-based ground station simulator for HEPTA-SAT training. This repository contains a static web application designed for deployment with GitHub Pages.

## Live Site

https://hepta-sat-training.github.io/HEPTA-SAT-Grand-Station-Simulator-Web/

## Features

- Real-time ground station dashboard
- Satellite orbit and ground-track visualization
- Telemetry reception, decoding, and display
- HEPTA-SAT V4.1.1 EPS and nine-axis history graphs
- JPEG reception with packet/image CRC validation and one-packet parity recovery
- Web Serial communication with supported serial devices
- Modular feature selector for future extensions

## Project Structure

- `index.html`: Application entry point and feature view container
- `features.js`: Feature definitions
- `app.js`: Feature selection logic
- `styles.css`: Application shell and feature selector styles
- `public/ground-station.html`: Ground station interface
- `public/hepta-image-receiver.js`: telemetry/image stream adapter
- `public/vendor/hepta-serial-monitor`: pinned HEPTA-SAT Serial Monitor submodule
- `tests/verify-protocol.mjs`: fragmented serial/image protocol mock test
- `public/`: Maps, orbit libraries, and Three.js assets
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow

The ground station iframe remains mounted when switching features so that the serial connection and application state are preserved.

## Adding a New Feature

1. Add the feature definition to `features.js`.
2. Add a matching `data-feature-view` section to `index.html`.
3. Add any required JavaScript and CSS as separate files.

## Local Development

Clone with the fixed protocol dependency:

```bash
git clone --recurse-submodules \
  https://github.com/HEPTA-SAT-TRAINING/HEPTA-SAT-Grand-Station-Simulator-Web.git
cd HEPTA-SAT-Grand-Station-Simulator-Web
git submodule status
```

For an existing clone or after switching branches:

```bash
git submodule sync --recursive
git submodule update --init --recursive
git submodule status
```

The Serial Monitor dependency is pinned by the parent gitlink to commit
`399e8ff64f762a4aacfa5d6e518e9d3905738d6a`. Do not use
`git submodule update --remote` for a normal build, because that bypasses the
reproducible version selected by this repository.

Serve the repository through a local HTTP server instead of opening the files directly:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/` in Chrome or Edge. Web Serial requires a secure context, such as HTTPS or localhost, and a compatible browser.

## HEPTA XBee, telemetry, and Lab compatibility

Web Serial opens the XBee adapter at **38400 baud**, matching the existing
HEPTA training XBee pair. The binary frame format and value conversions match
`HEPTA-SAT-Flight-Software/GS/Hepta_sat_flightsoftware/main.cpp`. The receiver buffers arbitrary
Web Serial chunks until LF, matching the line-oriented behavior of HEPTA-SAT Serial
Monitor. It accepts both the Lab5-03 `TEMP=...,BUS=...,V5=...` line and Flightware
`V=...,TEMP=...,AX=...` fields. Received hardware telemetry is displayed during
bench tests regardless of the simulated satellite elevation.

Binary HK telemetry accepts all of the following payload lengths:

- 5 bytes: legacy bus voltage and temperature
- 23 bytes: legacy bus voltage, temperature, and nine-axis data
- 35 bytes: the same 23-byte prefix plus Lab5-03 EPS data

The 35-byte payload appends unsigned-millivolt `V5`, `V3V3`, and `SAP`, then
signed-milliamp `ISOL`, `IBUS`, and `ICHG` fields. Existing offsets and value
conversions remain unchanged: bus voltage ADC count
(`V / (3.3 * 1.431) * 4096`), temperature (`degC * 10`), acceleration
(`m/s2 / 9.8 * 512`), gyro (`deg/s * 2048 / 125`), and integer magnetometer µT.

The text receiver also accepts the exact Lab5-03 line fields:
`TEMP,BUS,V5,V3V3,SAP,ISOL,IBUS,ICHG`. Missing, unknown, or non-numeric fields
are ignored without clearing valid telemetry already on screen.

Commands `a`, `b`, and `p` are sent as single characters. `p` starts the
Lab5-05 JPEG protocol:

```text
IMG_BEGIN\n
HP START/DATA/PARITY/END packets
\nIMG_END\n
```

`public/hepta-image-receiver.js` delegates packet parsing, packet CRC checking,
full-image CRC checking, and XOR parity reconstruction to the public modules in
the pinned HEPTA-SAT Serial Monitor submodule. It only adds stream
demultiplexing, timeout handling, JPEG marker validation, and UI callbacks; the
external implementation is not copied or modified.

The receiver accepts arbitrary Web Serial chunk boundaries and can recover one
missing/corrupt DATA packet. Images are limited to 4,194,048 bytes by the
Library's 64-byte DATA payload and 16-bit packet-count fields. Packet timeout is
10 seconds and overall image timeout is 60 seconds. Image processing is
event-driven, so the page UI remains responsive during reception. The GitHub
Pages workflow also initializes submodules before publishing.

## Verification

Run the mock protocol test with Node.js:

```bash
npm test
```

It exercises the pinned Serial Monitor modules through the production adapter
and verifies arbitrary stream fragmentation, image reconstruction, CRC-16,
one-packet parity recovery, and preservation of telemetry bytes before and
after an image transfer.
