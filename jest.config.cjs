const { createDefaultEsmPreset } = require("ts-jest");

/** @type {import('jest').Config} */
module.exports = {
    ...createDefaultEsmPreset({ tsconfig: "tsconfig.json" }),
    testEnvironment: "node",
    roots: ["<rootDir>/src"],
    testMatch: ["**/*.spec.ts"],
    // Strip the `.js` extension our ESM imports use so jest resolves the .ts source.
    moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
};
