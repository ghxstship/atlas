// Compass entry: platform polyfills load before Expo Router evaluates any route module.
import "./src/runtime/crypto-polyfill";
import { LogBox } from "react-native";
import "expo-router/entry";

// React Native's own notice for a native-driven value nobody listens to is harmless, but in a development build its
// toast covers the tab bar and takes the taps meant for it (Maestro runs on Metro, A92). LogBox is off in release.
LogBox.ignoreLogs(["Sending `onAnimatedValueUpdate` with no listeners registered."]);
