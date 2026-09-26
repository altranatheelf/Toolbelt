# Toolbelt

## Carousel Sequencer

`carousel-sequencer.html` is a single self-contained page. Open it in Chrome (double-click it; no server needed) and open a folder of Lightroom exports. It measures every frame and gives you a 20-slot strip to arrange them in. It never orders, cuts or writes captions. Rules live in `CLAUDE.md`.

- **Measure.** A background worker measures a 768 px copy of each frame (results cached in IndexedDB). It also groups near-duplicates (dHash) and badges the camera from EXIF. Chrome remembers the folder, so **Reopen** works next time.
- **Strip.** The pool is in capture-time order. Drag frames into the strip, or select one and press <kbd>Enter</kbd>. Seams show the tonal jump, the hue shift and any device change. Tag each frame with <kbd>W</kbd>/<kbd>C</kbd>/<kbd>F</kbd>/<kbd>T</kbd> for scale and <kbd>0</kbd>/<kbd>1</kbd>/<kbd>2</kbd> for you out of frame, in with face hidden, or in with face shown. The sequence autosaves to `carousel-sequence.json` next to the photos.
- **Preview and export** (<kbd>P</kbd>). A phone-sized swipe preview at one carousel ratio, with slide 1 shown at the profile-grid crop and a draggable crop and zoom for each slide. Export writes `carousel-NN.jpg` at 1080 px wide into `carousel-export/`. The canvas re-encode drops EXIF, GPS, XMP and IPTC, keeping only an sRGB profile. Sequential capture times can be written back if you choose.

### Metric definitions

All metrics are computed on gamma-encoded sRGB. Each frame is compared with the baseline: the median over the strip, or over the whole import when the strip is empty.

| metric | definition | flag when |
|---|---|---|
| median saturation | median of per-pixel HSV S = (max−min)/max | \|Δ\| ≥ 0.05 |
| luminance spread | p95 − p5 of Rec.709 luma | \|Δ\| ≥ 0.12 |
| highlight clip % | pixels whose brightest channel ≥ 250 | +3 pts and ≥ 2× baseline |
| crushed shadows % | pixels whose brightest channel ≤ 5 | +3 pts and ≥ 2× baseline |
| red-blue balance | mean (R−B)/255 over near-neutral pixels | \|Δ\| ≥ 0.03 |
| green-magenta tint | mean (G−(R+B)/2)/255 over near-neutral pixels; negative is magenta | \|Δ\| ≥ 0.02 |

### Tests

```
npm test            # core metrics, flags, EXIF, crop maths, self-containment (node only)
npm run smoke       # drives the real page in Chromium with a synthetic shoot
npm run calibrate   # radar station set: put the exports in tests/fixtures/radar-station/
```

Fixture photos are gitignored so they never leave the machine. `tests/expected.json` holds the calibration targets: image 17 magenta-shifted, the original 9638 export at about 7% clipping against a set median of about 2%, and a set median saturation of about 0.273. If calibration misses, change the metric definitions, not the thresholds.

Not in v1: video slides, and a bridge to the zine site's JSON import.
