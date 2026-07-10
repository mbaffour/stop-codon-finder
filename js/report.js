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

  function csvEscape(value) {
    var s = String(value);
    if (/[",\n\r]/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * hits -> CSV text.
   * Default header (7 columns, unchanged): seq_id,start,end,strand,frame,codon,name
   * With options.includeAnnotation, append: gene,locus_tag,product,context
   */
  function toCSV(hits, options) {
    options = options || {};
    var includeAnnotation = !!options.includeAnnotation;
    // stop_id is the stable per-hit id (stop_0001, ...) so rows in the CSV, the
    // JSON, and a future BED/GFF3 export all reference the same hit.
    var header = 'stop_id,seq_id,start,end,strand,frame,codon,name';
    if (includeAnnotation) header += ',gene,locus_tag,product,context,recoding_candidate';
    var rows = [header];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var cells = [
        csvEscape(h.id == null ? '' : h.id),
        csvEscape(h.seqId),
        h.start,
        h.end,
        h.strand,
        h.frame,
        h.codon,
        h.name
      ];
      if (includeAnnotation) {
        cells.push(csvEscape(h.geneName == null ? '' : h.geneName));
        cells.push(csvEscape(h.locusTag == null ? '' : h.locusTag));
        cells.push(csvEscape(h.product == null ? '' : h.product));
        cells.push(csvEscape(h.context == null ? '' : h.context));
        cells.push(h.recodingCandidate ? 'yes' : '');
      }
      rows.push(cells.join(','));
    }
    return rows.join('\r\n');
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

  /** summary + full hits array -> pretty-printed JSON text */
  function toJSON(summary, hits) {
    return JSON.stringify({ summary: summary, hits: hits }, null, 2);
  }

  /** Trigger a client-side download via Blob + object URL. No server involved. */
  function triggerDownload(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
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
    buildSummary: buildSummary,
    buildGeneSummary: buildGeneSummary,
    geneticCodeSanity: geneticCodeSanity,
    toCSV: toCSV,
    toJSON: toJSON,
    triggerDownload: triggerDownload
  };
})(typeof window !== 'undefined' ? window : this);
