module.exports = {
  // babel-preset-expo is version-matched to the Expo SDK (and the React Native
  // version it ships), and wraps @react-native/babel-preset internally — using
  // the raw RN preset directly risks a preset/RN-core codegen mismatch.
  presets: ['babel-preset-expo'],
  // Do NOT override the class-feature plugins to `{ loose: false }`. The RN
  // preset hardcodes `{ loose: true }` on purpose: React Native's own class
  // components (e.g. VirtualizedList) declare instance fields that would compile
  // to `Object.defineProperty` under spec `[[Define]]` semantics, and on Hermes
  // such a field redefining an inherited non-configurable property throws
  // `property is not configurable` during render — crashing any screen with a
  // FlatList/SectionList.
  //
  // The reason `loose: false` was previously needed — libp2p `Event` subclasses
  // colliding with React Native's read-only global `Event` (its `type` is a
  // getter, its `NONE`/phase constants are non-configurable) — is handled in the
  // transport layer instead: `@peerkit/transport-libp2p-react-native/polyfills`
  // overwrites the global `Event`/`EventTarget`/`CustomEvent` with a
  // subclass-safe implementation before any libp2p module evaluates. That keeps
  // RN on its required `loose: true` while libp2p's events still construct.
};
