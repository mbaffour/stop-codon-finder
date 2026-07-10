/*
 * gff.js -- Pure string parsing of GFF3 for Stop Codon Finder. NO network.
 *
 * Exposes a global `CodonGFF`:
 *   CodonGFF.parse(text) -> { records:[{id,seq}], features:[Feature], warnings:[] }
 *
 * - 9 tab-separated columns; blank lines and '#' comments ignored (except the
 *   ##FASTA directive, which switches to embedded-sequence mode).
 * - Spliced CDS = multiple rows sharing the same ID -> accumulated segments.
 * - Attributes URL-decoded; multi-values split on ','.
 * - A CDS inherits name/locusTag from its Parent gene when missing.
 */
(function (global) {
  'use strict';

  var KEEP_TYPES = {
    gene: 1, CDS: 1, mRNA: 1, tRNA: 1, rRNA: 1,
    transcript: 1, ncRNA: 1, tmRNA: 1
  };

  function urlDecode(s) {
    if (s.indexOf('%') === -1) return s;
    try {
      return decodeURIComponent(s);
    } catch (e) {
      // Manual fallback for stray percent signs.
      return s.replace(/%([0-9A-Fa-f]{2})/g, function (_, h) {
        return String.fromCharCode(parseInt(h, 16));
      });
    }
  }

  function parseAttributes(col9) {
    var attrs = {};
    if (!col9) return attrs;
    var parts = col9.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var eq = p.indexOf('=');
      if (eq === -1) continue;
      var key = urlDecode(p.slice(0, eq).trim());
      var valRaw = p.slice(eq + 1);
      var vals = valRaw.split(',').map(function (v) { return urlDecode(v.trim()); });
      attrs[key] = vals.length === 1 ? vals[0] : vals;
    }
    return attrs;
  }

  function first(v) { return Array.isArray(v) ? v[0] : v; }

  function parse(text) {
    var warnings = [];
    var records = [];
    var features = [];
    if (!text) return { records: records, features: features, warnings: warnings };

    var lines = text.split(/\r\n|\r|\n/);

    // Accumulator: feature rows keyed by a stable identity so spliced CDS rows
    // (sharing ID) merge into one feature.
    var byKey = {};       // key -> feature
    var order = [];       // preserve insertion order
    var idIndex = {};     // ID -> feature (for parent inheritance)
    var strandWarned = false;
    var fastaText = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (fastaText !== null) { fastaText += line + '\n'; continue; }

      if (line === '') continue;
      if (line.charAt(0) === '#') {
        if (/^##FASTA/i.test(line)) { fastaText = ''; }
        continue;
      }

      var cols = line.split('\t');
      if (cols.length < 8) continue; // not a feature line

      var seqId = cols[0];
      var type = cols[2];
      var startNum = parseInt(cols[3], 10);
      var endNum = parseInt(cols[4], 10);
      var strand = cols[6];
      // Column 8 (0-based index 7) is the CDS phase: 0/1/2 = number of bases to
      // remove from the 5' end of THIS segment to reach the first base of the
      // next codon. Crucial for 5'-partial CDS (truncated at a contig edge):
      // without it the reading frame inside the feature is wrong.
      var phaseTok = cols[7];
      var segPhase = /^[012]$/.test(phaseTok) ? parseInt(phaseTok, 10) : null;
      var attrCol = cols[8] || '';

      if (!KEEP_TYPES[type]) continue;
      if (isNaN(startNum) || isNaN(endNum)) {
        warnings.push('Skipped ' + type + ' row with bad coordinates in ' + seqId);
        continue;
      }
      if (strand !== '+' && strand !== '-') {
        if (!strandWarned) {
          warnings.push('One or more features had an undefined strand (' + strand + '); treated as forward (+).');
          strandWarned = true;
        }
        strand = '+';
      }

      var attrs = parseAttributes(attrCol);
      var id = first(attrs.ID) || null;
      var parent = first(attrs.Parent) || null;

      // Identity for merging: spliced CDS share ID+type+strand.
      var key;
      if (id) key = id + '||' + type + '||' + strand;
      else key = seqId + '||' + type + '||' + strand + '||' + startNum + '||' + endNum;

      var lo = Math.min(startNum, endNum);
      var hi = Math.max(startNum, endNum);

      if (byKey[key]) {
        var f = byKey[key];
        f.segments.push({ start: lo, end: hi, phase: segPhase });
        if (lo < f.start) f.start = lo;
        if (hi > f.end) f.end = hi;
      } else {
        var feat = {
          seqId: seqId,
          type: type,
          strand: strand,
          segments: [{ start: lo, end: hi, phase: segPhase }],
          orderedSegments: [{ start: lo, end: hi, phase: segPhase }],
          start: lo,
          end: hi,
          phase: null, // resolved in finalize from the 5'-most segment
          // Prefer the gene symbol (attrs.gene, e.g. "thrL") for display; on
          // NCBI RefSeq GFF a CDS row's Name= is the protein accession
          // (e.g. NP_414542.1), which is kept separately as proteinId.
          name: first(attrs.gene) || first(attrs.Name) || null,
          locusTag: first(attrs.locus_tag) || null,
          product: first(attrs.product) || null,
          proteinId: first(attrs.protein_id) || null,
          translTable: attrs.transl_table !== undefined ? parseInt(first(attrs.transl_table), 10) : null,
          id: id,
          parent: parent,
          partial5: false,
          partial3: false
        };
        byKey[key] = feat;
        order.push(feat);
        if (id) idIndex[id] = feat;
      }
    }

    // Finalize: sort each feature's segments; inherit name/locusTag from parent.
    for (var o = 0; o < order.length; o++) {
      var ft = order[o];
      ft.segments.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      // Biological 5'->3' order: ascending for '+', descending for '-'. (GFF3
      // has no join() syntax, so origin-wrapping is not represented here.)
      ft.orderedSegments = ft.strand === '-'
        ? ft.segments.slice().reverse()
        : ft.segments.slice();
      // Feature-level phase = phase of the biological 5'-most segment (the only
      // one whose phase shifts the whole reading frame). Non-CDS rows stay null.
      if (ft.type === 'CDS' && ft.orderedSegments.length) {
        var p5 = ft.orderedSegments[0].phase;
        ft.phase = (p5 === 0 || p5 === 1 || p5 === 2) ? p5 : null;
        // A leading non-zero phase means the CDS is 5'-partial.
        if (ft.phase) ft.partial5 = true;
      }
      if ((!ft.name || !ft.locusTag) && ft.parent && idIndex[ft.parent]) {
        var pg = idIndex[ft.parent];
        if (!ft.name && pg.name) ft.name = pg.name;
        if (!ft.locusTag && pg.locusTag) ft.locusTag = pg.locusTag;
        if (!ft.product && pg.product) ft.product = pg.product;
      }
      features.push(ft);
    }

    // Embedded ##FASTA -> records.
    if (fastaText !== null && global.CodonParser) {
      var recs = global.CodonParser.parseFastaBlock(fastaText)
        .filter(function (r) { return r.seq && r.seq.length > 0; })
        .map(function (r) { return { id: r.id, seq: r.seq }; });
      records = recs;
    }

    return { records: records, features: features, warnings: warnings };
  }

  global.CodonGFF = {
    parse: parse
  };
})(typeof window !== 'undefined' ? window : this);
