# LD2410 for Home Assistant

**English** | [繁體中文](README.zh-Hant.md)

Integration for HiLink **LD2410** Bluetooth Low Energy (BLE) mmWave radar sensors.
This integration allows Home Assistant to interface directly with LD2410 devices over Bluetooth.

Fork of [megarushing/ha-ld2410](https://github.com/megarushing/ha-ld2410) (MIT) with a sidebar tuning panel and password hardening.

## Features
- Real-time motion and occupancy detection using the LD2410 radar.
- Distance and energy measurements for moving and stationary targets.
- Per-gate energy sensors for detailed zone analysis.
- A **雷達調校** (radar tuning) sidebar panel that walks you through empty-room, interference and presence tests, so you never need the phone app, plus an absence watch that finds occasional false triggers.

## Recommended Setup

For best results, 
- Use an [ESPHome Bluetooth Proxy](https://esphome.io/components/bluetooth_proxy.html) to connect your LD2410 to Home Assistant.
- Use firmware version 2.44.24073110 or higher on your LD2410 device. 
  - If your device has an older firmware, you can update it using the HLKRadarTool app on [Android](https://play.google.com/store/apps/details?id=com.hlk.hlkradartool&hl=en) or [iOS](https://apps.apple.com/us/app/hlkradartool/id1638651152).
- The radar accepts one Bluetooth connection at a time. Close the HLKRadarTool app while Home Assistant is connected.
- If you ever run into issues, you can reset to factory defaults by connecting and disconnecting power from the device 5 times.

## Entities

🏠 **Occupancy** – overall presence state combining motion and static data. Use this sensor for automations; it clears only when both motion and static detection are absent.

🏃 **Motion** – turns on when movement is detected, making it ideal for instant motion-triggered automations.

🧍 **Static** – indicates a stationary presence so lights or HVAC can remain active even after motion stops.

🔌 **OUT pin** – reports the current state of the device’s hardware output pin for wiring diagnostics.

📏 **Detect distance** – distance at which a target is detected (cm); helps tune sensor placement.

🌞 **Photo sensor** – onboard light level (0‑255) for integrating ambient light into automations.

🎯 **Motion gate energy sensors (0‑8)** – energy level of each motion gate (0‑100%); inspect these to fine‑tune motion zones.

🧊 **Static gate energy sensors (0‑8)** – energy level of each static gate (0‑100%); with them its possible to detect presence in individual spots of a room.

📡 **Moving distance** – distance to the closest moving target (cm).

📍 **Still distance** – distance to the closest stationary target (cm).

⚡ **Moving energy** – strongest gate energy of a moving target, indicating motion intensity.

🔋 **Still energy** – strongest gate energy of a stationary target.

📈 **Max motion gate** – index of latest motion gate currently activated, default is 8, meaning 9 total gates.

📊 **Max still gate** – index of latest still gate currently activated, default is 8, meaning 9 total gates.

🏷️ **Firmware version** – version of the firmware running on the device; include when reporting issues.

📅 **Firmware build date** – build date of the installed firmware.

🖼️ **Frame type** – shows whether the sensor is sending basic or engineering frames. The integration automatically upgrades to engineering when possible

📶 **Bluetooth signal** – RSSI strength; move the device closer if the value is weak.

🔑 **Change password** – go to **Settings → Devices & services → LD2410 → Configure** and fill in *New Bluetooth password* (exactly six printable ASCII characters). The device reboots with the new password. A form is used instead of an entity so the password never lands in the recorder database.

🤖 **Auto sensitivities** – button to calibrate gate sensitivities automatically. Leave the room before clicking it, keep it empty for 10 seconds during calibration.

💾 **Save sensitivities** – button to store current gate sensitivities in the config entry. Useful for playing around with calibration without missing the sweet spot.

📥 **Load sensitivities** – button to restore previously saved gate sensitivities to the device.

♻️ **Reboot device** – button to reboot the device.

🎚️ **Motion gate sensitivity sliders (MG0–MG8)** – sets the motion sensitivity for each gate, the lower the slider the easier it gets activated.

🎛️ **Static gate sensitivity sliders (SG0–SG8)** – number entities to set static sensitivity for each gate, the lower the slider the easier it gets activated.

⏱️ **Absence delay** – number of seconds to wait before occupancy clears, preventing false absence.

📏 **Max motion gate / Max still gate** – the farthest gate (2–8) that detects motion or presence, to stop detection beyond a wall or doorway. Disabled by default; enable them under the device's entities.

🕯️ **Light function** – when enabled the OUT pin will only be activated if the photo sensor reading is (dimmer than/brighter than) *Light sensitivity* .

🌗 **Light sensitivity** – threshold for the photo sensor (0‑255) when using the light function.

📐 **Distance resolution** – the length of each gate: 0.75 m (about 6.75 m in total) or 0.20 m (about 1.8 m in total, shorter range but finer).

📤 **OUT level** – select the default level of the OUT pin (usually low becoming high when activated / usually high becoming low when activated).

## Installation instructions
1. The easiest way to install the integration is using HACS. Click the button below and follow the instructions:  
   [![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=q15503624&repository=ha-ld2410)

   Alternatively, you can go to HACS and:
   - a) Click on the 3 dots in the top right corner.
   - b) Select "Custom repositories".
   - c) Add the URL to this repository: https://github.com/q15503624/ha-ld2410.
   - d) Select integration.
   - e) Click the "ADD" button.

