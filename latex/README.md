# Bubbles and Beliefs — LaTeX source

Ten-page AER-style paper comparing **three belief-update plans** for the
Lopez-Lira (2025) utility agent embedded in a replicated Dufwenberg,
Lindqvist and Moore (2005) experimental asset market. Plan I is an
algorithmic experience-weighted blend; Plan II and Plan III replace the
blend with period-boundary LLM calls that differ only in whether the
prompt names the closed-form risk-utility expression or only the
risk-preference label.

## Layout

```
latex/
├── main.tex          # thin wrapper: \input{preamble}, \input{macros}, \input{sections/...}
├── preamble.tex      # document class, packages, geometry, AER heading style
├── macros.tex        # math macros (\FV, \EU, \VWAP, \AllocEff, \Uloving, ...)
├── references.bib    # cited bibliography, keyed to aer.bst
├── sections/
│   ├── abstract.tex
│   ├── introduction.tex
│   ├── related_work.tex
│   ├── design.tex
│   ├── agents.tex
│   ├── anchor.tex       # Plan I / Plan II / Plan III belief-update channels
│   ├── results.tex
│   └── conclusion.tex
└── figures/          # placeholder for figure PDFs
```

Each section lives in its own file and is pulled in by `main.tex` via
`\input{}`, so individual sections can be edited, diff-reviewed, and
re-ordered without touching the others. Section order is the single
source of truth in `main.tex`.

## Build

```
cd latex
pdflatex main
bibtex   main
pdflatex main
pdflatex main
```

Produces `main.pdf` — 10 pages including references, 11pt Times,
1-inch margins, Roman-numeral section headings, author-year citations
via the AER BibTeX style (`aer.bst` ships with TeX Live).
