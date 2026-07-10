/*
 * genbank.js -- Pure string parsing of GenBank flat files for Stop Codon
 * Finder. NO network access; only string processing.
 *
 * Exposes a global `CodonGenBank`:
 *   CodonGenBank.looksLikeGenBank(text) -> bool
 *   CodonGenBank.parse(text) -> { records:[{id,seq}], features:[Feature], warnings:[] }
 *   CodonGenBank.parseLocation(str) -> {segments,strand,partial5,partial3} | null
 *
 * Feature model (shared, see build brief 3.1): ascending forward-strand
 * coordinates; direction lives only in `strand`.
 */
(function (global) {
  'use strict';

  var KEEP_TYPES = { gene: 1, CDS: 1, mRNA: 1, tRNA: 1, rRNA: 1 };

  function looksLikeGenBank(text) {
    if (!text) return false;
    var head = text.slice(0, 4000);
    if (/^LOCUS\s+/m.test(head) && /^\s*LOCUS/.test(head.split(/\r\n|\r|\n/)[0] || '')) return true;
    // Fallback: a LOCUS line near the top plus an ORIGIN + // terminator.
    if (/^LOCUS\s/m.test(head) && /\nORIGIN/.test(text) && /\n\/\//.test(text)) return true;
    return false;
  }

  // ---- Location grammar (recursive descent) -----------------------------
  // Supports: complement(...), join(...), order(...)->join, int..int, bare int,
  // int^int (start=end=int... actually int^int is between: we set start=end=left),
  // <int / int> fuzzy partials, and cross-accession refs ACC:loc.
  //
  // Returns { segments:[{start,end}], partial5:bool, partial3:bool,
  //           crossRefs:[accession...] } in the location's own orientation
  // (NOT yet strand-flipped). `complement` toggling is handled by the caller
  // capturing strand; segments always ascending.

  function parseLocation(locStr, recordAccession) {
    var warnings = [];
    var s = (locStr || '').replace(/\s+/g, '');
    if (!s) return null;

    var pos = 0;
    var strandComplement = false;
    var partial5 = false;
    var partial3 = false;
    var segments = [];
    var failed = false;

    function peek() { return s.charAt(pos); }
    function starts(tok) { return s.substr(pos, tok.length) === tok; }

    // Parse a single span like "12..350", "<12..>350", "23^24", "45", possibly
    // with an accession prefix "J00001.1:12..50".
    function parseSpan() {
      // optional accession prefix: letters/digits/._ then ':'
      var m = /^([A-Za-z0-9_.]+):/.exec(s.slice(pos));
      var crossAcc = null;
      if (m) {
        crossAcc = m[1];
        pos += m[0].length;
      }
      var startFuzzy = false, endFuzzy = false;
      if (peek() === '<') { startFuzzy = true; pos++; }
      if (peek() === '>') { startFuzzy = true; pos++; } // ">n" as a start bound
      var numMatch = /^(\d+)/.exec(s.slice(pos));
      if (!numMatch) { failed = true; return null; }
      var startNum = parseInt(numMatch[1], 10);
      pos += numMatch[1].length;

      var endNum = startNum;
      var isRange = false;
      if (starts('..')) {
        isRange = true;
        pos += 2;
        if (peek() === '<') { endFuzzy = true; pos++; }
        if (peek() === '>') { endFuzzy = true; pos++; }
        var em = /^(\d+)/.exec(s.slice(pos));
        if (!em) { failed = true; return null; }
        endNum = parseInt(em[1], 10);
        pos += em[1].length;
      } else if (peek() === '^') {
        // int^int : a site between two bases. Treat as a zero-ish span at left.
        pos++;
        var cm = /^(\d+)/.exec(s.slice(pos));
        if (cm) { pos += cm[1].length; }
        endNum = startNum;
      }

      if (crossAcc && recordAccession && !accMatches(crossAcc, recordAccession)) {
        warnings.push('Dropped cross-accession segment ' + crossAcc + ':' + startNum +
          (isRange ? '..' + endNum : ''));
        return { cross: true };
      }

      var seg = { start: Math.min(startNum, endNum), end: Math.max(startNum, endNum) };
      // fuzzy flags recorded relative to the span; caller maps to 5'/3' by strand.
      if (startFuzzy) seg._loFuzzy = true;
      if (endFuzzy) seg._hiFuzzy = true;
      return seg;
    }

    function parseElement() {
      if (starts('complement(')) {
        pos += 'complement('.length;
        var before = strandComplement;
        strandComplement = !strandComplement;
        parseList(')');
        strandComplement = before;
        expect(')');
        return;
      }
      if (starts('join(') || starts('order(')) {
        pos += (starts('join(') ? 'join(' : 'order(').length;
        parseList(')');
        expect(')');
        return;
      }
      // plain span
      var seg = parseSpan();
      if (failed) return;
      if (seg && !seg.cross) {
        seg._complement = strandComplement;
        segments.push(seg);
      }
    }

    function parseList(closer) {
      /* parse comma-separated elements until closer or end */
      while (pos < s.length && peek() !== closer) {
        parseElement();
        if (failed) return;
        if (peek() === ',') { pos++; continue; }
        else break;
      }
    }

    function expect(ch) {
      if (peek() === ch) { pos++; return true; }
      return false;
    }

    parseElement();
    if (failed || segments.length === 0) {
      return null;
    }

    // Determine overall strand: GenBank complement wraps everything; if every
    // segment is complemented -> '-', else '+'. (Mixed-strand joins are rare;
    // we treat the whole feature by majority/any complement flag.)
    var anyComp = false, allComp = true;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i]._complement) anyComp = true; else allComp = false;
    }
    var strand = allComp ? '-' : '+';
    var mixedStrand = anyComp && !allComp;
    if (mixedStrand) {
      warnings.push('Mixed-strand join treated as forward (+): "' + locStr + '"; a complemented segment ' +
        'may be reported on the wrong strand.');
    }

    // Map fuzzy lo/hi bounds to 5'/3' based on strand.
    // For '+': lowest-start seg lo-fuzzy -> partial5; highest-end seg hi-fuzzy -> partial3.
    // For '-': it's reversed.
    for (var k = 0; k < segments.length; k++) {
      var sg = segments[k];
      if (sg._loFuzzy) { if (strand === '+') partial5 = true; else partial3 = true; }
      if (sg._hiFuzzy) { if (strand === '+') partial3 = true; else partial5 = true; }
    }

    // Biological 5'->3' segment order. GenBank lists join() segments in
    // 5'->3' order of the assembled plus-strand sequence; complement() then
    // reverses the whole thing. So the biological order is the file order for
    // '+', and the reverse of the file order for '-'. This is what preserves
    // the true termini of ORIGIN-wrapping (circular) features such as
    // join(3981..5386,1..136), whose 3' end is 136, not max(coord)=5386.
    var fileOrder = segments.map(function (sg) { return { start: sg.start, end: sg.end }; });
    var ordered = (strand === '-') ? fileOrder.slice().reverse() : fileOrder;

    // Sort ascending by start (used by the interval index) and strip flags.
    segments.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var clean = segments.map(function (sg) { return { start: sg.start, end: sg.end }; });

    return {
      segments: clean,
      orderedSegments: ordered,
      strand: strand,
      partial5: partial5,
      partial3: partial3,
      warnings: warnings
    };
  }

  function accMatches(a, b) {
    // Compare accessions ignoring version suffix (.1) and case.
    function norm(x) { return String(x).replace(/\.\d+$/, '').toUpperCase(); }
    return norm(a) === norm(b);
  }

  // ---- Qualifier / feature-table parsing --------------------------------

  var QUAL_MAP = {
    gene: 'name',
    locus_tag: 'locusTag',
    product: 'product',
    protein_id: 'proteinId',
    transl_table: 'translTable'
  };

  // Parse a /transl_except qualifier value, e.g.
  //   (pos:1002..1004,aa:Sec)  |  (pos:complement(5..7),aa:Pyl)  |  (pos:88,aa:Met)
  // into { start, end, aa } in forward 1-based coordinates. These mark genuine
  // recodings (selenocysteine TGA->Sec, pyrrolysine TAG->Pyl, and formylation of
  // the initiator) so an in-frame stop at such a position is NOT a premature stop.
  function parseTranslExcept(val) {
    if (!val) return null;
    var pm = /pos:\s*(?:complement\()?\s*<?(\d+)(?:\.\.>?(\d+))?/i.exec(val);
    if (!pm) return null;
    var start = parseInt(pm[1], 10);
    var end = pm[2] !== undefined ? parseInt(pm[2], 10) : start;
    var am = /aa:\s*([A-Za-z]+)/.exec(val);
    return { start: Math.min(start, end), end: Math.max(start, end), aa: am ? am[1] : null };
  }

  function stripQuotes(v) {
    if (v === undefined || v === null) return null;
    var t = v;
    if (t.charAt(0) === '"') t = t.slice(1);
    if (t.charAt(t.length - 1) === '"') t = t.slice(0, -1);
    t = t.replace(/""/g, '"');
    return t;
  }

  // Parse one record's FEATURES block text into Feature objects.
  function parseFeatures(featText, seqId, recordAccession, warnings) {
    var features = [];
    var lines = featText.split(/\r\n|\r|\n/);
    var i = 0;
    // Regexes per brief:
    var newFeatRe = /^ {5}(\S+)\s+(.+)$/;         // 5 spaces, key, location start
    var qualRe = /^\s{21}\/(\w+)(?:=([\s\S]*))?$/; // 21-space indented qualifier

    while (i < lines.length) {
      var line = lines[i];
      var fm = newFeatRe.exec(line);
      if (!fm) { i++; continue; }

      var type = fm[1];
      var locBuf = fm[2].trim();
      i++;

      // Continuation of a location can wrap onto following 21-indent lines that
      // are NOT qualifiers (no leading slash). Accumulate until we hit a
      // qualifier line or the next feature.
      while (i < lines.length) {
        var ln = lines[i];
        if (newFeatRe.test(ln)) break;
        if (/^\s{21}\//.test(ln)) break;
        if (/^\S/.test(ln)) break; // new top-level section
        var cont = ln.trim();
        if (cont === '') { i++; continue; }
        locBuf += cont;
        i++;
      }

      // Collect qualifiers.
      var quals = {};
      while (i < lines.length) {
        var qline = lines[i];
        if (newFeatRe.test(qline)) break;
        if (/^\S/.test(qline)) break; // left FEATURES section
        var qm = qualRe.exec(qline);
        if (!qm) { i++; continue; }
        var qname = qm[1];
        var qval = qm[2] === undefined ? '' : qm[2];
        i++;
        // Multiline qualifier value: subsequent 21-indent lines without a slash.
        while (i < lines.length) {
          var nx = lines[i];
          if (newFeatRe.test(nx)) break;
          if (/^\s{21}\//.test(nx)) break;
          if (/^\S/.test(nx)) break;
          var nxt = nx.replace(/^\s{21}/, '');
          if (nxt === '' && qval === '') { i++; continue; }
          // Join: sequence-like values (translation) concatenate; textual values
          // join with a space. Heuristic: if current value ends without space and
          // continuation has no leading space, and it's a translation, concat.
          if (qname === 'translation') qval += nxt.trim();
          else qval += (qval && !/\s$/.test(qval) ? ' ' : '') + nxt.trim();
          i++;
        }
        // /transl_except can appear multiple times (one per recoded residue);
        // accumulate all occurrences rather than keeping only the first.
        if (qname === 'transl_except') {
          if (!quals.transl_except) quals.transl_except = [];
          quals.transl_except.push(stripQuotes(qval));
        } else if (!(qname in quals)) {
          quals[qname] = stripQuotes(qval);
        }
      }

      if (!KEEP_TYPES[type]) continue;

      var loc = parseLocation(locBuf, recordAccession);
      if (!loc) {
        warnings.push('Skipped ' + type + ' with unparseable location "' + locBuf + '" in ' + seqId);
        continue;
      }
      if (loc.warnings && loc.warnings.length) {
        for (var w = 0; w < loc.warnings.length; w++) warnings.push(loc.warnings[w] + ' (' + seqId + ')');
      }

      var feat = {
        seqId: seqId,
        type: type,
        strand: loc.strand,
        segments: loc.segments,
        orderedSegments: loc.orderedSegments || loc.segments,
        start: loc.segments[0].start,
        end: loc.segments[loc.segments.length - 1].end,
        name: quals.gene !== undefined ? quals.gene : null,
        locusTag: quals.locus_tag !== undefined ? quals.locus_tag : null,
        product: quals.product !== undefined ? quals.product : null,
        proteinId: quals.protein_id !== undefined ? quals.protein_id : null,
        translTable: quals.transl_table !== undefined ? parseInt(quals.transl_table, 10) : null,
        // /codon_start (1/2/3) -> phase (0/1/2): bases to skip at the 5' end to
        // reach the first codon. Only meaningful for CDS; the analog of GFF3
        // column-8 phase, used to classify 5'-partial CDS in-frame.
        phase: (type === 'CDS' && quals.codon_start !== undefined &&
                /^[123]$/.test(String(quals.codon_start).trim()))
                 ? (parseInt(quals.codon_start, 10) - 1) : null,
        // Parsed /transl_except records (Sec/Pyl/other genuine recodings).
        translExcept: (function () {
          if (!quals.transl_except) return null;
          var raw = Array.isArray(quals.transl_except) ? quals.transl_except : [quals.transl_except];
          var out = [];
          for (var te = 0; te < raw.length; te++) {
            var p = parseTranslExcept(raw[te]);
            if (p) out.push(p);
          }
          return out.length ? out : null;
        })(),
        id: null,
        parent: null,
        partial5: loc.partial5,
        partial3: loc.partial3
      };
      // Recompute overall end as max across segments (join could be unsorted).
      var maxEnd = feat.segments[0].end, minStart = feat.segments[0].start;
      for (var sgi = 1; sgi < feat.segments.length; sgi++) {
        if (feat.segments[sgi].end > maxEnd) maxEnd = feat.segments[sgi].end;
        if (feat.segments[sgi].start < minStart) minStart = feat.segments[sgi].start;
      }
      feat.start = minStart; feat.end = maxEnd;
      feat.id = feat.proteinId || feat.locusTag || null;
      features.push(feat);
    }

    return features;
  }

  // ---- Whole-file parse -------------------------------------------------

  function parse(text) {
    var warnings = [];
    var records = [];
    var features = [];
    if (!text) return { records: records, features: features, warnings: warnings };

    // Split into records on a line that is exactly '//' at column 0.
    var chunks = [];
    var lines = text.split(/\r\n|\r|\n/);
    var buf = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\/\/\s*$/.test(lines[i])) {
        if (buf.length) chunks.push(buf.join('\n'));
        buf = [];
      } else {
        buf.push(lines[i]);
      }
    }
    if (buf.length && /\S/.test(buf.join(''))) chunks.push(buf.join('\n'));

    for (var c = 0; c < chunks.length; c++) {
      parseRecord(chunks[c], records, features, warnings);
    }

    return { records: records, features: features, warnings: warnings };
  }

  function parseRecord(chunk, records, features, warnings) {
    var lines = chunk.split(/\r\n|\r|\n/);
    var locusName = null, accession = null, version = null, circular = false;

    // Identify id fields.
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var lm = /^LOCUS\s+(\S+)/.exec(ln);
      if (lm && locusName === null) {
        locusName = lm[1];
        // Topology token on the LOCUS line: 'circular' or 'linear'.
        if (/\bcircular\b/i.test(ln)) circular = true;
      }
      var am = /^ACCESSION\s+(\S+)/.exec(ln);
      if (am && accession === null) accession = am[1];
      var vm = /^VERSION\s+(\S+)/.exec(ln);
      if (vm && version === null) version = vm[1];
    }
    var recordAccession = version || accession || locusName;
    var seqId = version || accession || locusName;
    if (!seqId) return; // not a real record

    // Locate FEATURES and ORIGIN sections.
    var featStart = -1, featEnd = -1, originStart = -1;
    for (var j = 0; j < lines.length; j++) {
      var t = lines[j];
      if (featStart === -1 && /^FEATURES\s/.test(t)) { featStart = j + 1; continue; }
      if (featStart !== -1 && featEnd === -1 &&
          (/^ORIGIN/.test(t) || /^BASE COUNT/.test(t) || /^CONTIG/.test(t))) {
        featEnd = j;
      }
      if (originStart === -1 && /^ORIGIN/.test(t.replace(/\s+$/, ''))) originStart = j + 1;
    }

    // Parse FEATURES.
    if (featStart !== -1) {
      var fEnd = featEnd === -1 ? lines.length : featEnd;
      var featText = lines.slice(featStart, fEnd).join('\n');
      var recFeats = parseFeatures(featText, seqId, recordAccession, warnings);
      for (var f = 0; f < recFeats.length; f++) features.push(recFeats[f]);
    }

    // Parse ORIGIN sequence.
    var seq = '';
    if (originStart !== -1) {
      var seqLines = [];
      for (var k = originStart; k < lines.length; k++) {
        var sl = lines[k];
        if (/^\/\//.test(sl)) break;
        if (/^(ORIGIN|CONTIG|BASE COUNT)/.test(sl)) break;
        // strip leading digits + whitespace
        seqLines.push(sl.replace(/[\d\s]/g, ''));
      }
      var raw = seqLines.join('');
      seq = global.CodonParser ? global.CodonParser.normalizeSequence(raw) : raw.toUpperCase().replace(/U/g, 'T').replace(/[^A-Z]/g, '');
    }

    records.push({ id: seqId, seq: seq, circular: circular });
  }

  global.CodonGenBank = {
    looksLikeGenBank: looksLikeGenBank,
    parse: parse,
    parseLocation: parseLocation,
    parseTranslExcept: parseTranslExcept
  };
})(typeof window !== 'undefined' ? window : this);