2. Navigate to **Settings → Devices & Services**; the HA-LD2410 device should be auto-detected.  
   If it's not detected, click the **Add Integration** button, search for "HA-LD2410", and install it. Your device should appear in the list. The factory Bluetooth password is `HiLink`.

## Tuning panel
After installing, a **雷達調校** (radar tuning) page appears in the sidebar for admin users once the first LD2410 device is set up. To show it before that, add this line to `configuration.yaml` and restart Home Assistant:

```yaml
ld2410:
```

With several radars, switch between them with the dropdown at the top. The panel itself is in Traditional Chinese.

### Quick setup (recommended for the first time)
The top of the panel is a six-step guide that takes about three minutes:

| Step | What it does |
|---|---|
| **1. Prepare** | Checks that the radar is online and its energy sensors report data. One click enables the energy and max-gate entities, which are disabled by default. |
| **2. Range** | Walk to the farthest spot you want covered; the page shows which gate you are in. One click limits detection to that gate, so the hallway or the next room stay out. |
| **3. Empty room** | Leave the room while it records 30 s of background noise, shown as a per-gate heat table. Pick a margin and apply thresholds to all 18 gates at once. |
| **4. Interference** | Turn on one moving thing at a time (fan, air conditioner, curtain…) and record 20 s. The page lists which gates it affects and how strongly, then raises the thresholds above it. |
| **5. Presence test** | Sit where you usually sit, or walk around, and check that every gate sees you. Gates that miss you get a suggested threshold you can apply with one click. |
| **6. Finish** | Pick an absence delay and save the thresholds so you can restore them later. |

### Detection map (manual fine-tuning)
- Each column is one distance gate. The bar is the live energy and the line is the threshold: **a bar above its line means detected**.
- A lower line is more sensitive. Drag the line on the chart, or select a column and use ±1 / ±5.
- Recorded noise is drawn as an orange band; keep the threshold above it to avoid false triggers.
- Every write reports its result: writing, confirmed by the radar, timed out, or failed.
- Each gate gets a plain-language verdict, e.g. "threshold 40 is below the fan's noise 52, so it will false-trigger"; problem gates are marked ⚠.
- An expandable explainer with diagrams covers what a threshold is and why each gate needs its own.
- The panel opens in **🔒 View only** mode: you can click columns and watch the data, but dragging and sliders do nothing. Switch to **✏️ Editable** at the top right to change values; the choice is remembered.

### Absence watch (catch occasional false presence)
If the radar sometimes reports presence when nobody is home, start a 10, 30 or 60 minute watch and leave the room. The panel records each gate's highest energy, which gates crossed their threshold, how often and when, and when *Occupancy* turned on. One click raises **only** the gates that triggered (highest value + 10); no gate is ever lowered. Gates too strong to block are pointed to *max gate* instead.

Keep the panel open in a foreground tab while it records. Home Assistant closes the connection of a background tab after 5 minutes unless *Automatically close connection* is turned off in your profile.

## Note on recorder
Some sensors update several times per second. They are **disabled by default**. If you enable them, exclude them from the recorder, or they will fill your database. Real example: six devices with `Last frame` enabled wrote 3.7 million rows in 7 days, 38% of the whole database.

Copy this into your `configuration.yaml`, then restart Home Assistant. It works for every device that keeps its default name (`HLK-LD2410_XXXX`):

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.*_gate_?_energy        # 18 per-gate energy sensors
      - sensor.*_last_frame           # updates on every received frame
      - sensor.*hlk_ld2410_*_distance
      - sensor.*hlk_ld2410_*_energy
      - sensor.*hlk_ld2410_*_photo_sensor
      - sensor.*hlk_ld2410_*_frame_type
```

**Renamed a device and its entity ids?** The `hlk_ld2410` lines no longer match it. Add these lines for each renamed device, and replace `<device>` with its new entity id prefix (for `sensor.bathroom_sensor_still_energy` it is `bathroom_sensor`):

```yaml
      - sensor.<device>_*_distance
      - sensor.<device>_*_energy
      - sensor.<device>_photo_sensor
      - sensor.<device>_frame_type
```

To stop recording a whole device instead (all its sensors and binary sensors):

```yaml
recorder:
  exclude:
    entity_globs:
      - "*.*hlk_ld2410_*"     # every device with its default name
      - "*.<device>_*"        # one line per renamed device
```

Notes:
- `exclude: domains: [ld2410]` does **not** work. Recorder domains are entity domains such as `sensor` or `binary_sensor`, not integrations.
- Excluding an entity does not delete rows it already wrote. To remove them, call `recorder.purge` with `apply_filter: true`.
- Recorder changes need a Home Assistant restart.

## Contributing
Contributions are welcome! To set up the development environment:

1. Create and activate a virtual environment:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

2. Install the development requirements:

   ```bash
   pip install -r requirements.dev.txt
   ```

3. Before making your Pull Request, run the linters and tests:

   ```bash
   ruff check . --fix
   ruff format .
   pytest
   ```

## Known Issues
- The integration may not work with some LD2410 devices due to firmware differences. If you encounter issues, please open an issue on GitHub with details about your device and firmware version.

### Enabling debug logging
Before registering issues, please enable debug logging to help diagnose problems and paste your logs in it.
Add the following to your `configuration.yaml` file then restart Home Assistant:

```yaml
logger:
  default: warn
  logs:
    custom_components.ld2410: debug
```

# Legal Notice
This integration is not built, maintained, provided or associated with HiLink.

