#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadJson } = require('../lib/load.js');
const { audit } = require('../lib/audit.js');

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m'
};

function color(code, s) {
  return process.stdout.isTTY && !process.env.NO_COLOR ? code + s + C.reset : String(s);
}

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    );
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, w, align) {
  const str = String(s == null ? '' : s);
  const diff = w - strWidth(str);
  if (diff <= 0) return str;
  return align === 'right' ? ' '.repeat(diff) + str : str + ' '.repeat(diff);
}

function section(title) {
  return '\n' + color(C.bold, title) + ' ' + color(C.dim, '─'.repeat(Math.max(4, 62 - strWidth(title)))) + '\n';
}

const KIND_LABEL = {
  'missing-required': '字段缺失',
  'blank-required': '字段为空',
  'invalid-enum': '枚举越界',
  'duplicate-id': 'id 重复',
  'duplicate-unique': '唯一值重复',
  'dangling-ref': '引用孤儿',
  'unreferenced': '无人引用',
  'field-coverage': '字段不全'
};

function render(result, meta) {
  const out = [];
  const s = result.summary;

  out.push(color(C.dim, `data-ref-audit  ·  ${meta.data}  ·  ${meta.schema}`));

  if (s.missingCollections.length) {
    out.push(color(C.yellow, `  以下集合在数据里找不到：${s.missingCollections.join('、')}`));
  }

  out.push(section('集合'));
  const nameW = Math.max(10, ...result.stats.map((x) => strWidth(x.collection) + 2));
  out.push(pad('集合', nameW) + pad('条目', 8, 'right') + pad('问题', 8, 'right'));
  for (const st of result.stats) {
    const tone = st.issues ? C.red : C.green;
    out.push(pad(st.collection, nameW) + pad(st.rows, 8, 'right') +
      color(tone, pad(st.issues, 8, 'right')));
  }

  out.push(section('按类型'));
  const kinds = Object.keys(s.byKind).sort((a, b) => s.byKind[b] - s.byKind[a]);
  if (!kinds.length) {
    out.push(color(C.green, '  没有发现问题。'));
  } else {
    for (const k of kinds) {
      out.push('  ' + pad(KIND_LABEL[k] || k, 14) + pad(s.byKind[k], 6, 'right') + '  ' + color(C.dim, k));
    }
  }

  if (result.issues.length) {
    out.push(section('明细'));
    const colW = Math.max(8, ...result.issues.map((x) => strWidth(x.collection) + 2));
    const idW = Math.max(8, ...result.issues.map((x) => strWidth(x.id) + 2));
    const fieldW = Math.max(10, ...result.issues.map((x) => strWidth(x.field || '') + 2));

    let lastCollection = null;
    for (const it of result.issues) {
      if (it.collection !== lastCollection) {
        if (lastCollection !== null) out.push('');
        out.push('  ' + color(C.bold, it.collection));
        lastCollection = it.collection;
      }
      const tag = it.severity === 'error' ? color(C.red, 'err') : color(C.yellow, 'warn');
      out.push('    ' + pad(tag, 6) + pad(it.id, idW) + pad(it.field || '', fieldW) + it.message +
        (it.value !== undefined && it.value !== '' ? color(C.dim, `  值=${JSON.stringify(it.value)}`) : ''));
    }
  }

  if (result.coverage.length) {
    out.push(section('字段覆盖率（部分条目才有）'));
    for (const cv of result.coverage.slice(0, 12)) {
      const rate = (cv.rate * 100).toFixed(0) + '%';
      const bar = '█'.repeat(Math.round(cv.rate * 16)) + '·'.repeat(16 - Math.round(cv.rate * 16));
      out.push('  ' + pad(cv.collection + '.' + cv.field, 26) + pad(cv.present + '/' + cv.total, 8, 'right') +
        '  ' + bar + '  ' + pad(rate, 5, 'right'));
    }
    if (result.coverage.length > 12) {
      out.push(color(C.dim, `  …还有 ${result.coverage.length - 12} 个字段`));
    }
  }

  out.push(section('结论'));
  const errors = s.bySeverity.error || 0;
  const warns = s.bySeverity.warn || 0;

  if (!s.total) {
    out.push('  数据干净，四类检查全部通过。');
  } else {
    out.push(`  共 ${s.total} 处问题：${errors} 个错误、${warns} 个提醒。`);

    if (s.byKind['dangling-ref']) {
      out.push('  引用孤儿是最容易扩散的一类——删掉一条主数据，引用方不会报错，只会在页面上变成空白或 404。');
    }
    if (s.byKind['duplicate-unique']) {
      out.push('  唯一值重复会影响路由和 sitemap，同一个 slug 生成两次就等于给搜索引擎两个一模一样的地址。');
    }
    if (result.coverage.length) {
      const worst = result.coverage[0];
      out.push(`  字段覆盖率最低的是 ${worst.collection}.${worst.field}，只有 ${worst.present}/${worst.total} 条有值。` +
        '读这份数据的地方要么写兜底，要么就会读到 undefined。');
    }
  }

  out.push('');
  return out.join('\n');
}

function help() {
  console.log(`data-ref-audit —— JSON 数据一致性审计

用法
  node bin/audit.js <data.json> <schema.json> [选项]

选项
  --json         输出完整结果
  --no-orphans   不检查「无人引用」这一项
  --strict       有提醒也算失败（退出码 1）
  --no-color     关闭颜色
  -h, --help     显示帮助

检查项
  missing-required   必填字段不存在
  blank-required     字段存在但是空字符串或 null
  invalid-enum       取值不在允许列表里
  duplicate-id       同一个集合内 id 重复
  duplicate-unique   声明为唯一的字段出现重复（规范化后比较）
  dangling-ref       引用字段指向不存在的目标
  unreferenced       目标集合里有条目从未被引用
  field-coverage     同集合内字段覆盖率不一致

退出码
  0  没有错误（有提醒也算通过，除非 --strict）
  1  存在错误
  2  参数或文件错误`);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, orphans: true, strict: false, files: [] };

  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--no-orphans') opts.orphans = false;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-color') process.env.NO_COLOR = '1';
    else if (a === '-h' || a === '--help') { help(); return 0; }
    else opts.files.push(a);
  }

  if (opts.files.length < 2) {
    help();
    return 2;
  }

  const [dataFile, schemaFile] = opts.files;

  let data;
  let schema;
  try {
    data = loadJson(dataFile);
  } catch (e) {
    process.stderr.write(`读不了数据文件：${e.message}\n`);
    return 2;
  }
  try {
    schema = loadJson(schemaFile);
  } catch (e) {
    process.stderr.write(`读不了 schema 文件：${e.message}\n`);
    return 2;
  }

  if (!schema.collections || typeof schema.collections !== 'object') {
    process.stderr.write('schema 缺少 collections 字段。\n');
    return 2;
  }

  const result = audit(data, schema, { orphans: opts.orphans });

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      data: path.resolve(dataFile),
      schema: path.resolve(schemaFile),
      result
    }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(render(result, {
    data: path.relative(process.cwd(), dataFile) || dataFile,
    schema: path.relative(process.cwd(), schemaFile) || schemaFile
  }));

  const errors = result.summary.bySeverity.error || 0;
  const warns = result.summary.bySeverity.warn || 0;

  if (errors) return 1;
  if (opts.strict && warns) return 1;
  return 0;
}

process.exit(main());
