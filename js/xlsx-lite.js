/* ============================================================
 * xlsx-lite.js — 最小 SpreadsheetML（XLSX）生成器（纯逻辑，可单测）
 * 零依赖：只产出 OOXML 部件字符串 + TextEncoder 字节，由 window.ZipUtil.store
 * 打包成 .xlsx。用于 OCR 表格的结构化导出——每张识别表格一个工作表，
 * 保留行列布局、单元格文本/数值类型与列对齐。
 *
 * 包内结构：
 *   [Content_Types].xml
 *   _rels/.rels                        → xl/workbook.xml
 *   xl/workbook.xml                    sheets（名称 + r:id）
 *   xl/_rels/workbook.xml.rels         → worksheets + styles
 *   xl/styles.xml                      字体（常规/加粗）+ 6 个 cellXfs（对齐 × 加粗）
 *   xl/worksheets/sheetN.xml           dimension / sheetViews / cols / sheetData
 *
 * 约定：字符串一律 inlineStr（无需 sharedStrings）；首行视为表头并加粗；
 * 数值仅接受 ≤11 位且不以 0 开头的纯数字（证件号/长编号保持文本，避免
 * Excel 15 位精度截断）；列宽由相对像素宽度换算为 Excel 字符宽。
 * ============================================================ */
