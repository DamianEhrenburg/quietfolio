import packageJson from "../../package.json";

export const APP_VERSION = packageJson.version;
export const APP_USER_AGENT = `Quietfolio/${APP_VERSION} (personal desktop library)`;
