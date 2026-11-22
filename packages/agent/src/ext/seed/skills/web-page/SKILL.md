---
name: web-page
description: Build a self-contained web page, chart or small interactive tool and show it in the preview.
---

# Building a web page

1. Write one complete HTML file in the working directory. Inline the CSS and JavaScript; do not depend on CDNs, because the preview may be offline.
2. Use system fonts, a readable type scale and enough contrast; make it work at 380px wide.
3. Draw charts with inline SVG or `<canvas>`.
4. Show it with show_html using the file path, so the user can also open and edit the file.
5. Say where the file is saved.
