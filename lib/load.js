'use strict';

const fs = require('fs');

function normalize(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getCollection(data, name, def) {
  if (def && def.path) {
    const parts = def.path.split('.');
    let cur = data;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return Array.isArray(cur) ? cur : null;
  }
  const direct = data[name];
  return Array.isArray(direct) ? direct : null;
}

function buildContext(data, schema) {
  const collections = {};
  const missing = [];

  for (const name of Object.keys(schema.collections || {})) {
    const def = schema.collections[name];
    const rows = getCollection(data, name, def);
    if (!rows) {
      missing.push(name);
      collections[name] = { name, def, rows: [] };
      continue;
    }
    collections[name] = { name, def, rows };
  }

  return { collections, missingCollections: missing };
}

module.exports = { loadJson, buildContext, normalize, isBlank };
