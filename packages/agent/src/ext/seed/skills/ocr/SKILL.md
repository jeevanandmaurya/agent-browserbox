---
name: ocr
description: Read the text in a picture, a screenshot, a photo of a page or a scanned PDF.
---

# Reading text from pictures (OCR)

Use the `ocr` command (the ocr package, English: `pkg install ocr` if not found).

1. `ocr picture.png` prints the text and a confidence score; `-o out.txt` saves it. Several pictures: `ocr p1.png p2.png`.
2. Layout hints: `--psm 6` for one block of text, `--psm 7` for a single line, `--psm 11` for scattered words (labels, receipts).
3. A scanned PDF has no text (`pdf text` is empty): get its pages as pictures first. If the PDF holds one picture per page, ask the user for the pictures or a higher-quality scan; then OCR them page by page.
4. Below about 80% confidence, read the result critically: check names and numbers, and say which parts are uncertain. Small or blurry text reads better at a larger size: `ffmpeg -i in.png -vf scale=iw*2:-1 big.png`.
5. Only English is installed; say so if the text is in another language.
