# Stop Codon Finder

A self-contained, **100% client-side** web app that scans DNA for **stop codons**
across all **six reading frames**, maps each one to the **gene it falls in** when
you supply an annotation, and turns the result into stats, visualizations, a
per-gene summary, and downloadable reports in half a dozen formats.

No established free tool (NCBI ORFfinder, EMBOSS, ExPASy Translate, the Sequence
Manipulation Suite) classifies stop codons **against a genome annotation** —
telling you whether each stop *terminates* a coding sequence, sits *inside* one
(a possible readthrough / selenocysteine / pseudogene signal), or is *intergenic*.
That's what this tool does, entirely in your browser.

There is **no backend, no build step, and no external dependencies** — just static
HTML/CSS/JS. Your sequence data is read locally via the
[File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API); nothing is
ever uploaded or transmitted.

---

## Quick start

1. **Open it** — double-click `index.html` (works from `file://`), or host it on
   GitHub Pages (see below).
2. Drop your file(s) on the drop zone, click **Choose File(s)…**, or pick a
   bundled sample from **Load example ▾** (including a real *Lambda* phage genome).
3. Optionally set the **genetic code**, indicate your **organism**, or choose a
   **scan mode** — sensible defaults are chosen for you.
4. Click **Run scan** and watch the progress panel (percent, throughput, ETA).
5. Explore the stat cards, visualizations, per-gene summary, and results table,
   then **download** in the format you need.

## Supported input

Formats are detected from file **content**, not just the extension.

| Input | Extensions | Provides |
|-------|-----------|----------|
| **FASTA** | `.fasta` `.fa` `.fna` `.ffn` `.txt` | Sequence (multi-contig OK) |
| **GenBank** | `.gb` `.gbk` `.gbff` `.genbank` | Sequence **and** annotation in one file |
| **GFF3 with `##FASTA`** | `.gff` `.gff3` `.gtf` | Sequence **and** annotation in one file |
| **FASTA + GFF3 pair** | drop both | Sequence from the FASTA, annotation from the GFF3 (matched by sequence ID) |

Sequences are normalized before scanning (uppercased, RNA `U`→`T`, gaps/whitespace/
digits stripped); unexpected characters trigger a warning so soft-masked or
lowercase genomes don't silently under-report. Ambiguity codes are handled
rigorously — a codon is called a stop only if **every** IUPAC resolution is a stop
(so `TAR`/`TRA` are stops, `TGN` is not).

## Gene annotation (the unique part)

With an annotation present, every stop codon is mapped to overlapping genes and
tagged with a **context**:

| Context | Meaning |
|---------|---------|
| `cds-terminator` | the stop codon that terminates a coding sequence |
| `orf-terminator` | terminates a predicted ORF (no-annotation mode) |
| `cds-internal-inframe` | an in-frame stop **inside** a CDS — a candidate **readthrough / selenocysteine / programmed frameshift / annotation-or-sequencing artifact** |
| `cds-internal-outframe` | a stop inside a CDS but in another frame |
| `within-noncoding-gene` | inside a gene/mRNA/tRNA/rRNA |
| `intergenic` | not inside any annotated feature |

You also get a **per-gene summary** (one row per CDS: gene, locus tag, product,
length, internal-stop count, terminating codon, with a possible-pseudogene flag),
and a **genetic-code sanity check** — if too many CDS lack a terminator or carry
in-frame internal stops, the app warns that your selected translation table may be
wrong for the data. GenBank locations are fully parsed, including
`complement(...)`, `join(...)` (spliced CDS), origin-wrapping features on circular
genomes, and `/transl_except` (so genuine Sec/Pyl recodings aren't reported as
premature stops).

## Genetic code (any organism)

A selector offers the common **NCBI translation tables** (1, 2, 3, 4, 5, 6, 9, 10,
11, 12, 13, 14, 16, 21, 22, 23, 24, 25, 26, 33, plus the ambiguous 27/28/31 which
are flagged, not hard-called). The stop set is data-driven per table, so organisms
that reassign codons are handled correctly — e.g. **table 4** (Mycoplasma) drops
`TGA`, **table 6** (ciliates) keeps only `TGA`, **table 2** (vertebrate mito) adds
`AGA`/`AGG`, and **tables 22/23** add the non-canonical stops `TCA`/`TTA`. Per-CDS
`transl_table` declarations are honored. The table is auto-selected from a declared
`transl_table`, or inferred from organism keywords in the headers, or you can just
**indicate your organism** and let the tool pick — and you can always override it
manually.

## Scan modes

- **All stop codons** — every stop in all six frames (exhaustive).
- **Coding / predicted stops** — only stop codons that terminate a coding
  sequence. With an annotation that's each CDS's terminator; without one, an ORF
  finder predicts genes (ATG-only by default like NCBI ORFfinder, with an
  "include alternative start codons" toggle, and start-to-stop vs stop-to-stop).

## Exports

Every hit carries **one stable ID** (`stop_0001`, …) that cross-references across
all formats, so a row in one file maps to the same feature in another.

| Format | Notes |
|--------|-------|
| **CSV** / **JSON** | full table + summary; JSON includes provenance (organism, table) |
| **GFF3** (`.gff3`) | 1-based, inclusive; phase column `0` (frame is an attribute); percent-encoded attributes; `Is_circular` for circular inputs — drops into IGV/genome browsers |
| **BED** (`.bed`) | **0-based, half-open** (`chromStart = start − 1`); optional colored `itemRgb` |
| **FASTA** (`.fna` / `.faa`) | extracted ORF nucleotides and translated proteins (coding/ORF mode) |
| **Figures** (`.svg` / `.png`) | any on-screen chart, exported as vector SVG or raster PNG |