(function (App) {
  'use strict';

  var NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  var NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /* ================= 基础工具 ================= */

  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 0 → A、25 → Z、26 → AA
  function colLetter(idx) {
    var n = Math.max(0, idx | 0);
    var s = '';
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  }

  // 工作表名：非法字符 []:*?/\ 与首尾空白清理，限 31 字符，重名追加序号
  function sanitizeSheetName(name, used) {
    var base = String(name || '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) base = '表格';
    if (base.length > 31) base = base.slice(0, 31);
    var out = base, i = 2;
    var table = used || {};
    while (table[out.toUpperCase()]) {
      var suffix = '(' + i + ')';
      out = base.slice(0, 31 - suffix.length) + suffix;
      i++;
    }
    table[out.toUpperCase()] = true;
    return out;
  }

  // 数值判定：纯数字且 ≤11 位、不以 0 开头（超长编号/证件号保持文本）
  function isNumericCell(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (!/^-?\d{1,11}(?:\.\d+)?$/.test(t)) return false;
    if (/^-?0\d/.test(t)) return false;
    return true;
  }

  // 对齐 + 加粗 → cellXfs 索引：0 左 / 1 中 / 2 右；加粗 +3
  function styleIndex(align, bold) {
    var base = align === 'right' ? 2 : (align === 'center' ? 1 : 0);
    return bold ? base + 3 : base;
  }

  // 列宽换算：相对像素宽 → Excel 字符宽，钳制 8..60
  function excelColWidth(pxWidth) {
    var w = Math.round(Number(pxWidth || 0) / 7.5);
    if (!isFinite(w) || w < 8) w = 8;
    if (w > 60) w = 60;
    return w;
  }

  /* ================= 工作表 XML ================= */

  function cellXml(ref, style, value) {
    if (value === '' || value == null) return '';
    var v = String(value);
    if (isNumericCell(v)) {
      return '<c r="' + ref + '" s="' + style + '"><v>' + v.trim() + '</v></c>';
    }
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
      escXml(v) + '</t></is></c>';
  }

  // 表格块 → worksheet 部件。table = {rows:[[cellText]], aligns:[], widths:[]}
  function buildSheetXml(table) {
    var rows = (table && table.rows) || [];
    var aligns = (table && table.aligns) || [];
    var widths = (table && table.widths) || [];
    var maxCols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="' + NS_MAIN + '">');
    var lastCol = colLetter(Math.max(0, maxCols - 1));
    parts.push('<dimension ref="A1:' + lastCol + Math.max(1, rows.length) + '"/>');
    parts.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
    if (maxCols) {
      var colsXml = '';
      for (var ci = 0; ci < maxCols; ci++) {
        var w = widths.length === maxCols ? excelColWidth(widths[ci]) : 12;
        colsXml += '<col min="' + (ci + 1) + '" max="' + (ci + 1) + '" width="' + w + '" customWidth="1"/>';
      }
      parts.push('<cols>' + colsXml + '</cols>');
    }
    parts.push('<sheetData>');
    rows.forEach(function (row, ri) {
      var cells = '';
      row.forEach(function (cell, ci) {
        var st = styleIndex(aligns[ci] || 'left', ri === 0 && rows.length > 1);
        cells += cellXml(colLetter(ci) + (ri + 1), st, cell);
      });
      parts.push('<row r="' + (ri + 1) + '">' + cells + '</row>');
    });
    parts.push('</sheetData>');
    parts.push('</worksheet>');
    return parts.join('');
  }

  /* ================= 工作簿与包 ================= */

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="' + NS_MAIN + '">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // sheets = [{name, table}] → ZipUtil.store 入参（name + Uint8Array）
  function buildXlsxFiles(sheets) {
    var list = sheets || [];
    if (!list.length) return null;
    var enc = new TextEncoder();
    var used = {};
    var names = list.map(function (s, i) {
      return sanitizeSheetName(s.name || ('表格' + (i + 1)), used);
    });
    var files = [];
    var overrides = '';
    var sheetNodes = '';
    var relNodes = '';
    list.forEach(function (s, i) {
      var n = i + 1;
      files.push({ name: 'xl/worksheets/sheet' + n + '.xml', data: enc.encode(buildSheetXml(s.table)) });
      overrides += '<Override PartName="/xl/worksheets/sheet' + n + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      sheetNodes += '<sheet name="' + escXml(names[i]) + '" sheetId="' + n + '" r:id="rId' + n + '"/>';
      relNodes += '<Relationship Id="rId' + n + '" Type="' + NS_REL + '/worksheet" ' +
        'Target="worksheets/sheet' + n + '.xml"/>';
    });
    var stylesRid = 'rId' + (list.length + 1);
    files.unshift(
      { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        relNodes +
        '<Relationship Id="' + stylesRid + '" Type="' + NS_REL + '/styles" Target="styles.xml"/>' +
        '</Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
        '<sheets>' + sheetNodes + '</sheets></workbook>') },
      { name: '_rels/.rels', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="' + NS_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>') },
      { name: '[Content_Types].xml', data: enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        overrides +
        '</Types>') }
    );
    return files;
  }

  /* ================= 识别单元 → 工作簿 ================= */

  // units = [{label, text, doc:{blocks:[...]}}]：每个表格块一张工作表。
  // 无表格返回 null（调用方据此置灰按钮）。文件名标签取单元 label。
  function buildXlsxFromUnits(units) {
    var list = [];
    (units || []).forEach(function (u) {
      var blocks = (u && u.doc && u.doc.blocks) || [];
      blocks.forEach(function (b) {
        if (b && b.type === 'table' && b.rows && b.rows.length) {
          list.push({ name: String(u.label || ''), table: b });
        }
      });
    });
    if (!list.length) return null;
    var files = buildXlsxFiles(list);
    if (!files) return null;
    var used = {};
    var names = list.map(function (s, i) {
      return sanitizeSheetName(s.name || ('表格' + (i + 1)), used);
    });
    var rows = 0, cells = 0;
    list.forEach(function (s) {
      rows += s.table.rows.length;
      s.table.rows.forEach(function (r) { cells += r.length; });
    });
    return { files: files, stats: { sheets: list.length, rows: rows, cells: cells, names: names } };
  }

  App.xlsxLite = {
    buildXlsxFiles: buildXlsxFiles,
    buildXlsxFromUnits: buildXlsxFromUnits,
    _test: {
      escXml: escXml,
      colLetter: colLetter,
      sanitizeSheetName: sanitizeSheetName,
      isNumericCell: isNumericCell,
      styleIndex: styleIndex,
      excelColWidth: excelColWidth,
      buildSheetXml: buildSheetXml,
      stylesXml: function () { return STYLES_XML; }
    }
  };
})(window.App);
