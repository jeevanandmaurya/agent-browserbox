---
name: spreadsheets
description: Open, analyse, convert or create Excel, OpenDocument or CSV spreadsheets.
---

# Working with spreadsheets

Use the `sheet` command (the sheet package: `pkg install sheet` if it is not found).

1. Look first: `sheet info book.xlsx` lists the sheets, their size and first row. Pick a sheet with `--sheet Name`.
2. To compute, get the data out as CSV or JSON (`sheet csv book.xlsx -o data.csv`, `sheet json book.xlsx`) and do the arithmetic in code (run_python with pandas when Python is installed, otherwise run_js). Never add up figures by eye.
3. To hand back a spreadsheet: write CSV or JSON, then `sheet make data.csv other.csv -o result.xlsx` (one sheet per file, named after it). `sheet convert in.xlsx out.ods` changes the format.
4. Formulas and formatting are not kept when converting through CSV: say so if the user's file had them, and keep their original unchanged.
5. Show small results as a table in the reply (a ```ui Table when the chat can show it); name the files you wrote.
