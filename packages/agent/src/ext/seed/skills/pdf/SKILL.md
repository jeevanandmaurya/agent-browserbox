---
name: pdf
description: Read, combine, split, rotate or make PDF files (text out of a PDF, PDFs from text, Markdown or pictures).
---

# Working with PDFs

Use the `pdf` command (the pdf package: `pkg install pdf` if the shell says it is not found). Run `pdf --help` for every option.

- Read: `pdf info file.pdf` (pages, size, title), then `pdf text file.pdf [--pages 1-3] [-o out.txt]`. Long documents: read a few pages at a time.
- Empty text means a scanned PDF: turn pages into pictures and use the `ocr` skill.
- Combine and cut: `pdf merge a.pdf b.pdf -o all.pdf`, `pdf pages in.pdf --pages 1-3,7 -o part.pdf` (also reorders), `pdf rotate in.pdf 90 --pages 2 -o out.pdf`.
- Make: `pdf from-text notes.md -o notes.pdf` lays out text or simple Markdown on A4 (Western European letters only; others become "?"). `pdf images a.png b.jpg -o out.pdf` makes one page per picture.
- For a designed document (layout, colours, tables), write an HTML page instead and tell the user they can print it to PDF from the preview.
- Never overwrite the original: write to a new file and say its path.
