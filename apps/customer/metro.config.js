// Metro for the customer app in the pnpm workspace (expo/metro-config detects the monorepo root itself).
// Two additions so the app bundles @point/shared from its TypeScript sources, as the other workspace apps do:
//   1. the `@point/source` export condition (packages/shared/package.json) — no build step needed;
//   2. the shared sources import siblings as `./x.js` (Node ESM style), which Metro maps back to `./x.ts`.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const sharedSrc = path.resolve(__dirname, '../../packages/shared/src') + path.sep;

config.resolver.unstable_conditionNames = [
  ...(config.resolver.unstable_conditionNames ?? []),
  '@point/source',
];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (
    context.originModulePath.startsWith(sharedSrc) &&
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js')
  ) {
    return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
