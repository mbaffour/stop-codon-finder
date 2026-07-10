/*
 * parser.js -- FASTA / GFF3 parsing for Stop Codon Finder.
 *
 * Exposes a single global `CodonParser` object (no ES modules, so this file
 * works when the page is opened directly via file:// as well as when it is
 * served over http(s), e.g. from GitHub Pages).
 *
 * Public API:
 *   CodonParser.normalizeSequence(rawText) -> string
 *   CodonParser.detectFileType(text) -> 'fasta' | 'gff-with-fasta' | 'gff-no-fasta' | 'unknown' | 'empty'
 *   CodonParser.parseFastaBlock(text) -> [{ id, description, seq }, ...]
 *   CodonParser.parseInput(text) -> { records, error, warning, sourceType }
 */
(function (global) {
  'use strict';

  /**
   * Normalize a raw block of sequence text into a clean, uppercase DNA string.
   *  - Uppercases everything.
   *  - Converts RNA 'U' to 'T'.
   *  - Strips whitespace, digits, and newlines (and any other stray
   *    non-letter symbols, e.g. alignment gaps '-' or stray '*'/'.'), since
   *    only letters can meaningfully represent nucleotide/ambiguity codes.
   *  - Non-ACGT letters (N, R, Y, ambiguity codes, ...) are left in place;
   *    the scanner simply will never match them against TAA/TAG/TGA.
   */
  function normalizeSequence(raw) {
    if (!raw) return '';
    var s = raw.toUpperCase();
    s = s.replace(/U/g, 'T');
    s = s.replace(/[^A-Z]/g, ''); // drop whitespace, digits, punctuation/gaps
    return s;
  }

  // Valid single-letter nucleotide + IUPAC ambiguity codes (post-uppercasing).
  var VALID_BASE = /[ACGTURYSWKMBDHVN]/;

  /**
   * Like normalizeSequence but also reports what was normalized/stripped, so the
   * caller can warn (a soft-masked or RNA or gapped input otherwise silently
   * scans as if nothing were wrong). Returns { seq, stats }.
   */
  function normalizeSequenceEx(raw) {
    if (!raw) return { seq: '', stats: { lowercase: 0, uConverted: 0, gaps: 0, unexpected: 0, ambiguous: 0 } };
    var lowercase = 0, uConverted = 0, gaps = 0, unexpected = 0, ambiguous = 0;
    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (ch >= 'a' && ch <= 'z') lowercase++;
      var up = ch.toUpperCase();
      if (up === 'U') uConverted++;
      if (ch === '-' || ch === '.' || ch === '*' || ch === '~') gaps++;
      else if (/[A-Za-z]/.test(ch)) {
        if (!VALID_BASE.test(up)) unexpected++;
        else if (up !== 'A' && up !== 'C' && up !== 'G' && up !== 'T' && up !== 'U') ambiguous++;
      }
    }
    return {
      seq: normalizeSequence(raw),
      stats: { lowercase: lowercase, uConverted: uConverted, gaps: gaps, unexpected: unexpected, ambiguous: ambiguous }
    };
  }

  // Merge per-record stats into a single friendly warning string (or null).
  function warnFromStats(agg) {
    if (!agg) return null;
    var notes = [];
    if (agg.uConverted > 0) notes.push('RNA input detected — ' + agg.uConverted + ' U base(s) were read as T');
    if (agg.lowercase > 0) notes.push(agg.lowercase + ' lowercase (soft-masked) base(s) were scanned as uppercase');
    if (agg.gaps > 0) notes.push(agg.gaps + ' alignment gap/pad character(s) were removed');
    if (agg.unexpected > 0) notes.push(agg.unexpected + ' unexpected non-nucleotide letter(s) were ignored');
    if (!notes.length) return null;
    return 'Sequence normalized: ' + notes.join('; ') + '.';
  }

  /**
   * Best-effort content sniffing so we don't rely on file extensions alone.
   */
  function detectFileType(text) {
    if (!text || !text.trim()) return 'empty';

    var sample = text.slice(0, 20000);
    var hasFastaHeader = /(^|\n)\s*>/.test(sample);
    var hasFastaMarker = /##FASTA/i.test(text);
    var hasGffVersion = /##gff-version/i.test(sample);
    // Loose heuristic for a GFF3/GTF feature line: col1 <TAB> col2 <TAB> col3 <TAB> digits <TAB> digits <TAB>
    var looksLikeGffBody = /(^|\n)[^\n#>][^\n]*\t[^\n]*\t[^\n]*\t\d+\t\d+\t/.test(sample);
    // GenBank flat file: a LOCUS line at/near the top, or an ORIGIN + // pair.
    var looksLikeGenBank = /^LOCUS\s/m.test(sample) || (/\nORIGIN/.test(text) && /\n\/\//.test(text));

    if (looksLikeGenBank && !hasFastaMarker && !hasGffVersion) return 'genbank';
    if (hasFastaMarker) return 'gff-with-fasta';
    if (hasGffVersion || looksLikeGffBody) return 'gff-no-fasta';
    if (hasFastaHeader) return 'fasta';
    return 'unknown';
  }

  /**
   * Parse a block of text as FASTA records. Lines starting with '>' begin a
   * new record; the id is the header text up to the first whitespace
   * character, and `description` retains the full header line.
   */
  function parseFastaBlock(text) {
    var records = [];
    var lines = text.split(/\r\n|\r|\n/);
    var current = null;

    function finalize(rec) {
      var ex = normalizeSequenceEx(rec.rawSeq.join(''));
      return {
        id: rec.id,
        description: rec.description,
        seq: ex.seq,
        _stats: ex.stats
      };
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.length === 0) continue;

      if (line.charAt(0) === '>') {
        if (current) records.push(finalize(current));
        var header = line.slice(1).trim();
        var firstSpace = header.search(/\s/);
        var id = firstSpace === -1 ? header : header.slice(0, firstSpace);
        current = {
          id: id || ('sequence_' + (records.length + 1)),
          description: header,
          rawSeq: []
        };
      } else if (current) {
        current.rawSeq.push(line);
      }
      // Stray sequence-looking lines encountered before any '>' header are
      // ignored here; parseInput() has an "unknown format" fallback that
      // handles a completely headerless raw-sequence file.
    }

    if (current) records.push(finalize(current));
    return records;
  }

  /**
   * Top-level entry point used by the app. Detects the file type, extracts
   * an embedded ##FASTA section from GFF3 when present, and produces a
   * friendly error/warning message for the cases the app cannot scan.
   */
  function aggregateStatsWarning(recs) {
    var agg = { lowercase: 0, uConverted: 0, gaps: 0, unexpected: 0, ambiguous: 0 };
    for (var i = 0; i < recs.length; i++) {
      var st = recs[i]._stats;
      if (!st) continue;
      agg.lowercase += st.lowercase; agg.uConverted += st.uConverted;
      agg.gaps += st.gaps; agg.unexpected += st.unexpected; agg.ambiguous += st.ambiguous;
    }
    return warnFromStats(agg);
  }

  function parseInput(text) {
    var result = { records: [], error: null, warning: null, sourceType: null };

    var type = detectFileType(text);
    result.sourceType = type;

    if (type === 'empty') {
      result.error = 'The file is empty. Please provide a FASTA file with at least one sequence.';
      return result;
    }

    if (type === 'gff-with-fasta') {
      var markerIdx = text.search(/##FASTA/i);
      var newlineAfterMarker = text.indexOf('\n', markerIdx);
      var fastaPart = newlineAfterMarker === -1 ? '' : text.slice(newlineAfterMarker + 1);
      var records = parseFastaBlock(fastaPart).filter(function (r) { return r.seq.length > 0; });
      if (records.length === 0) {
        result.error = 'A "##FASTA" section was found but it contained no usable sequence data.';
        return result;
      }
      result.records = records;
      result.warning = aggregateStatsWarning(records);
      return result;
    }

    if (type === 'gff-no-fasta') {
      result.error = 'This annotation file contains no sequence. Please provide a FASTA file (or a GFF3 with an embedded ##FASTA section) so codons can be scanned.';
      return result;
    }

    if (type === 'fasta') {
      var recs = parseFastaBlock(text).filter(function (r) { return r.seq.length > 0; });
      if (recs.length === 0) {
        result.error = 'No usable sequence data was found in this file.';
        return result;
      }
      result.records = recs;
      result.warning = aggregateStatsWarning(recs);
      return result;
    }

    // Unknown format: last-ditch attempt to treat the whole file as one raw,
    // headerless sequence rather than failing outright.
    var wrapped = text.indexOf('>') === -1 ? ('>sequence_1\n' + text) : text;
    var fallback = parseFastaBlock(wrapped).filter(function (r) { return r.seq.length > 0; });
    if (fallback.length > 0) {
      result.records = fallback;
      var extra = aggregateStatsWarning(fallback);
      result.warning = 'This file did not look like standard FASTA (no ">" header was found), so it was treated as a single raw sequence.' +
        (extra ? ' ' + extra : '');
      return result;
    }

    result.error = 'Could not recognize this file as FASTA or GFF3. Please provide a FASTA file (.fasta, .fa, .fna, .ffn) or a GFF3 file with an embedded ##FASTA section.';
    return result;
  }

  global.CodonParser = {
    normalizeSequence: normalizeSequence,
    normalizeSequenceEx: normalizeSequenceEx,
    detectFileType: detectFileType,
    parseFastaBlock: parseFastaBlock,
    parseInput: parseInput
  };
})(typeof window !== 'undefined' ? window : this);
