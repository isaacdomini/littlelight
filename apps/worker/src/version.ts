import pkg from "../package.json" with { type: "json" };

export const WORKER_VERSION: string = pkg.version;
