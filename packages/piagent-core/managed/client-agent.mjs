import fs from 'node:fs';

// How Piagent names itself to Studio on every company request, so Studio's
// reports show the tool and its version ("piagent/1.9.1").
const version = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
export const CLIENT_AGENT = `piagent/${version}`;