The coordinate convention is stated in-app: CSV/JSON/GFF3 are 1-based inclusive;
BED is 0-based half-open.

## Visualizations

Self-contained inline SVG (no libraries, theme-aware, colorblind-safe, downloadable):

- a **six-frame stop map** — ticks per stop across all six frame lanes along the
  sequence, colored by codon;
- a **stop-codon density** plot — a sliding window, forward and reverse;
- a **circular** plot for circular replicons (phages/plasmids).

## Learn / How this works

A built-in **Learn** section explains, accurately and at an undergraduate-friendly
level: what a stop codon is (and that the set changes with the genetic code), the
six reading frames and reverse complement (with a worked coordinate example),
translation-table variation across organisms, what an ORF is, and the coordinate
conventions. There's a **glossary**, inline help on every stat, and a
**Methods / how to cite / limitations** section.

## Deploying to GitHub Pages

1. Create a repository, e.g. `stop-codon-finder`.
2. Copy these files into the repo root, preserving structure (`index.html`,
   `css/`, `js/`, `blog.html`, `README.md`, `LICENSE`, `.nojekyll`). The included
   `.gitignore` keeps local test data out of the repo.
3. Commit and push:
   ```bash
   git add .
   git commit -m "Stop Codon Finder"
   git branch -M main
   git remote add origin https://github.com/<you>/stop-codon-finder.git
   git push -u origin main
   ```
4. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   choose `main` / `/ (root)`, save.
5. Live at `https://<you>.github.io/stop-codon-finder/` within a minute or two;
   the blog is at `…/blog.html`.

## Privacy

Everything happens locally — files are read with `FileReader`, scanning/annotation
is plain JavaScript, and downloads use `Blob` + `URL.createObjectURL`. **No network
requests are made after the page loads**, so the app also works fully offline. You
can confirm this in your browser's Network tab.

## Biology & coordinate notes

- **Stop codons** in the standard/bacterial code are `TAA` (ochre), `TAG` (amber),
  `TGA` (opal); alternative genetic codes change this set.
- **Six frames**: forward +1/+2/+3 read the sequence as given; reverse −1/−2/−3
  read the reverse complement.
- **Coordinates** are 1-based, inclusive, and always reported on the **forward
  strand** for both strands. For a reverse-complement codon at 0-based index `j`
  in a length-`L` sequence: `start = L−2−j`, `end = L−j`. (BED export converts to
  0-based half-open.)
- **GC%** = (G+C)/length; **density** = stop codons per 1000 bp.

## Project structure

```
index.html         Page structure and layout
blog.html          Standalone blog / user guide (served by the same Pages site)
css/styles.css     Styling (light + dark themes, accessible palette)
js/tables.js       NCBI translation tables (stop sets, alt starts, organism->table)
js/parser.js       FASTA parsing + sequence normalization
js/genbank.js      GenBank parser (sequence + features; complement/join; circular; transl_except)
js/gff.js          GFF3 parser (+ phase column) -> normalized feature model
js/input.js        Format detection + one/two-file dispatch
js/scanner.js      reverseComplement, six-frame scan, ambiguity handling, circular junctions, chunked scanAll, stable IDs
js/annotate.js     Interval index + gene mapping + context classification
js/orf.js          ORF prediction (start-to-stop / stop-to-stop; start-codon policy)
js/report.js       Summary, per-gene summary, genetic-code sanity, CSV/JSON export
js/export.js       GFF3 / BED / FASTA / SVG / PNG exports
js/viz.js          Self-contained SVG visualizations
js/progress.js     Phase-weighted progress + throughput/ETA
js/sample.js       Bundled examples (incl. a real Lambda phage GenBank)
js/app.js          DOM wiring: loader, controls, tables, charts, downloads, theme, explainers
.nojekyll          Tells GitHub Pages not to run Jekyll on this folder
```

All scripts load as plain, global (non-module) `<script>` tags in dependency
order — deliberately, so the app works identically via `file://` and `https://`.

## Performance & limitations

- Scanning runs in chunks that yield via `MessageChannel` (not paused in
  background tabs the way `requestAnimationFrame` is), so the UI stays responsive.
  A ~4.6 Mb bacterial genome scans in roughly a second or two in a focused tab.
- **Background-tab caveat:** browsers throttle CPU-bound main-thread work in tabs
  hidden for a while, so a large scan left in a background tab slows down until you
  return. Results are unaffected — only speed.
- The bundled real Lambda example adds ~178 KB to the page; remove it from
  `js/sample.js` if you prefer a lighter download.
- Recoding (selenocysteine, readthrough, frameshifts) **cannot be called from
  sequence alone** — the app flags candidates rather than asserting them. ORFs are
  not joined across a circular origin. Genetic code is applied globally (mixed
  `transl_table` files warn).

## Browser support

Any recent Chrome, Edge, Firefox, or Safari. Uses only standard Web APIs:
`FileReader`, `Blob`, `URL.createObjectURL`, `MessageChannel`, `<canvas>` (for PNG
export), `matchMedia`, and (optionally) `localStorage` for your theme preference.

## License

MIT — see [LICENSE](LICENSE).
