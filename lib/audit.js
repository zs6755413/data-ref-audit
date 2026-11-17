'use strict';

const { buildContext, normalize, isBlank } = require('./load.js');

const SEVERITY = {
  'missing-required': 'error',
  'blank-required': 'error',
  'invalid-enum': 'error',
  'duplicate-id': 'error',
  'duplicate-unique': 'error',
  'dangling-ref': 'error',
  'unreferenced': 'warn',
  'field-coverage': 'warn'
};

function audit(data, schema, opts) {
  const options = opts || {};
  const ctx = buildContext(data, schema);
  const issues = [];

  const idIndex = {};

  for (const name of Object.keys(ctx.collections)) {
    const col = ctx.collections[name];
    const idField = col.def.id || 'id';
    const map = new Map();
    idIndex[name] = map;

    const seenIds = new Map();

    col.rows.forEach((row, idx) => {
      const rawId = row[idField];
      const rowId = isBlank(rawId) ? `#${idx + 1}` : String(rawId);

      if (!isBlank(rawId)) {
        const key = normalize(rawId);
        if (seenIds.has(key)) {
          issues.push({
            severity: SEVERITY['duplicate-id'],
            kind: 'duplicate-id',
            collection: name,
            id: rowId,
            field: idField,
            message: `id 与第 ${seenIds.get(key)} 条重复`,
            value: rawId
          });
        } else {
          seenIds.set(key, idx + 1);
          map.set(key, row);
        }
      }

      for (const field of col.def.required || []) {
        if (isBlank(row[field])) {
          const isPresent = Object.prototype.hasOwnProperty.call(row, field);
          const kind = isPresent ? 'blank-required' : 'missing-required';
          issues.push({
            severity: SEVERITY[kind],
            kind,
            collection: name,
            id: rowId,
            field,
            message: isPresent ? '字段存在但为空' : '字段缺失',
            value: row[field]
          });
        }
      }

      const enums = col.def.enums || {};
      for (const field of Object.keys(enums)) {
        if (isBlank(row[field])) continue;
        const allowed = enums[field];
        if (allowed.indexOf(row[field]) === -1) {
          issues.push({
            severity: SEVERITY['invalid-enum'],
            kind: 'invalid-enum',
            collection: name,
            id: rowId,
            field,
            message: `取值不在允许范围内（允许：${allowed.join(' / ')}）`,
            value: row[field]
          });
        }
      }
    });

    for (const field of col.def.unique || []) {
      const seen = new Map();
      col.rows.forEach((row, idx) => {
        if (isBlank(row[field])) return;
        const key = normalize(row[field]);
        const rowId = isBlank(row[idField]) ? `#${idx + 1}` : String(row[idField]);
        if (seen.has(key)) {
          issues.push({
            severity: SEVERITY['duplicate-unique'],
            kind: 'duplicate-unique',
            collection: name,
            id: rowId,
            field,
            message: `与第 ${seen.get(key)} 条重复（规范化后比较）`,
            value: row[field]
          });
        } else {
          seen.set(key, idx + 1);
        }
      });
    }
  }

  const refUsage = {};

  for (const name of Object.keys(ctx.collections)) {
    const col = ctx.collections[name];
    const idField = col.def.id || 'id';
    const refs = col.def.refs || {};

    for (const field of Object.keys(refs)) {
      const refDef = refs[field];
      const target = refDef.collection;
      if (!refUsage[target]) refUsage[target] = {};
      if (!refUsage[target][field]) refUsage[target][field] = new Set();

      col.rows.forEach((row, idx) => {
        const value = row[field];
        const rowId = isBlank(row[idField]) ? `#${idx + 1}` : String(row[idField]);

        if (isBlank(value)) {
          if (refDef.required) {
            issues.push({
              severity: 'error',
              kind: 'missing-required',
              collection: name,
              id: rowId,
              field,
              message: '引用字段必填但为空',
              value
            });
          }
          return;
        }

        const targetMap = idIndex[target];
        const key = normalize(value);

        if (!targetMap) {
          issues.push({
            severity: 'error',
            kind: 'dangling-ref',
            collection: name,
            id: rowId,
            field,
            message: `引用的集合 ${target} 不存在或未声明`,
            value
          });
          return;
        }

        if (!targetMap.has(key)) {
          issues.push({
            severity: SEVERITY['dangling-ref'],
            kind: 'dangling-ref',
            collection: name,
            id: rowId,
            field,
            message: `指向 ${target} 中不存在的 id`,
            value
          });
        } else {
          refUsage[target][field].add(key);
        }
      });
    }
  }

  if (options.orphans !== false) {
    for (const target of Object.keys(refUsage)) {
      const col = ctx.collections[target];
      if (!col) continue;
      const idField = col.def.id || 'id';
      const groups = refUsage[target];

      for (const field of Object.keys(groups)) {
        const used = groups[field];
        if (!used.size) continue;
        col.rows.forEach((row, idx) => {
          const raw = row[idField];
          if (isBlank(raw)) return;
          if (!used.has(normalize(raw))) {
            issues.push({
              severity: SEVERITY['unreferenced'],
              kind: 'unreferenced',
              collection: target,
              id: String(raw),
              field,
              message: `没有任何条目的 ${field} 指向它，可能是孤儿内容`,
              value: raw
            });
          }
        });
      }
    }
  }

  const coverage = [];
  for (const name of Object.keys(ctx.collections)) {
    const col = ctx.collections[name];
    if (col.rows.length < 2) continue;
    const counts = {};
    for (const row of col.rows) {
      for (const k of Object.keys(row)) {
        if (!isBlank(row[k])) counts[k] = (counts[k] || 0) + 1;
        else if (!(k in counts)) counts[k] = 0;
      }
    }
    for (const field of Object.keys(counts)) {
      const n = counts[field];
      if (n === 0 || n === col.rows.length) continue;
      coverage.push({
        collection: name,
        field,
        present: n,
        total: col.rows.length,
        rate: Math.round((n / col.rows.length) * 1000) / 1000
      });
    }
  }
  coverage.sort((a, b) => a.rate - b.rate);

  const byKind = {};
  const bySeverity = { error: 0, warn: 0 };
  const byCollection = {};

  for (const it of issues) {
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    byCollection[it.collection] = (byCollection[it.collection] || 0) + 1;
  }

  return {
    issues,
    coverage,
    summary: {
      total: issues.length,
      byKind,
      bySeverity,
      byCollection,
      missingCollections: ctx.missingCollections
    },
    stats: Object.keys(ctx.collections).map((name) => ({
      collection: name,
      rows: ctx.collections[name].rows.length,
      issues: byCollection[name] || 0
    }))
  };
}

module.exports = { audit, SEVERITY };
