/*
 * xlsx.js -- Minimal, dependency-free OOXML (.xlsx) workbook writer for
 * Stop Codon Finder.
 *
 * Exposes a global `CodonXlsx`. 100% client-side, no libraries, no network,
 * file:// safe. Builds a valid SpreadsheetML package as a ZIP archive using the
 * STORE method (no compression), so NO DEFLATE implementation is needed -- but
 * every entry carries a correct table-based CRC-32 (polynomial 0xEDB88320) and
 * byte-exact local file headers, central-directory records and an
 * end-of-central-directory record (all little-endian). Strings are written as
 * inline strings (t="inlineStr") so no sharedStrings table is required.
 *
 *   CodonXlsx.build(sheets)  -> Uint8Array  (the raw .xlsx bytes)
 *   CodonXlsx.crc32(bytes)   -> number       (exposed for self-tests)
 *   CodonXlsx.utf8(str)      -> Uint8Array   (exposed for self-tests)
 *
 * `sheets` is an array of:
 *   { name: 'Summary', header: true|false, rows: [ [cell, cell, ...], ... ] }
 * where each `cell` is a Number (written as a numeric cell) or anything else
 * (coerced to a string, written as an inline string). When `header` is true the
 * first row is rendered bold and the header row is frozen.
 */
(function (global) {
  'use strict';

  // ---- CRC-32 (standard polynomial 0xEDB88320, table-based) ------------
  var CRC_TABLE = (function () {
    var table = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- UTF-8 encoding (no TextEncoder dependency; works everywhere) -----
  function utf8(str) {
    str = String(str == null ? '' : str);
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF) {
        // High surrogate: combine with the following low surrogate.
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
          bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
        } else {
          // Unpaired surrogate -> U+FFFD replacement character.
          bytes.push(0xEF, 0xBF, 0xBD);
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        bytes.push(0xEF, 0xBF, 0xBD); // lone low surrogate
      } else {
        bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return Uint8Array.from(bytes);
  }

  // ---- XML text escaping (& < > " and disallowed control chars) --------
  // XML 1.0 allows TAB (0x09), LF (0x0A) and CR (0x0D); every other C0 control
  // char (and NUL) is illegal and is dropped so the file can never carry a raw
  // control/NUL byte.
  function xmlText(value) {
    var s = String(value == null ? '' : value);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      if (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) continue;
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (ch === '"') out += '&quot;';
      else out += ch;
    }
    return out;
  }

  // ---- Column letters: 0 -> A, 25 -> Z, 26 -> AA ... -------------------
  function colName(idx) {
    var s = '';
    var n = idx + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ---- Worksheet XML ---------------------------------------------------
  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var header = !!sheet.header;
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    if (header && rows.length) {
      // Freeze the header row (row 1) so it stays visible while scrolling.
      parts.push('<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
        '</sheetView></sheetViews>');
    }
    parts.push('<sheetData>');
    for (var r = 0; r < rows.length; r++) {
      var rowNum = r + 1;
      var cells = rows[r] || [];
      var bold = header && r === 0;
      parts.push('<row r="' + rowNum + '">');
      for (var cIdx = 0; cIdx < cells.length; cIdx++) {
        var ref = colName(cIdx) + rowNum;
        var v = cells[cIdx];
        var sAttr = bold ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) {
          parts.push('<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>');
        } else {
          parts.push('<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' +
            xmlText(v) + '</t></is></c>');
        }
      }
      parts.push('</row>');
    }
    parts.push('</sheetData></worksheet>');
    return parts.join('');
  }

  function contentTypesXml(n) {
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">');
    parts.push('<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>');
    parts.push('<Default Extension="xml" ContentType="application/xml"/>');
    parts.push('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>');
    parts.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
    for (var i = 1; i <= n; i++) {
      parts.push('<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    parts.push('</Types>');
    return parts.join('');
  }

  var ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  function workbookXml(sheets) {
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    parts.push('<sheets>');
    for (var i = 0; i < sheets.length; i++) {
      parts.push('<sheet name="' + xmlText(sheetName(sheets[i].name, i)) + '" sheetId="' + (i + 1) +
        '" r:id="rId' + (i + 1) + '"/>');
    }
    parts.push('</sheets></workbook>');
    return parts.join('');
  }

  // Sheet names: <=31 chars and none of : \ / ? * [ ] ; blanks fall back.
  function sheetName(name, idx) {
    var s = String(name == null ? '' : name).replace(/[:\\\/?*\[\]]/g, ' ').slice(0, 31).trim();
    return s || ('Sheet' + (idx + 1));
  }

  function workbookRels(sheets) {
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
    for (var i = 0; i < sheets.length; i++) {
      parts.push('<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    }
    parts.push('<Relationship Id="rId' + (sheets.length + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    parts.push('</Relationships>');
    return parts.join('');
  }

  // Two cell formats: index 0 = normal, index 1 = bold (used for header rows).
  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // ---- ZIP (STORE method) writer ---------------------------------------
  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  // Fixed DOS date/time (1980-01-01 00:00:00); value is irrelevant to Excel.
  var DOS_TIME = 0;
  var DOS_DATE = 33; // ((1980-1980)<<9) | (1<<5) | 1

  function zipStore(entries) {
    var chunks = [];
    var offset = 0;
    var central = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var nameBytes = utf8(e.name);
      var dataBytes = e.data; // Uint8Array
      var crc = crc32(dataBytes);
      var size = dataBytes.length;

      // Local file header.
      var lfh = []
        .concat(u32(0x04034b50)) // signature
        .concat(u16(20))         // version needed to extract
        .concat(u16(0))          // general purpose bit flag
        .concat(u16(0))          // compression method: 0 = store
        .concat(u16(DOS_TIME))
        .concat(u16(DOS_DATE))
        .concat(u32(crc))
        .concat(u32(size))       // compressed size (== uncompressed for store)
        .concat(u32(size))       // uncompressed size
        .concat(u16(nameBytes.length))
        .concat(u16(0));         // extra field length
      chunks.push(Uint8Array.from(lfh));
      chunks.push(nameBytes);
      chunks.push(dataBytes);

      // Central directory record (built now, emitted after all locals).
      var cdr = []
        .concat(u32(0x02014b50)) // signature
        .concat(u16(20))         // version made by
        .concat(u16(20))         // version needed to extract
        .concat(u16(0))          // general purpose bit flag
        .concat(u16(0))          // compression method
        .concat(u16(DOS_TIME))
        .concat(u16(DOS_DATE))
        .concat(u32(crc))
        .concat(u32(size))
        .concat(u32(size))
        .concat(u16(nameBytes.length))
        .concat(u16(0))          // extra field length
        .concat(u16(0))          // file comment length
        .concat(u16(0))          // disk number start
        .concat(u16(0))          // internal file attributes
        .concat(u32(0))          // external file attributes
        .concat(u32(offset));    // relative offset of local header
      central.push({ record: cdr, nameBytes: nameBytes });

      offset += lfh.length + nameBytes.length + dataBytes.length;
    }

    // Emit the central directory.
    var cdStart = offset;
    var cdSize = 0;
    for (var j = 0; j < central.length; j++) {
      chunks.push(Uint8Array.from(central[j].record));
      chunks.push(central[j].nameBytes);
      cdSize += central[j].record.length + central[j].nameBytes.length;
    }

    // End of central directory record.
    var eocd = []
      .concat(u32(0x06054b50)) // signature
      .concat(u16(0))          // number of this disk
      .concat(u16(0))          // disk with the start of the central directory
      .concat(u16(entries.length)) // entries on this disk
      .concat(u16(entries.length)) // total entries
      .concat(u32(cdSize))
      .concat(u32(cdStart))
      .concat(u16(0));         // .zip file comment length
    chunks.push(Uint8Array.from(eocd));

    // Concatenate all chunks into one Uint8Array.
    var total = 0;
    for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
    var out = new Uint8Array(total);
    var p = 0;
    for (var m = 0; m < chunks.length; m++) { out.set(chunks[m], p); p += chunks[m].length; }
    return out;
  }

  // ---- Public: assemble a full .xlsx workbook from sheet specs ---------
  function build(sheets) {
    sheets = (sheets || []).filter(function (s) { return s && s.rows; });
    if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];

    var entries = [];
    entries.push({ name: '[Content_Types].xml', data: utf8(contentTypesXml(sheets.length)) });
    entries.push({ name: '_rels/.rels', data: utf8(ROOT_RELS) });
    entries.push({ name: 'xl/workbook.xml', data: utf8(workbookXml(sheets)) });
    entries.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels(sheets)) });
    entries.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });
    for (var i = 0; i < sheets.length; i++) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(sheets[i])) });
    }
    return zipStore(entries);
  }

  global.CodonXlsx = {
    build: build,
    crc32: crc32,
    utf8: utf8,
    colName: colName,
    xmlText: xmlText
  };
})(typeof window !== 'undefined' ? window : this);
