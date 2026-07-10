/*
 * orf.js -- Lightweight ORF prediction as a POST-PASS over scanner hits.
 * NO re-scan; NO network. Uses the stop-codon hits already found (which are,
 * per frame, exactly the in-frame stops) plus a start-codon lookup in the
 * reading strand.
 *
 * Exposes a global `CodonORF`:
 *   CodonORF.predict(records, hits, options) -> { features:[Feature(type:'ORF')] }
 *
 * options: { tableId, minLenNt:90, startCodons, requireStart:true, includeAltStarts:false }
 *
 * Start-codon policy (matches NCBI ORFfinder / EMBOSS getorf defaults):
 *   - Default is ATG-only. Set includeAltStarts:true to also allow the table's
 *     alternative initiation codons (GTG/TTG/...). An explicit startCodons array
 *     overrides both.
 * Reading-frame policy:
 *   - requireStart:true (default) = start-to-stop ORFs (an initiator is needed).
 *   - requireStart:false          = stop-to-stop ORFs (maximal open stretch).
 *
 * Coordinates in emitted features are forward-strand ascending (1-based
 * inclusive), matching the scanner's convention. The 3' terminating stop of
 * each ORF is exactly the scanner hit that closed it.
 */
(function (global) {
  'use strict';

  function predict(records, hits, options) {
    options = options || {};
    var minLenNt = options.minLenNt || 90;
    var requireStart = options.requireStart !== false; // default true
    var tableId = options.tableId || (global.CodonTables ? global.CodonTables.DEFAULT_ID : 11);

    var startCodons = options.startCodons;
    if (!startCodons || !startCodons.length) {
      // Default: ATG-only (ORFfinder / EMBOSS default). Opt in to the table's
      // alternative initiation codons only when includeAltStarts is set.
      if (global.CodonTables && options.includeAltStarts) {
        startCodons = global.CodonTables.get(tableId).allStarts;
      } else {
        startCodons = ['ATG'];
      }
    }
    var startSet = {};
    for (var si = 0; si < startCodons.length; si++) startSet[startCodons[si]] = 1;

    var rc = (global.CodonScanner && global.CodonScanner.reverseComplement)
      ? global.CodonScanner.reverseComplement
      : function (s) { return s; };

    // Index records by id for length + sequence access.
    var recById = {};
    (records || []).forEach(function (r) { recById[r.id] = r; });

    // Group hits by seqId | strand | frame.
    var groups = {};
    (hits || []).forEach(function (h) {
      var k = h.seqId + '|' + h.strand + '|' + h.frame;
      (groups[k] || (groups[k] = [])).push(h);
    });

    var features = [];
    var counter = 0;

    for (var key in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, key)) continue;
      var parts = key.split('|');
      var seqId = parts[0];
      var strand = parts[1];
      var frame = parseInt(parts[2], 10);
      var rec = recById[seqId];
      if (!rec || !rec.seq) continue;

      var L = rec.seq.length;
      var str = (strand === '+') ? rec.seq : rc(rec.seq);
      var frameOffset = frame - 1; // 0-based reading position of frame start

      var groupHits = groups[key];

      // Reading-strand 0-based start position of each stop hit.
      groupHits.forEach(function (h) {
        h._rpos = (strand === '+') ? (h.start - 1) : (L - h.end);
      });
      groupHits.sort(function (a, b) { return a._rpos - b._rpos; });

      var prevStopEnd = frameOffset; // reading position after previous stop (inclusive scan start)
      for (var gi = 0; gi < groupHits.length; gi++) {
        var stopHit = groupHits[gi];
        var stopPos = stopHit._rpos;              // 0-based start of stop codon in reading strand
        var regionStart = prevStopEnd;            // first candidate codon position
        var orfStartPos = -1;

        if (requireStart) {
          for (var p = regionStart; p + 3 <= stopPos; p += 3) {
            var codon = str.charAt(p) + str.charAt(p + 1) + str.charAt(p + 2);
            if (startSet[codon]) { orfStartPos = p; break; }
          }
        } else {
          // Open reading stretch: begin right after the previous stop.
          orfStartPos = regionStart;
        }

        if (orfStartPos !== -1) {
          var lengthNt = (stopPos + 3) - orfStartPos; // includes the stop codon
          if (lengthNt >= minLenNt) {
            var seg;
            if (strand === '+') {
              seg = { start: orfStartPos + 1, end: stopHit.end };
            } else {
              seg = { start: stopHit.start, end: L - orfStartPos };
            }
            counter++;
            features.push({
              seqId: seqId,
              type: 'ORF',
              strand: strand,
              segments: [seg],
              start: seg.start,
              end: seg.end,
              name: null,
              locusTag: null,
              product: 'predicted ORF (frame ' + (strand === '+' ? '+' : '-') + frame + ')',
              proteinId: null,
              translTable: tableId,
              id: 'ORF_' + seqId + '_' + strand + frame + '_' + counter,
              parent: null,
              partial5: false,
              partial3: false,
              lengthNt: lengthNt
            });
          }
        }

        prevStopEnd = stopPos + 3; // next ORF search begins after this stop codon
      }
    }

    return { features: features };
  }

  global.CodonORF = {
    predict: predict
  };
})(typeof window !== 'undefined' ? window : this);
