import packageJson from "../package.json";

/** Release version; the release workflow refuses tags that do not match package.json. */
export const VERSION: string = packageJson.version;
