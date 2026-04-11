# Wang (2026) — LaTeX source

Ten-page AER-style paper on the Wang 2026 ChatGPT-anchored extension
of the Dufwenberg, Lindqvist & Moore (2005) experimental asset market.

## Layout

- `main.tex` — preamble, macros, \input{} of every section
- `sections/` — one file per paper section
  - `abstract.tex` — abstract + keywords + JEL codes
  - `01_introduction.tex`
  - `02_related_literature.tex`
  - `03_experimental_design.tex`
  - `04_agent_model.tex`
  - `05_wang_innovation.tex`
  - `06_results.tex`
  - `07_conclusion.tex`
- `references.bib` — BibTeX database
- `figures/` — placeholder for figure PDFs

## Build

```
cd latex
pdflatex main
bibtex   main
pdflatex main
pdflatex main
```

Produces `main.pdf` — 10 pages including references, 11pt Times,
Roman-numeral section headings, author-year citations via the AER
BibTeX style (`aer.bst` ships with TeX Live).
