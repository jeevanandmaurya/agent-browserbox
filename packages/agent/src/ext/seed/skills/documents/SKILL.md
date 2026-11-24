---
name: documents
description: Read Word documents and turn text or Markdown into HTML, PDF or Word-friendly files.
---

# Working with documents

- Read a Word file: `docx text file.docx`, or `docx md file.docx` to keep headings and lists (the docx package: `pkg install docx`). Pictures are not extracted as files.
- Markdown to a web page: `marked notes.md -o notes.html --page` (the marked package).
- Markdown or text to PDF: `pdf from-text notes.md -o notes.pdf` (see the pdf skill).
- There is no tool that writes .docx files. When the user needs Word, write HTML (`marked … --page`): Word opens .html files and can save them as .docx. Say so.
- Keep the user's original file; write results next to it and name them.
