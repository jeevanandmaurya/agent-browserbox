---
name: video-audio
description: Convert, trim, resize or compress video and audio, extract sound or frames, or inspect a media file with FFmpeg.
---

# Video and audio with FFmpeg

Use `ffmpeg` and `ffprobe` (the ffmpeg package, 32 MB: `pkg install ffmpeg` if not found). They work like FFmpeg 6 on a computer, on files in the working folder.

1. Inspect first: `ffprobe -hide_banner in.mp4` (duration, streams, size).
2. Common jobs:
   - convert: `ffmpeg -i in.mov -c:v libx264 -crf 23 -c:a aac out.mp4`
   - resize: `ffmpeg -i in.mp4 -vf scale=1280:-2 out.mp4`
   - trim: `ffmpeg -ss 00:00:05 -to 00:00:20 -i in.mp4 -c copy clip.mp4`
   - sound only: `ffmpeg -i in.mp4 -vn -c:a libmp3lame audio.mp3`
   - one frame: `ffmpeg -ss 3 -i in.mp4 -frames:v 1 frame.png`; a GIF: `ffmpeg -i in.mp4 -vf fps=10,scale=480:-1 out.gif`
3. It runs on one thread in the browser: a few minutes of HD video can take minutes, and a run stops after 10 minutes. For long jobs, say so up front, try a short piece first, and prefer `-c copy` (no re-encoding) when the format allows it. Run long encodes with shell background=true and check on them.
4. Write to a new file, then check it with ffprobe and report its size and duration.
