# Toolbelt

## Carousel Sequencer

`carousel-sequencer.html` is one self-contained page for cutting a pool of photos down to an Instagram carousel of up to 20 slides. It measures and guides; it never places, orders or cuts anything without a tap. Rules live in `CLAUDE.md`.

**Open it:** on iPhone, use the published claude.ai link. On desktop, double-click the file. Photos never leave the device.

### The three tabs

1. **Cut.** Add the whole pool from Photos or Files, dozens to a couple hundred frames, in any number of batches. Frames stay in the order you added them, labelled by file number (`9774`, `103_0216`) and camera. Tap a frame to open it full screen, then **Keep** or **Out**; the next frame comes up by itself. Near-identical frames from the same camera stack as **twins** and come one after another. Similar framing across different cameras is marked as a **rhyme**. Filters: To decide, Kept, Out, All, and one chip per camera.
2. **Sequence.** The carousel as a storyboard. Each row shows the slide's role (Cover; Second cover, where Instagram re-shows the post to people who didn't swipe; Closer), the file number, the camera, and plain-word tags (Scale: Wide, Close, Face, Texture; You: Not in it, Face hidden, Face shown). Reorder with the handle or ↑ ↓. **Swap** replaces a slide from your kept frames in one tap, with hints such as "smooth seams here", "rhymes with 103_0216" or "twin of slide 3". Add **video slides**: they count toward the 20 and hold the slot, optionally with a frame from the clip. Between rows you see the brightness change, the colour shift and any camera change (a label, never a warning). A lane view shows camera, brightness and average colour across the whole sequence.
3. **Preview.** Swipe through the carousel at one ratio, with slide 1 at the profile-grid crop, and adjust each slide's crop. Export renders `NN-<file number>.jpg` at 1080 px wide and skips video slots, telling you where each video goes. Only sequential capture times are written, so Photos keeps the order; there is also an option for no metadata at all.

The carousel (title, decisions, tags, order, crops) autosaves on the device. **Save backup** writes it as a JSON file; adding that file restores it.

### Colour and tone checks

Each frame is compared with **its own camera's** median: the carousel's frames from that camera if there are 3 or more, otherwise that camera's frames not marked Out. A camera with fewer than 3 frames is not judged. Set-wide medians appear in the photo view's Numbers table and are never flagged. RAW files are measured from the camera's embedded preview, which is not your edit, so they get no colour flags and stay out of every baseline.

| metric | definition | flagged when |
|---|---|---|
| saturation | median of per-pixel HSV S | ±0.05 |
| contrast | p95 − p5 of Rec.709 luma | ±0.12 |
| clipped highlights | % of pixels whose brightest channel ≥ 250 | +3 pts and ≥ 2× |
| crushed shadows | % of pixels whose brightest channel ≤ 5 | +3 pts and ≥ 2× |
| warmer / cooler | mean (R−B)/255 over near-neutral pixels | ±0.03 |
| magenta / green | mean (G−(R+B)/2)/255 over near-neutral pixels | ±0.02 |
| soft | variance of the Laplacian | below half the camera median |

### iPhone filenames

Safari 17+ renames picked photos to `tempImage….heic` (and converts them) when a page asks for HEIC, so the page never asks for HEIC. If the picker still renames anything, the page names the affected files. Re-add them with the picker's **Options → Format: Current**, or through **Add from Files**.

### Tests

```
npm test            # core: metrics, per-camera flags, twins/rhymes, file numbers, EXIF, RAW, crop maths
npm run smoke       # drives the page in Chromium: cut → sequence (video slot, swap) → export → reload
npm run scale       # 200 full-size frames on an emulated iPhone: load, measure and tap timings
npm run calibrate   # radar station set: put the exports in tests/fixtures/radar-station/
```

Not in v1: exporting or measuring video, and the bridge to the zine site's JSON import.
