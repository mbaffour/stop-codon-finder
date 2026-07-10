/*
 * export.js -- Extended, coordinate-correct exports for Stop Codon Finder.
 *
 * Exposes a global `CodonExport`. Pure client-side text/Blob generation, no
 * network, file:// safe. Builds on the shared coordinate helper
 * (CodonScanner.coords) so BED's 0-based half-open shift and GFF3's 1-based
 * inclusive coords can never drift, and threads the stable per-hit id
 * (h.id = "stop_0001", ...) through EVERY export so a CSV row, a GFF3 ID, a BED
 * name and a FASTA/ORF defline all cross-reference the same hit.
 *
 * Formats:
 *   toGFF3(hits, records, opts)          -> GFF3 text (1-based inclusive, phase 0)
 *   toBED(hits, opts)                    -> BED6 (or BED9 w/ itemRgb) 0-based half-open
 *   toFastaNucleotide(features, records) -> FASTA (.fna) of ORF/CDS nucleotides
 *   toFastaProtein(features, records, o) -> FASTA (.faa) translated per table
 *
 * Figure export (no libraries):
 *   downloadSVG(svgEl, filename)         -> standalone .svg (CSS vars inlined)
 *   downloadPNG(svgEl, filename, scale)  -> .png via an offscreen canvas
 */
