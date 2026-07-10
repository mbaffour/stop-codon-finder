/*
 * input.js -- Content-sniffing dispatch across FASTA / GFF3 / GenBank for
 * Stop Codon Finder. NO network. Assembles the unified sequence + feature
 * model from 1 or 2 dropped files.
 *
 * Exposes a global `CodonInput`:
 *   CodonInput.detect(text) -> 'fasta'|'gff-no-fasta'|'gff-with-fasta'|'genbank'|'unknown'
 *   CodonInput.dispatch(files) -> { records:[{id,seq}], features:[Feature], warnings:[], errors:[] }
 *       files = [{name,text}] (1 or 2 entries)
 *
 * Detection is content-based; file extension is only a tiebreaker.
 */
(function (global) {
  'use strict';

  function detect(text) {
    if (!text || !text.trim()) return 'unknown';
    // GenBank first.
    if (global.CodonGenBank && global.CodonGenBank.looksLikeGenBank(text)) return 'genbank';
    var t = (global.CodonParser ? global.CodonParser.detectFileType(text) : 'unknown');
    if (t === 'genbank') return 'genbank';
    if (t === 'gff-with-fasta') return 'gff-with-fasta';
    if (t === 'gff-no-fasta') return 'gff-no-fasta';
    if (t === 'fasta') return 'fasta';
    return 'unknown';
  }

  // Parse a single file into { kind, records, features, warnings }.
  function parseOne(file) {
    var text = file.text || '';
    var kind = detect(text);
    var out = { kind: kind, name: file.name, records: [], features: [], warnings: [] };

    if (kind === 'genbank') {
      var gb = global.CodonGenBank.parse(text);
      out.records = gb.records.filter(function (r) { return r.seq && r.seq.length > 0; });
      out.features = gb.features;
      out.warnings = gb.warnings.slice();
    } else if (kind === 'gff-with-fasta' || kind === 'gff-no-fasta') {
      var gff = global.CodonGFF.parse(text);
      out.records = gff.records;
      out.features = gff.features;
      out.warnings = gff.warnings.slice();
    } else if (kind === 'fasta') {
      var parsedRecs = global.CodonParser.parseFastaBlock(text)
        .filter(function (r) { return r.seq && r.seq.length > 0; });
      // Surface input-normalization diagnostics (soft-masked/RNA/gapped bases)
      // so a lowercase or U-containing genome does not silently mis-scan.
      var agg = { lowercase: 0, uConverted: 0, gaps: 0, unexpected: 0, ambiguous: 0 };
      parsedRecs.forEach(function (r) {
        if (!r._stats) return;
        agg.lowercase += r._stats.lowercase; agg.uConverted += r._stats.uConverted;
        agg.gaps += r._stats.gaps; agg.unexpected += r._stats.unexpected;
      });
      var notes = [];
      if (agg.uConverted > 0) notes.push('RNA input detected — ' + agg.uConverted + ' U base(s) read as T');
      if (agg.lowercase > 0) notes.push(agg.lowercase + ' lowercase (soft-masked) base(s) scanned as uppercase');
      if (agg.gaps > 0) notes.push(agg.gaps + ' gap/pad character(s) removed');
      if (agg.unexpected > 0) notes.push(agg.unexpected + ' unexpected non-nucleotide letter(s) ignored');
      if (notes.length) out.warnings.push('Sequence normalized: ' + notes.join('; ') + '.');
      out.records = parsedRecs.map(function (r) { return { id: r.id, seq: r.seq }; });
    } else {
      // unknown/raw: last-ditch single-sequence path (existing behavior).
      var pi = global.CodonParser.parseInput(text);
      if (pi.records && pi.records.length) {
        out.records = pi.records.map(function (r) { return { id: r.id, seq: r.seq }; });
        out.kind = 'fasta';
        if (pi.warning) out.warnings.push(pi.warning);
      }
    }
    return out;
  }

  function firstToken(id) {
    return String(id == null ? '' : id).split(/\s+/)[0];
  }

  function dispatch(files) {
    var result = { records: [], features: [], warnings: [], errors: [] };
    files = (files || []).filter(function (f) { return f && typeof f.text === 'string'; });

    if (files.length === 0) {
      result.errors.push('No sequence to scan. Please provide a FASTA, GFF3, or GenBank file.');
      return result;
    }

    var parsed = files.map(parseOne);
    parsed.forEach(function (p) {
      for (var w = 0; w < p.warnings.length; w++) result.warnings.push(p.warnings[w]);
    });

    // Sequence priority per seqId: FASTA record -> GenBank ORIGIN -> GFF ##FASTA.
    // We approximate priority by source kind ranking.
    var kindRank = { fasta: 0, genbank: 1, 'gff-with-fasta': 2, 'gff-no-fasta': 3, unknown: 4 };
    var seqById = {};        // id -> {seq, rank}
    var recordOrder = [];    // preserve first-seen order

    parsed.forEach(function (p) {
      var rank = kindRank[p.kind] === undefined ? 5 : kindRank[p.kind];
      p.records.forEach(function (r) {
        if (!r.seq || r.seq.length === 0) return;
        var existing = seqById[r.id];
        if (!existing) {
          seqById[r.id] = { seq: r.seq, rank: rank, circular: !!r.circular };
          recordOrder.push(r.id);
        } else if (rank < existing.rank) {
          if (existing.seq !== r.seq) {
            result.warnings.push('Two sources supplied a sequence for "' + r.id + '"; kept the higher-priority one.');
          }
          // Preserve a circular topology declared by any source for this id.
          seqById[r.id] = { seq: r.seq, rank: rank, circular: !!r.circular || existing.circular };
        } else {
          if (r.circular) existing.circular = true;
          if (existing.seq !== r.seq) {
            result.warnings.push('Two sources supplied a sequence for "' + r.id + '"; kept the first one.');
          }
        }
      });
    });

    var records = recordOrder.map(function (id) {
      return { id: id, seq: seqById[id].seq, circular: !!seqById[id].circular };
    });

    // Annotation = union of all features, dedupe by (seqId,type,strand,start,end).
    var featSeen = {};
    var features = [];
    parsed.forEach(function (p) {
      p.features.forEach(function (f) {
        var k = f.seqId + '|' + f.type + '|' + f.strand + '|' + f.start + '|' + f.end;
        if (featSeen[k]) return;
        featSeen[k] = 1;
        features.push(f);
      });
    });

    if (records.length === 0) {
      result.errors.push('No sequence to scan. Provide a FASTA file, a GenBank file with an ORIGIN block, or a GFF3 with an embedded ##FASTA section.');
      // still return features so caller can message if needed
      result.features = features;
      return result;
    }

    // Pairing by seqId: match features to records by first whitespace token.
    var recIds = {};
    records.forEach(function (r) { recIds[firstToken(r.id)] = true; });

    var distinctFeatSeq = {};
    features.forEach(function (f) { distinctFeatSeq[firstToken(f.seqId)] = true; });
    var distinctFeatSeqIds = Object.keys(distinctFeatSeq);

    var matched = [];
    var droppedBySeq = {};

    if (records.length === 1 && distinctFeatSeqIds.length === 1 && features.length > 0) {
      // Exactly one record and one feature seqId: pair regardless of id string.
      var onlyRecId = records[0].id;
      var onlyFeatSeq = firstToken(features[0].seqId);
      if (firstToken(onlyRecId) !== onlyFeatSeq) {
        result.warnings.push('Annotation seqId "' + features[0].seqId + '" did not exactly match sequence id "' +
          onlyRecId + '"; paired them anyway (single sequence, single annotation).');
      }
      features.forEach(function (f) {
        var nf = Object.create(null);
        for (var key in f) nf[key] = f[key];
        nf.seqId = onlyRecId; // re-key so annotate() joins on the record id
        matched.push(nf);
      });
    } else {
      features.forEach(function (f) {
        if (recIds[firstToken(f.seqId)]) matched.push(f);
        else droppedBySeq[f.seqId] = (droppedBySeq[f.seqId] || 0) + 1;
      });
    }

    var droppedIds = Object.keys(droppedBySeq);
    if (droppedIds.length) {
      var total = 0;
      droppedIds.forEach(function (id) { total += droppedBySeq[id]; });
      result.warnings.push('Dropped ' + total + ' annotation feature(s) on ' + droppedIds.length +
        ' sequence id(s) not present in the sequence file: ' + droppedIds.slice(0, 5).join(', ') +
        (droppedIds.length > 5 ? ', …' : '') + '.');
    }

    result.records = records;
    result.features = matched;
    return result;
  }

  global.CodonInput = {
    detect: detect,
    dispatch: dispatch
  };
})(typeof window !== 'undefined' ? window : this);
