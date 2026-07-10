/*
 * report.js -- Summary statistics, CSV/JSON export, and file download
 * helpers for Stop Codon Finder.
 *
 * Exposes a global `CodonReport` object.
 */
(function (global) {
  'use strict';

  var FRAME_ORDER = ['+1', '+2', '+3', '-1', '-2', '-3'];

  /**
   * Compute summary statistics over ALL hits and ALL sequences (never just
   * the capped table slice shown in the UI).
   *
   * @param {Array} hits
   * @param {Array} records
   * @param {Object} [options] options.stopCodons ({CODON:name}) seeds the
   *        dynamic byCodon keys so alternative genetic codes are represented
   *        even with zero counts. Falls back to TAA/TAG/TGA.
   */
  function buildSummary(hits, records, options) {
    records = records || [];
    options = options || {};
    var totalLength = 0;
    var gcCount = 0;

    for (var i = 0; i < records.length; i++) {
      var seq = records[i].seq || '';
      totalLength += seq.length;
      for (var j = 0; j < seq.length; j++) {
        var c = seq.charAt(j);
        if (c === 'G' || c === 'C') gcCount++;
      }
    }

    // byCodon is keyed dynamically: seed from the active stop set (so alt-table
    // stops appear), then include any codon actually encountered in hits.
    var byCodon = {};
    var codonOrder = [];
    function ensureCodon(cod) {
      if (byCodon[cod] === undefined) { byCodon[cod] = 0; codonOrder.push(cod); }
    }
    var seedStops = options.stopCodons || { TAA: 'ochre', TAG: 'amber', TGA: 'opal' };
    Object.keys(seedStops).forEach(ensureCodon);

    var byStrand = { '+': 0, '-': 0 };
    var byFrame = {};
    FRAME_ORDER.forEach(function (k) { byFrame[k] = 0; });
    var byContext = {};

    for (var h = 0; h < hits.length; h++) {
      var hit = hits[h];
      ensureCodon(hit.codon);
      byCodon[hit.codon]++;
      if (byStrand[hit.strand] !== undefined) byStrand[hit.strand]++;
      var key = hit.strand + hit.frame;
      if (byFrame[key] !== undefined) byFrame[key]++;
      if (hit.context) byContext[hit.context] = (byContext[hit.context] || 0) + 1;
    }

    var totalStops = hits.length;
    var lengthKb = totalLength / 1000;

    return {
      sequenceCount: records.length,
      totalLength: totalLength,
      gcCount: gcCount,
      gcPercent: totalLength > 0 ? (gcCount / totalLength) * 100 : 0,
      totalStops: totalStops,
      byCodon: byCodon,
      codonOrder: codonOrder,
      byStrand: byStrand,
      byFrame: byFrame,
      byContext: byContext,
      frameOrder: FRAME_ORDER.slice(),
      densityPerKb: lengthKb > 0 ? totalStops / lengthKb : 0,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * One row per CDS feature. internalStops counts same-strand in-frame internal
   * stops that fall within the CDS (i.e. hits classified 'cds-internal-inframe'
   * whose featureId matches). Rows with internalStops>0 are flagged as possible
   * pseudogenes. Only meaningful when annotation features are present.
   */
  function buildGeneSummary(hits, features) {
    features = features || [];
    hits = hits || [];

    var cds = features.filter(function (f) { return f.type === 'CDS'; });
    if (!cds.length) return [];

    // Map featureId -> row; also build quick lookup for terminator codon.
    var rows = [];
    var byId = {};
    cds.forEach(function (f) {
      var length = 0;
      for (var s = 0; s < f.segments.length; s++) length += (f.segments[s].end - f.segments[s].start + 1);
      var fid = f.id || f.locusTag || f.name;
      var row = {
        gene: f.name || null,
        locusTag: f.locusTag || null,
        product: f.product || null,
        length: length,
        internalStops: 0,
        terminatorCodon: null,
        featureId: fid,
        strand: f.strand,
        pseudogeneFlag: false
      };
      rows.push(row);
      if (fid != null && byId[fid] === undefined) byId[fid] = row;
    });

    for (var h = 0; h < hits.length; h++) {
      var hit = hits[h];
      if (hit.featureId == null) continue;
      var row2 = byId[hit.featureId];
      if (!row2) continue;
      if (hit.context === 'cds-internal-inframe') {
        row2.internalStops++;
      } else if (hit.context === 'cds-terminator') {
        row2.terminatorCodon = hit.codon;
      }
    }

    rows.forEach(function (r) { r.pseudogeneFlag = r.internalStops > 0; });
    return rows;
  }

  // ---- Coordinate convention (single source of truth) ------------------
  // Every tabular / text export states coordinates the SAME way so a CSV row, a
  // TSV row, a Markdown cell, a GFF3 ID and an HTML-report row can never drift.
  // BED is the ONLY 0-based, half-open format (that shift is owned in export.js
  // via CodonScanner.coords.toBed); everything here is 1-based inclusive.
  var COORD_NOTE = 'Coordinates are 1-based, inclusive (start and end both count). ' +
    'BED exports are the only 0-based, half-open format (chromStart = start − 1). ' +
    'Each hit keeps one stable ID (stop_0001, …) across every format.';

  // ---- Shared field escaping -------------------------------------------
  function csvEscape(value) {
    var s = String(value == null ? '' : value);
    if (/[",\n\r]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }
  // TSV has no portable quoting convention; the safe, lossless-enough rule used
  // by Excel/Sheets paste is to collapse embedded TAB/CR/LF in a cell to spaces
  // so column alignment can never break.
  function tsvEscape(value) {
    return String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ');
  }
  // GitHub-flavoured Markdown table cell: escape the pipe and flatten newlines.
  function mdEscape(value) {
    return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  }
  // Minimal HTML text escaping for the self-contained report.
  function htmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function signedFrame(h) { return (h.strand === '-' ? '-' : '+') + h.frame; }

  // ---- Canonical results columns (shared by CSV / TSV / Markdown) -------
  // ONE definition of the results columns + per-hit cell values, so the tabular
  // formats stay identical in column set, order, and hit-id threading. `strand`
  // and `frame` stay separate columns (matching the long-standing CSV); the
  // frame value is the unsigned reading frame (1/2/3) as in the CSV.
  function resultsHeader(includeAnnotation) {
    var cols = ['stop_id', 'seq_id', 'start', 'end', 'strand', 'frame', 'codon', 'name'];
    if (includeAnnotation) cols = cols.concat(['gene', 'locus_tag', 'product', 'context', 'recoding_candidate']);
    return cols;
  }
  function resultsCells(h, includeAnnotation) {
    var cells = [
      h.id == null ? '' : h.id,
      h.seqId, h.start, h.end, h.strand, h.frame, h.codon, h.name
    ];
    if (includeAnnotation) {
      cells.push(h.geneName == null ? '' : h.geneName);
      cells.push(h.locusTag == null ? '' : h.locusTag);
      cells.push(h.product == null ? '' : h.product);
      cells.push(h.context == null ? '' : h.context);
      cells.push(h.recodingCandidate ? 'yes' : '');
    }
    return cells;
  }

  // Generic delimited-text writer over a header + rows-of-arrays, escaping each
  // cell per the chosen delimiter's rules.
  function delimited(header, rows, delim, escFn, lineSep) {
    var out = [header.map(escFn).join(delim)];
    for (var i = 0; i < rows.length; i++) out.push(rows[i].map(escFn).join(delim));
    return out.join(lineSep);
  }

  /**
   * hits -> CSV text (RFC-4180-ish, CRLF line endings).
   * Header (8 cols): stop_id,seq_id,start,end,strand,frame,codon,name
   * With options.includeAnnotation, append: gene,locus_tag,product,context,recoding_candidate
   */
  function toCSV(hits, options) {
    options = options || {};
    var ann = !!options.includeAnnotation;
    hits = hits || [];
    var rows = hits.map(function (h) { return resultsCells(h, ann); });
    return delimited(resultsHeader(ann), rows, ',', csvEscape, '\r\n');
  }

  /** hits -> TSV text. Same columns/threading as toCSV; tab-separated, LF lines
   *  (what Excel / Google Sheets expect from a clipboard/file paste). */
  function toTSV(hits, options) {
    options = options || {};
    var ann = !!options.includeAnnotation;
    hits = hits || [];
    var rows = hits.map(function (h) { return resultsCells(h, ann); });
    return delimited(resultsHeader(ann), rows, '\t', tsvEscape, '\n') + '\n';
  }

  /** hits -> GitHub-flavoured Markdown table. Same columns/threading as toCSV. */
  function toMarkdown(hits, options) {
    options = options || {};
    var ann = !!options.includeAnnotation;
    hits = hits || [];
    var header = resultsHeader(ann);
    var lines = ['| ' + header.map(mdEscape).join(' | ') + ' |'];
    lines.push('| ' + header.map(function () { return '---'; }).join(' | ') + ' |');
    for (var i = 0; i < hits.length; i++) {
      lines.push('| ' + resultsCells(hits[i], ann).map(mdEscape).join(' | ') + ' |');
    }
    return lines.join('\n') + '\n';
  }

  // ---- Per-gene summary as tabular text --------------------------------
  function geneSummaryHeader() {
    return ['gene', 'locus_tag', 'product', 'length_bp', 'internal_stops',
      'terminator_codon', 'strand', 'pseudogene_flag', 'feature_id'];
  }
  function geneSummaryCells(r) {
    return [
      r.gene == null ? '' : r.gene,
      r.locusTag == null ? '' : r.locusTag,
      r.product == null ? '' : r.product,
      r.length,
      r.internalStops,
      r.terminatorCodon == null ? '' : r.terminatorCodon,
      r.strand == null ? '' : r.strand,
      r.pseudogeneFlag ? 'yes' : '',
      r.featureId == null ? '' : r.featureId
    ];
  }
  function geneSummaryToCSV(geneSummary) {
    var rows = (geneSummary || []).map(geneSummaryCells);
    return delimited(geneSummaryHeader(), rows, ',', csvEscape, '\r\n');
  }
  function geneSummaryToTSV(geneSummary) {
    var rows = (geneSummary || []).map(geneSummaryCells);
    return delimited(geneSummaryHeader(), rows, '\t', tsvEscape, '\n') + '\n';
  }

  // ---- Per-frame breakdown ---------------------------------------------
  // Tally counts per (signed frame x codon), seeded by the active stop list so
  // every stop of the current genetic code appears even at zero. Pure (no DOM),
  // so app.js and Node self-tests share one definition.
  function buildFrameBreakdown(hits, stops) {
    hits = hits || [];
    stops = stops || [];
    var table = {};
    FRAME_ORDER.forEach(function (k) {
      table[k] = { total: 0 };
      stops.forEach(function (c) { table[k][c] = 0; });
    });
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var key = (h.strand === '-' ? '-' : '+') + h.frame;
      if (!table[key]) continue;
      if (table[key][h.codon] !== undefined) table[key][h.codon]++;
      table[key].total++;
    }
    return table;
  }
  function frameBreakdownHeader(stops) {
    return ['frame'].concat(stops || []).concat(['total']);
  }
  function frameBreakdownRows(table, stops) {
    stops = stops || [];
    return FRAME_ORDER.map(function (key) {
      var d = table[key] || { total: 0 };
      return [key].concat(stops.map(function (c) { return d[c] || 0; })).concat([d.total]);
    });
  }
  function frameBreakdownToCSV(hits, stops) {
    var table = buildFrameBreakdown(hits, stops);
    return delimited(frameBreakdownHeader(stops), frameBreakdownRows(table, stops), ',', csvEscape, '\r\n');
  }
  function frameBreakdownToTSV(hits, stops) {
    var table = buildFrameBreakdown(hits, stops);
    return delimited(frameBreakdownHeader(stops), frameBreakdownRows(table, stops), '\t', tsvEscape, '\n') + '\n';
  }

  /**
   * Cheap genetic-code sanity heuristic. When annotation (CDS features) is
   * present, a selected translation table is probably WRONG for the data if a
   * large fraction of CDS either (a) contain in-frame internal stops, or (b) do
   * not terminate in a stop codon. Consumes the gene summary produced by
   * buildGeneSummary. Returns a small object the UI can surface as a nudge.
   *
   * `recoded` in-frame stops (selenocysteine / per-feature code) are already
   * excluded upstream (they land in 'cds-recoded', not 'cds-internal-inframe'),
   * so they do not inflate the internal-stop signal here.
   */
  function geneticCodeSanity(geneSummary, options) {
    options = options || {};
    var rows = geneSummary || [];
    var cdsCount = rows.length;
    var minCds = options.minCds || 20; // need enough CDS for the signal to mean anything
    var withInternal = 0, withoutTerminator = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].internalStops > 0) withInternal++;
      if (!rows[i].terminatorCodon) withoutTerminator++;
    }
    var fInternal = cdsCount ? withInternal / cdsCount : 0;
    var fNoTerm = cdsCount ? withoutTerminator / cdsCount : 0;
    var internalThresh = options.internalThreshold || 0.10;
    var noTermThresh = options.noTerminatorThreshold || 0.20;
    var suspicious = cdsCount >= minCds && (fInternal > internalThresh || fNoTerm > noTermThresh);

    var message = null;
    if (suspicious) {
      var reasons = [];
      if (fInternal > internalThresh) reasons.push(Math.round(fInternal * 100) + '% of CDS have in-frame internal stops');
      if (fNoTerm > noTermThresh) reasons.push(Math.round(fNoTerm * 100) + '% of CDS do not end in a stop codon');
      message = 'The selected genetic code may be wrong for this data: ' + reasons.join(' and ') +
        '. Check the translation table / organism.';
    }
    return {
      suspicious: suspicious,
      cdsCount: cdsCount,
      withInternalStops: withInternal,
      withoutTerminator: withoutTerminator,
      fractionInternalStops: fInternal,
      fractionNoTerminator: fNoTerm,
      message: message
    };
  }

  /**
   * summary + full hits array -> pretty-printed JSON text.
   * `extras` (optional) folds the other tables into the same document so a single
   * JSON download carries the results, the per-gene summary, and the per-frame
   * breakdown: { geneSummary, stops } -> adds `geneSummary` and `frameBreakdown`.
   */
  function toJSON(summary, hits, extras) {
    var doc = { summary: summary, hits: hits };
    if (extras) {
      if (extras.geneSummary) doc.geneSummary = extras.geneSummary;
      if (extras.stops) {
        doc.frameBreakdown = buildFrameBreakdown(hits, extras.stops);
        doc.frameBreakdown.frameOrder = FRAME_ORDER.slice();
        doc.frameBreakdown.stops = extras.stops.slice();
      }
    }
    return JSON.stringify(doc, null, 2);
  }

  // ---- Self-contained, printable HTML report ("report sheet") ----------
  // Builds a COMPLETE standalone .html document (own <!doctype>, <style>) with no
  // external references, so it opens offline from a download. Embeds the summary
  // stats, the per-frame breakdown, the per-gene summary, a capped copy of the
  // results table, and a static inline SVG of the key chart + colour legend.
  // Pure string building (no DOM) so it is Node-testable. All colours are baked
  // in as concrete values (data.colors.codonFills / codonInks, light-theme AA-on-
  // white ramps) — the report is deliberately a light, print-friendly sheet.
  function toHTMLReport(data) {
    data = data || {};
    var s = data.summary || {};
    var hits = data.hits || [];
    var stops = data.stops || [];
    var stopNames = data.stopNames || {};
    var geneSummary = data.geneSummary || [];
    var ann = !!data.includeAnnotation;
    var maxRows = data.maxRows || 2000;
    var fills = (data.colors && data.colors.codonFills) || ['#e69f00', '#56b4e9', '#009e73', '#d55e00', '#0072b2', '#cc79a7'];
    var inks = (data.colors && data.colors.codonInks) || fills;
    var title = data.title || 'Stop Codon Finder report';
    var generatedAt = data.generatedAt || (s.generatedAt || new Date().toISOString());

    function fmtInt(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
    function codonColor(codon, ramp) {
      var i = stops.indexOf(codon);
      return (i >= 0) ? ramp[i % 6] : ramp[5];
    }

    // --- summary stat cards ---
    var cards = [];
    cards.push({ label: 'Sequences', value: fmtInt(s.sequenceCount || 0) });
    cards.push({ label: 'Total length', value: fmtInt(s.totalLength || 0) + ' bp' });
    cards.push({ label: 'GC content', value: (s.gcPercent || 0).toFixed(1) + '%' });
    cards.push({ label: 'Total stop codons', value: fmtInt(s.totalStops || 0), hero: true });
    stops.forEach(function (codon) {
      var name = stopNames[codon] || 'stop';
      cards.push({
        label: codon + (name !== 'stop' ? ' (' + name + ')' : ''),
        value: fmtInt((s.byCodon && s.byCodon[codon]) || 0),
        swatch: codonColor(codon, fills)
      });
    });
    cards.push({ label: 'Forward strand (+)', value: fmtInt((s.byStrand && s.byStrand['+']) || 0) });
    cards.push({ label: 'Reverse strand (−)', value: fmtInt((s.byStrand && s.byStrand['-']) || 0) });
    cards.push({ label: 'Density', value: (s.densityPerKb || 0).toFixed(2) + ' /kb', sub: 'stops per 1,000 bp' });

    var cardHtml = cards.map(function (c) {
      return '<div class="card' + (c.hero ? ' hero' : '') + '">' +
        '<div class="lbl">' + (c.swatch ? '<span class="sw" style="background:' + c.swatch + '"></span>' : '') + htmlEscape(c.label) + '</div>' +
        '<div class="val">' + htmlEscape(c.value) + '</div>' +
        (c.sub ? '<div class="sub">' + htmlEscape(c.sub) + '</div>' : '') +
        '</div>';
    }).join('');

    // --- chart + legend ---
    var chartHtml = '';
    if (data.chartSVG) {
      var legendHtml = stops.map(function (codon) {
        var name = stopNames[codon] || 'stop';
        return '<span class="leg"><span class="sw" style="background:' + codonColor(codon, fills) + '"></span>' +
          htmlEscape(codon) + (name !== 'stop' ? ' (' + htmlEscape(name) + ')' : '') + '</span>';
      }).join('');
      chartHtml = '<section><h2>Per-frame breakdown</h2>' +
        '<div class="chart">' + data.chartSVG + '</div>' +
        '<div class="legend">' + legendHtml + '</div></section>';
    }

    // --- per-frame table ---
    var fbTable = buildFrameBreakdown(hits, stops);
    var fbHead = frameBreakdownHeader(stops);
    var fbRows = frameBreakdownRows(fbTable, stops);
    var frameTableHtml = '<section><h2>Counts per frame</h2>' +
      renderHtmlTable(fbHead, fbRows, null) + '</section>';

    // --- per-gene summary ---
    var geneHtml = '';
    if (geneSummary.length) {
      var gHead = ['Gene', 'Locus tag', 'Product', 'Length (bp)', 'Internal stops', 'Terminator', 'Strand'];
      var gRows = geneSummary.map(function (r) {
        return [
          r.gene || r.locusTag || r.featureId || '—',
          r.locusTag || '—',
          r.product || '—',
          fmtInt(r.length),
          r.internalStops,
          r.terminatorCodon || '—',
          r.strand || '—'
        ];
      });
      var flagged = geneSummary.filter(function (r) { return r.pseudogeneFlag; }).length;
      geneHtml = '<section><h2>Per-gene summary</h2>' +
        renderHtmlTable(gHead, gRows, geneSummary.map(function (r) { return r.pseudogeneFlag; })) +
        '<p class="note">' + fmtInt(geneSummary.length) + ' CDS' + (geneSummary.length === 1 ? '' : 's') +
        (flagged ? ' — ' + fmtInt(flagged) + ' with in-frame internal stop(s) (possible pseudogene' + (flagged === 1 ? '' : 's') + ')' : '') +
        '.</p></section>';
    }

    // --- results table (capped) ---
    var shown = hits.slice(0, maxRows);
    var rHead = ['ID', 'Seq', 'Start', 'End', 'Strand', 'Frame', 'Codon', 'Name'];
    if (ann) rHead = rHead.concat(['Gene', 'Context']);
    var rRows = shown.map(function (h) {
      var codonCell = '<span class="codon" style="color:' + codonColor(h.codon, inks) + '">' + htmlEscape(h.codon) + '</span>';
      var row = [
        h.id == null ? '' : h.id,
        h.seqId,
        fmtInt(h.start),
        fmtInt(h.end),
        h.strand === '-' ? '−' : '+',
        signedFrame(h),
        { html: codonCell },
        h.name == null ? '' : h.name
      ];
      if (ann) {
        row.push(h.geneName || h.locusTag || (h.featureId != null ? h.featureId : '') || '—');
        row.push(h.context || '—');
      }
      return row;
    });
    var resultsNote = hits.length > shown.length
      ? 'Showing the first ' + fmtInt(shown.length) + ' of ' + fmtInt(hits.length) +
        ' hits. Download the CSV / TSV export for every row.'
      : 'Showing all ' + fmtInt(hits.length) + ' hit' + (hits.length === 1 ? '' : 's') + '.';
    var resultsHtml = '<section><h2>Results</h2>' +
      renderHtmlTable(rHead, rRows, null) +
      '<p class="note">' + resultsNote + '</p></section>';

    // --- provenance ---
    var prov = data.provenance || {};
    var provBits = [];
    if (prov.translationTable) provBits.push('Translation table ' + (prov.translationTable.id != null ? prov.translationTable.id + ' — ' : '') + htmlEscape(prov.translationTable.name || ''));
    if (prov.organism) provBits.push('Organism: ' + htmlEscape(prov.organism));
    var provHtml = provBits.length ? '<p class="prov">' + provBits.join(' &middot; ') + '</p>' : '';

    var rootVars = '';
    for (var vi = 0; vi < 6; vi++) rootVars += '--codon-' + (vi + 1) + ':' + (fills[vi] || fills[fills.length - 1]) + ';';

    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + htmlEscape(title) + '</title>' +
      '<style>' + reportCSS(rootVars) + '</style></head><body>' +
      '<main>' +
      '<header><h1>' + htmlEscape(title) + '</h1>' +
      '<p class="meta">Generated ' + htmlEscape(generatedAt) + ' &middot; Stop Codon Finder</p>' +
      provHtml + '</header>' +
      '<section><h2>Summary</h2><div class="grid">' + cardHtml + '</div></section>' +
      chartHtml +
      frameTableHtml +
      geneHtml +
      resultsHtml +
      '<footer><p class="note">' + htmlEscape(COORD_NOTE) + '</p></footer>' +
      '</main></body></html>\n';
  }

  // Render a table from a header array + rows of arrays. A cell may be a string,
  // a number, or { html: '<...>' } for pre-escaped markup (codon pills). An
  // optional `flags` array (one boolean per row) marks a row with a warn dot.
  function renderHtmlTable(header, rows, flags) {
    var thead = '<thead><tr>' + header.map(function (h) { return '<th>' + htmlEscape(h) + '</th>'; }).join('') + '</tr></thead>';
    var body = rows.map(function (cells, ri) {
      var warn = flags && flags[ri] ? '<span class="dot" title="in-frame internal stop(s)"></span> ' : '';
      var tds = cells.map(function (c, ci) {
        var inner = (c && typeof c === 'object' && c.html != null) ? c.html : htmlEscape(c);
        return '<td>' + (ci === 0 ? warn : '') + inner + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    return '<div class="tbl-wrap"><table>' + thead + '<tbody>' + body + '</tbody></table></div>';
  }

  function reportCSS(rootVars) {
    return ':root{' + rootVars + '--fg:#1a2027;--muted:#5a6672;--line:#dce3ea;--bg:#fff;--sub:#f4f7fa;}' +
      '*{box-sizing:border-box;}' +
      'body{margin:0;background:#eef2f6;color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
      'main{max-width:1000px;margin:0 auto;padding:32px 24px 56px;background:var(--bg);}' +
      'h1{font-size:1.6rem;margin:0 0 4px;}h2{font-size:1.15rem;margin:0 0 12px;border-bottom:2px solid var(--line);padding-bottom:6px;}' +
      'header{margin-bottom:28px;}.meta{color:var(--muted);margin:0;font-size:.85rem;}' +
      '.prov{color:var(--muted);font-size:.85rem;margin:8px 0 0;}' +
      'section{margin:28px 0;}' +
      '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}' +
      '.grid .card{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--sub);}' +
      '.grid .card.hero{background:#0072b2;border-color:#0072b2;color:#fff;}' +
      '.grid .lbl{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:6px;}' +
      '.grid .card.hero .lbl,.grid .card.hero .sub{color:rgba(255,255,255,.85);}' +
      '.grid .val{font-size:1.4rem;font-weight:700;margin-top:4px;}' +
      '.grid .sub{font-size:.72rem;color:var(--muted);margin-top:2px;}' +
      '.sw{display:inline-block;width:11px;height:11px;border-radius:3px;flex:none;}' +
      '.chart{overflow-x:auto;padding:8px 0;}.chart svg{max-width:100%;height:auto;}' +
      '.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.82rem;color:var(--muted);margin-top:8px;}' +
      '.leg{display:inline-flex;align-items:center;gap:6px;}' +
      '.tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;}' +
      'table{border-collapse:collapse;width:100%;font-size:.85rem;}' +
      'th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap;}' +
      'th{background:var(--sub);font-weight:600;position:sticky;top:0;}' +
      'tbody tr:nth-child(even){background:#fafcfe;}' +
      '.codon{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;}' +
      '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#d97706;vertical-align:middle;}' +
      '.note{color:var(--muted);font-size:.8rem;margin:10px 0 0;}' +
      'footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);}' +
      '@media print{body{background:#fff;}main{max-width:none;padding:0;}th{position:static;}.grid .card.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}';
  }

  // ---- Native Excel workbook (.xlsx) -----------------------------------
  // Assemble the multi-sheet workbook description consumed by CodonXlsx.build().
  // Reuses the SAME shared column helpers as CSV/TSV (resultsHeader/resultsCells,
  // geneSummaryHeader/Cells, frameBreakdownHeader/Rows) so the spreadsheet stays
  // column-consistent with every other tabular export, including the stable id.
  // Returns an array of { name, header, rows } sheet specs; pure (no DOM), so it
  // is Node-testable. Pass the FULL hit set (downloads ignore the on-screen
  // filter). `build()` writes numbers as numeric cells and everything else as
  // inline strings, so cells here are left as their natural JS types.
  function buildWorkbook(data) {
    data = data || {};
    var s = data.summary || {};
    var hits = data.hits || [];
    var stops = data.stops || [];
    var stopNames = data.stopNames || {};
    var geneSummary = data.geneSummary || [];
    var ann = !!data.includeAnnotation;
    var prov = data.provenance || {};
    var generatedAt = data.generatedAt || s.generatedAt || new Date().toISOString();

    // --- Summary sheet: label / value rows (+ provenance) ---
    var sumRows = [['Field', 'Value']];
    sumRows.push(['Report', 'Stop Codon Finder']);
    sumRows.push(['Generated', generatedAt]);
    if (prov.organism) sumRows.push(['Organism', prov.organism]);
    if (prov.translationTable) {
      var tt = prov.translationTable;
      sumRows.push(['Translation table', (tt.id != null ? tt.id + ' — ' : '') + (tt.name || '')]);
      if (tt.source) sumRows.push(['Table source', String(tt.source)]);
    }
    sumRows.push(['Sequences', Number(s.sequenceCount || 0)]);
    sumRows.push(['Total length (bp)', Number(s.totalLength || 0)]);
    sumRows.push(['GC content (%)', Number((s.gcPercent || 0).toFixed(2))]);
    sumRows.push(['Total stop codons', Number(s.totalStops || 0)]);
    sumRows.push(['Density (per kb)', Number((s.densityPerKb || 0).toFixed(3))]);
    stops.forEach(function (codon) {
      var nm = stopNames[codon] || (STOP_NAME_LOCAL[codon]);
      var label = codon + (nm && nm !== 'stop' ? ' (' + nm + ')' : '');
      sumRows.push([label, Number((s.byCodon && s.byCodon[codon]) || 0)]);
    });
    sumRows.push(['Forward strand (+)', Number((s.byStrand && s.byStrand['+']) || 0)]);
    sumRows.push(['Reverse strand (−)', Number((s.byStrand && s.byStrand['-']) || 0)]);
    sumRows.push(['Coordinate convention', COORD_NOTE]);

    var sheets = [{ name: 'Summary', header: true, rows: sumRows }];

    // --- Stop codons sheet: full results table (same columns as CSV) ---
    var stopRows = [resultsHeader(ann)];
    for (var i = 0; i < hits.length; i++) stopRows.push(resultsCells(hits[i], ann));
    sheets.push({ name: 'Stop codons', header: true, rows: stopRows });

    // --- Per-gene sheet (only when a per-gene summary exists) ---
    if (geneSummary.length) {
      var geneRows = [geneSummaryHeader()];
      for (var g = 0; g < geneSummary.length; g++) geneRows.push(geneSummaryCells(geneSummary[g]));
      sheets.push({ name: 'Per-gene', header: true, rows: geneRows });
    }

    // --- Per-frame sheet ---
    var fbTable = buildFrameBreakdown(hits, stops);
    var frameRows = [frameBreakdownHeader(stops)].concat(frameBreakdownRows(fbTable, stops));
    sheets.push({ name: 'Per-frame', header: true, rows: frameRows });

    return sheets;
  }

  var STOP_NAME_LOCAL = { TAA: 'ochre', TAG: 'amber', TGA: 'opal' };

  /**
   * Build the raw .xlsx bytes (Uint8Array) for the current data. Thin bridge over
   * CodonXlsx.build(buildWorkbook(data)); returns null if the writer is absent.
   */
  function toXlsx(data) {
    if (!global.CodonXlsx || !global.CodonXlsx.build) return null;
    return global.CodonXlsx.build(buildWorkbook(data));
  }

  // ---- Human-readable plain-text report (.txt) -------------------------
  // A Notepad-friendly summary: title, provenance, the summary stats (counts per
  // codon / frame / strand, GC%, density) and a short per-frame + top-genes
  // block. Deliberately NOT the CSV table. Pure string building (no DOM).
  function toTextReport(data) {
    data = data || {};
    var s = data.summary || {};
    var hits = data.hits || [];
    var stops = data.stops || [];
    var stopNames = data.stopNames || {};
    var geneSummary = data.geneSummary || [];
    var prov = data.provenance || {};
    var generatedAt = data.generatedAt || s.generatedAt || new Date().toISOString();
    var EOL = '\r\n'; // Notepad-friendly CRLF

    function fmtInt(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }
    function rule(ch) { return new Array(61).join(ch || '='); }
    function pad(str, n) { str = String(str); while (str.length < n) str += ' '; return str; }

    var L = [];
    L.push('STOP CODON FINDER — REPORT');
    L.push(rule('='));
    L.push('Generated: ' + generatedAt);

    // Provenance
    if (prov.organism) L.push('Organism:  ' + prov.organism);
    if (prov.translationTable) {
      var tt = prov.translationTable;
      L.push('Genetic code: table ' + (tt.id != null ? tt.id : '?') +
        (tt.name ? ' (' + tt.name + ')' : '') + (tt.source ? ' — from ' + tt.source : ''));
    }
    L.push('');

    // Summary stats
    L.push('SUMMARY');
    L.push(rule('-'));
    L.push(pad('Sequences:', 22) + fmtInt(s.sequenceCount || 0));
    L.push(pad('Total length:', 22) + fmtInt(s.totalLength || 0) + ' bp');
    L.push(pad('GC content:', 22) + (s.gcPercent || 0).toFixed(1) + ' %');
    L.push(pad('Total stop codons:', 22) + fmtInt(s.totalStops || 0));
    L.push(pad('Density:', 22) + (s.densityPerKb || 0).toFixed(2) + ' per kb');
    L.push('');

    // Per-codon
    L.push('STOP CODONS BY TYPE');
    L.push(rule('-'));
    stops.forEach(function (codon) {
      var nm = stopNames[codon] || STOP_NAME_LOCAL[codon];
      var label = codon + (nm && nm !== 'stop' ? ' (' + nm + ')' : '');
      L.push(pad(label + ':', 22) + fmtInt((s.byCodon && s.byCodon[codon]) || 0));
    });
    L.push('');

    // Strand
    L.push('BY STRAND');
    L.push(rule('-'));
    L.push(pad('Forward (+):', 22) + fmtInt((s.byStrand && s.byStrand['+']) || 0));
    L.push(pad('Reverse (−):', 22) + fmtInt((s.byStrand && s.byStrand['-']) || 0));
    L.push('');

    // Per-frame block
    L.push('BY READING FRAME');
    L.push(rule('-'));
    var fb = buildFrameBreakdown(hits, stops);
    var head = frameBreakdownHeader(stops);
    L.push(head.map(function (h) { return pad(h, 8); }).join(''));
    frameBreakdownRows(fb, stops).forEach(function (row) {
      L.push(row.map(function (v) { return pad(v, 8); }).join(''));
    });
    L.push('');

    // Top genes by terminator / internal stops (when annotation present)
    if (geneSummary.length) {
      L.push('GENES WITH IN-FRAME INTERNAL STOPS (possible pseudogenes / readthrough)');
      L.push(rule('-'));
      var flagged = geneSummary.filter(function (r) { return r.internalStops > 0; })
        .sort(function (a, b) { return b.internalStops - a.internalStops; });
      if (!flagged.length) {
        L.push('None — every CDS terminates cleanly with no in-frame internal stop.');
      } else {
        L.push(pad('Gene/locus', 26) + pad('Internal', 10) + 'Terminator');
        flagged.slice(0, 20).forEach(function (r) {
          var nm = r.gene || r.locusTag || r.featureId || '(unnamed)';
          L.push(pad(String(nm).slice(0, 25), 26) + pad(String(r.internalStops), 10) +
            (r.terminatorCodon || '—'));
        });
        if (flagged.length > 20) L.push('... and ' + (flagged.length - 20) + ' more.');
      }
      L.push('');
    }

    L.push(rule('='));
    L.push(COORD_NOTE);
    L.push('');
    return L.join(EOL);
  }

  /** Trigger a client-side download via Blob + object URL. No server involved.
   *  `content` may be a string, a Uint8Array/ArrayBuffer (binary formats such as
   *  .xlsx) or a Blob — the Blob constructor accepts all three. */
  function triggerDownload(filename, content, mimeType) {
    var blob = (content instanceof Blob) ? content
      : new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke shortly after to make sure the download has been handed off.
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  global.CodonReport = {
    FRAME_ORDER: FRAME_ORDER,
    COORD_NOTE: COORD_NOTE,
    buildSummary: buildSummary,
    buildGeneSummary: buildGeneSummary,
    geneticCodeSanity: geneticCodeSanity,
    buildFrameBreakdown: buildFrameBreakdown,
    toCSV: toCSV,
    toTSV: toTSV,
    toMarkdown: toMarkdown,
    geneSummaryToCSV: geneSummaryToCSV,
    geneSummaryToTSV: geneSummaryToTSV,
    frameBreakdownToCSV: frameBreakdownToCSV,
    frameBreakdownToTSV: frameBreakdownToTSV,
    toJSON: toJSON,
    toHTMLReport: toHTMLReport,
    buildWorkbook: buildWorkbook,
    toXlsx: toXlsx,
    toTextReport: toTextReport,
    triggerDownload: triggerDownload
  };
})(typeof window !== 'undefined' ? window : this);
