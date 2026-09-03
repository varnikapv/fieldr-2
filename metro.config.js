const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Migrations are generated as .sql files and inlined into the bundle at build
// time (see babel.config.js), so Metro has to treat .sql as source.
config.resolver.sourceExts.push('sql');

module.exports = config;
