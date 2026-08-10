# NSL Glove

Expo React Native Android app that connects to an ESP32 over **Bluetooth Classic (SPP)** and speaks received text aloud with `expo-speech`.

> This app **does not run in Expo Go** — it uses the native `react-native-bluetooth-classic` module. You must produce a dev client or a preview APK via EAS Build.

## First-time setup

```powershell
npm install
npm install -g eas-cli   # if you don't have it
eas login
eas init                 # links this folder to an EAS project
```

## Build an installable APK (preview profile)

```powershell
eas build -p android --profile preview
```

When the build finishes, EAS gives you a URL — download the `.apk` on your Android phone and install it.

## Pairing

1. Turn on the ESP32 and pair it in Android **Settings → Bluetooth** as `NSL_Glove` (any name works, but `NSL_Glove` is auto-selected).
2. Open NSL Glove. It lists paired devices and auto-connects to `NSL_Glove`; otherwise it shows a picker.

## Protocol

- Incoming: newline-delimited text. Lines starting with `>>`, `!!`, `=`, or three spaces are logged only (not spoken).
- Outgoing: every command is terminated with `\n`.
  - `TRAIN:<LABEL>` from the Train Sign button
  - `CAL`, `LIST`, `RAW` from the command buttons
