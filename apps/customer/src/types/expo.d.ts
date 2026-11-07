// Expo's global types (process.env for EXPO_PUBLIC_*, require.context, __DEV__ via react-native).
/// <reference types="expo/types" />

// Metro resolves image imports to an asset reference.
declare module '*.png' {
  const source: import('react-native').ImageSourcePropType;
  export default source;
}
