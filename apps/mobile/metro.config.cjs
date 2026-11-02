const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
// lib0's RN adapter expects a separate native crypto module. Expo supplies secure
// randomness at startup; the browser adapter uses that same global for Yjs IDs.
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === "lib0/webcrypto" || (name === "./webcrypto" && context.originModulePath.includes("/lib0/"))) {
    return { type: "sourceFile", filePath: require.resolve("lib0/package.json").replace("package.json", "webcrypto.js") };
  }
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