(function (global) {
  'use strict';

  function dl(filename, content, mime) {
    if (global.CodonReport && global.CodonReport.triggerDownload) {
      global.CodonReport.triggerDownload(filename, content, mime);
    }
  }

  // ---- GFF3 ------------------------------------------------------------
  // Percent-encode the exact reserved set the GFF3 spec calls out for column 9
  // attribute values: ; = & , plus TAB CR LF and % itself. % MUST be escaped
  // first so we never double-encode an already-literal percent.
  function gffEnc(s) {
    return String(s == null ? '' : s)
      .replace(/%/g, '%25')
      .replace(/;/g, '%3B')
      .replace(/=/g, '%3D')
      .replace(/&/g, '%26')
      .replace(/,/g, '%2C')
      .replace(/\t/g, '%09')
      .replace(/\n/g, '%0A')
      .replace(/\r/g, '%0D');
  }

  function signedFrame(h) { return (h.strand === '-' ? '-' : '+') + h.frame; }

  /**
   * hits + records -> GFF3 text.
   * - Standalone stop codons: the phase column (col 8) is ALWAYS 0 (phase is
   *   meaningless for an isolated 3 bp feature); the reading frame is carried in
   *   the `frame` attribute instead, never in the phase column.
   * - Origin-wrapping hits (end < start on a circular replicon) cannot be a
   *   single 1-based interval and are omitted with a trailing comment.
   */
  function toGFF3(hits, records, options) {
    options = options || {};
    hits = hits || [];
    records = records || [];

    var lines = ['##gff-version 3'];
    records.forEach(function (r) {
      if (r && r.seq) lines.push('##sequence-region ' + r.id + ' 1 ' + r.seq.length);
    });
    // Circular topology is expressed with a landmark `region` feature carrying
    // Is_circular=true (the GFF3-spec-sanctioned representation).
    records.forEach(function (r) {
      if (r && r.circular) {
        lines.push([r.id, 'StopCodonFinder', 'region', 1, r.seq.length, '.', '+', '.',
          'ID=region_' + gffEnc(r.id) + ';Is_circular=true'].join('\t'));
      }
    });

    var wrapped = 0;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.end < h.start) { wrapped++; continue; } // origin-wrapping: not a single interval
      var attrs = 'ID=' + gffEnc(h.id == null ? ('stop_' + (i + 1)) : h.id) +
        ';Name=' + gffEnc(h.codon) +
        ';codon=' + gffEnc(h.codon) +
        ';frame=' + gffEnc(signedFrame(h)) +
        ';context=' + gffEnc(h.context == null ? '' : h.context);
      if (h.geneName) attrs += ';gene=' + gffEnc(h.geneName);
      if (h.locusTag) attrs += ';locus_tag=' + gffEnc(h.locusTag);
      if (h.name) attrs += ';stop_name=' + gffEnc(h.name);
      lines.push([h.seqId, 'StopCodonFinder', 'stop_codon', h.start, h.end, '.', h.strand, '0', attrs].join('\t'));
    }
    if (wrapped) {
      lines.push('# ' + wrapped + ' origin-wrapping stop codon(s) omitted (cannot be a single 1-based GFF3 interval).');
    }
    return lines.join('\n') + '\n';
  }

  // ---- BED -------------------------------------------------------------
  // Colorblind-safe itemRgb palette, indexed by the codon's position in the
  // active stop list (mirrors the --codon-N CSS palette). Concrete RGB (BED is
  // plain text, no CSS vars).
  var BED_PALETTE = ['184,134,11', '224,138,0', '15,158,143', '91,108,196', '181,70,139', '108,122,137'];

  function codonRgb(codon, stops) {
    var idx = stops ? stops.indexOf(codon) : -1;
    if (idx < 0) idx = 5; else idx = idx % 6;
    return BED_PALETTE[idx];
  }

  /**
   * hits -> BED text. BED is 0-based, half-open: chromStart = start - 1,
   * chromEnd = end (delegated to CodonScanner.coords.toBed so the off-by-one is
   * owned in ONE place). Wrapping hits (toBed -> null) are skipped.
   *   BED6:  chrom start end name score strand
   *   BED9:  + thickStart thickEnd itemRgb   (options.bed9, colored by codon)
   * name defaults to the stable hit id, falling back to codon_strand.
   */
  function toBED(hits, options) {
    options = options || {};
    hits = hits || [];
    var bed9 = !!options.bed9;
    var stops = options.stops || [];
    var coords = (global.CodonScanner && global.CodonScanner.coords) || {
      toBed: function (h) { return h.end < h.start ? null : { chromStart: h.start - 1, chromEnd: h.end }; }
    };

    var lines = [];
    if (bed9) lines.push('track name="StopCodonFinder stops" itemRgb="On"');
    var wrapped = 0;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var b = coords.toBed(h);
      if (!b) { wrapped++; continue; }
      var name = (h.id != null && h.id !== '') ? h.id : (h.codon + '_' + (h.strand === '-' ? 'minus' : 'plus'));
      var row = [h.seqId, b.chromStart, b.chromEnd, name, 0, h.strand];
      if (bed9) row.push(b.chromStart, b.chromEnd, codonRgb(h.codon, stops));
      lines.push(row.join('\t'));
    }
    if (wrapped) lines.push('# ' + wrapped + ' origin-wrapping stop codon(s) omitted.');
    return lines.join('\n') + '\n';
  }

  // ---- FASTA (ORF nucleotides + translated proteins) -------------------

  function wrapSeq(s, width) {
    width = width || 60;
    var out = [];
    for (var i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
    return out.join('\n');
  }

  var rc = (global.CodonScanner && global.CodonScanner.reverseComplement)
    ? global.CodonScanner.reverseComplement
    : function (s) { return s; };

  // Assemble a feature's 5'->3' coding sequence by walking its segments in
  // biological order. `orderedSegments` is the ONLY structure that carries the
  // true 5'->3' order of an ORIGIN-wrapping join() on a circular replicon (e.g.
  // join(3981..5386,1..136), whose 3' end is 136, not max(coord)); sorting by
  // start would scramble it. This mirrors annotate.js getOrdered so the exports
  // agree with the classification path. Each segment contributes its forward
  // genomic slice on '+', or the reverse complement of that slice on '-', so the
  // pieces stay in biological order for both strands (RC-per-segment, not
  // RC-of-the-whole, which would re-reverse the exon order of a spliced gene).
  // Falls back to sorted-then-strand-reversed segments only when orderedSegments
  // is absent. Coordinates are 1-based inclusive.
  function featureCodingSeq(feat, rec) {
    var ordered = (feat.orderedSegments && feat.orderedSegments.length)
      ? feat.orderedSegments
      : (function () {
          var segs = (feat.segments || []).slice().sort(function (a, b) { return a.start - b.start; });
          if (feat.strand === '-') segs.reverse();
          return segs;
        })();
    var minus = (feat.strand === '-');
    var s = '';
    for (var i = 0; i < ordered.length; i++) {
      var a = Math.max(1, ordered[i].start), b = Math.min(rec.seq.length, ordered[i].end);
      if (b >= a) {
        var piece = rec.seq.slice(a - 1, b);
        s += minus ? rc(piece) : piece;
      }
    }
    return s;
  }

  function featureLabel(f) {
    return f.name || f.locusTag || f.id || (f.type + '_' + f.seqId + '_' + f.start);
  }

  function defline(f) {
    var parts = [featureLabel(f)];
    parts.push(f.seqId + ':' + f.start + '-' + f.end + '(' + f.strand + ')');
    if (f.type) parts.push('type=' + f.type);
    if (f.name) parts.push('gene=' + f.name);
    else if (f.locusTag) parts.push('locus_tag=' + f.locusTag);
    if (f.product) parts.push(f.product);
    return parts.join(' ');
  }

  function isExportable(f) { return f && (f.type === 'ORF' || f.type === 'CDS'); }

  function toFastaNucleotide(features, records, options) {
    options = options || {};
    var width = options.width || 60;
    var recById = {};
    (records || []).forEach(function (r) { recById[r.id] = r; });
    var out = [];
    (features || []).forEach(function (f) {
      if (!isExportable(f)) return;
      var rec = recById[f.seqId];
      if (!rec || !rec.seq) return;
      var seq = featureCodingSeq(f, rec);
      if (!seq) return;
      out.push('>' + defline(f) + '\n' + wrapSeq(seq, width));
    });
    return out.join('\n') + (out.length ? '\n' : '');
  }

  // Translate a 5'->3' coding string with the given NCBI table id, honoring a
  // leading phase (0/1/2, bases to skip before the first codon). One trailing
  // stop '*' is removed (it is the terminator, not part of the protein);
  // internal stops are kept as '*' because they are biologically informative.
  function translateSeq(seq, tableId, phase) {
    if (!global.CodonTables) return '';
    var t = global.CodonTables.get(tableId);
    var start = (phase === 1 || phase === 2) ? phase : 0;
    var aa = [];
    for (var i = start; i + 3 <= seq.length; i += 3) {
      aa.push(t.translate(seq.substr(i, 3)));
    }
    if (aa.length && aa[aa.length - 1] === '*') aa.pop();
    return aa.join('');
  }

  function toFastaProtein(features, records, options) {
    options = options || {};
    var width = options.width || 60;
    var defaultTable = options.tableId != null ? options.tableId
      : (global.CodonTables ? global.CodonTables.DEFAULT_ID : 11);
    var recById = {};
    (records || []).forEach(function (r) { recById[r.id] = r; });
    var out = [];
    (features || []).forEach(function (f) {
      if (!isExportable(f)) return;
      var rec = recById[f.seqId];
      if (!rec || !rec.seq) return;
      var seq = featureCodingSeq(f, rec);
      if (!seq) return;
      // Per-feature /transl_table wins over the global run table.
      var tid = (f.translTable != null) ? f.translTable : defaultTable;
      var prot = translateSeq(seq, tid, f.phase);
      if (!prot) return;
      out.push('>' + defline(f) + ' table=' + tid + '\n' + wrapSeq(prot, width));
    });
    return out.join('\n') + (out.length ? '\n' : '');
  }

  // ---- Publication figure export (SVG + PNG, no libraries) -------------
  // CSS custom properties used inside the app's inline SVGs. They are read from
  // the live document root and inlined onto the standalone <svg> so var() still
  // resolves once the SVG is detached / rasterized.
  var SVG_VARS = ['--codon-1', '--codon-2', '--codon-3', '--codon-4', '--codon-5', '--codon-6',
    '--text', '--text-muted', '--border', '--border-strong', '--bg-elevated', '--bg-subtle', '--accent', '--accent-strong'];

  function standaloneSVG(svgEl) {
    var clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    var cs = global.getComputedStyle(document.documentElement);
    var decls = '';
    for (var i = 0; i < SVG_VARS.length; i++) {
      var v = cs.getPropertyValue(SVG_VARS[i]).trim();
      if (v) decls += SVG_VARS[i] + ':' + v + ';';
    }
    var bg = (cs.getPropertyValue('--bg-elevated').trim()) || '#ffffff';
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    // Setting the custom properties on the root svg selector makes every
    // descendant's var(--codon-N) resolve in the standalone document.
    style.textContent = 'svg{background:' + bg + ';' + decls + '}';
    clone.insertBefore(style, clone.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new global.XMLSerializer().serializeToString(clone);
  }

  function svgSize(svgEl) {
    var w = 0, h = 0;
    try { w = svgEl.width.baseVal.value; h = svgEl.height.baseVal.value; } catch (e) {}
    if ((!w || !h) && svgEl.viewBox && svgEl.viewBox.baseVal) {
      w = w || svgEl.viewBox.baseVal.width;
      h = h || svgEl.viewBox.baseVal.height;
    }
    var box = svgEl.getBoundingClientRect ? svgEl.getBoundingClientRect() : null;
    if ((!w || !h) && box) { w = w || box.width; h = h || box.height; }
    return { w: w || 640, h: h || 360 };
  }

  function downloadSVG(svgEl, filename) {
    if (!svgEl) return;
    dl(filename, standaloneSVG(svgEl), 'image/svg+xml;charset=utf-8');
  }

  function downloadPNG(svgEl, filename, scale) {
    if (!svgEl) return;
    scale = scale || 2;
    var str = standaloneSVG(svgEl);
    var size = svgSize(svgEl);
    var blob = new Blob([str], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(size.w * scale));
      canvas.height = Math.max(1, Math.round(size.h * scale));
      var ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0, size.w, size.h);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (out) {
        if (!out) return;
        var u2 = URL.createObjectURL(out);
        var a = document.createElement('a');
        a.href = u2; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        global.setTimeout(function () { URL.revokeObjectURL(u2); }, 2000);
      }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  }

  global.CodonExport = {
    gffEnc: gffEnc,
    toGFF3: toGFF3,
    toBED: toBED,
    codonRgb: codonRgb,
    BED_PALETTE: BED_PALETTE,
    featureCodingSeq: featureCodingSeq,
    toFastaNucleotide: toFastaNucleotide,
    toFastaProtein: toFastaProtein,
    translateSeq: translateSeq,
    isExportable: isExportable,
    standaloneSVG: standaloneSVG,
    downloadSVG: downloadSVG,
    downloadPNG: downloadPNG
  };
})(typeof window !== 'undefined' ? window : this);
