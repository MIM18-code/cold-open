/** Credential values are never returned or printed. Release builds must not degrade to unsigned output. */
export function releasePolicy(env, helpers) {
  const release = env.SCREENPLAY_RELEASE === "1";
  const signed = env.SCREENPLAY_SIGN === "developer-id";
  if (release && !signed) throw new Error("A release build requires SCREENPLAY_SIGN=developer-id.");
  if (release && (!helpers.speech || !helpers.voice)) throw new Error("A release build requires both compiled native helpers.");
  if (release) {
    const appleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    const apiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
    // APPLE_KEYCHAIN is optional: notarytool otherwise searches the default keychains, where store-credentials saves profiles.
    const profile = env.APPLE_KEYCHAIN_PROFILE;
    if (!appleId && !apiKey && !profile) throw new Error("Notarization credentials are required for a release build.");
  }
  return { release, signed };
}
