// Compass entry: platform polyfills load before Expo Router evaluates any route module.
import "./src/runtime/crypto-polyfill";
import "expo-router/entry";
