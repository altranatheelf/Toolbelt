# Toolbelt

## Carousel Sequencer

`carousel-sequencer.html` is a single self-contained page that measures a set of photos and gives you a 20-slot strip to arrange them in. It never orders, cuts or writes captions. Rules live in `CLAUDE.md`.

Ways to open it:

- **iPhone:** use the published claude.ai link, tap **Choose photos** and select the album's pictures. The sequence autosaves on the phone for that set of photos. Export offers each slide to the share sheet (Save Image puts it in Photos).
- **Desktop Chrome:** double-click the file and use **Open folder…**. The sequence then saves as `carousel-sequence.json` next to the photos, and export writes into `carousel-export/`.

Photos never leave the device: decoding and measuring happen in the page. Sources can be JPEG, PNG, WebP or HEIC (HEIC in Safari only). RAW files (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more) are measured and exported from the full-size preview JPEG the camera embeds, which is the camera's rendering and not your RAW edit. Photos without a capture time (some phone pickers strip it) follow the timed ones in the order you picked them.

- **Measure.** A background worker measures a 768 px copy of each frame (results cached on the device). It also groups near-duplicates (dHash) and badges the camera from EXIF, with PHONE and RAW marked. Desktop Chrome remembers the folder, so **Reopen** works next time.
- **Strip.** Photos are listed in capture-time order. Tap a photo and use **Add** and the bottom bar, or on desktop drag it up or press <kbd>Enter</kbd>. Seams show the tonal jump, the hue shift and any device change. Tag each frame for scale (W/C/F/T) and for you out of frame, in with face hidden, or in with face shown, using the bar buttons or the keys <kbd>W</kbd>/<kbd>C</kbd>/<kbd>F</kbd>/<kbd>T</kbd> and <kbd>0</kbd>/<kbd>1</kbd>/<kbd>2</kbd>.
- **Preview and export.** A swipe preview at one carousel ratio, with slide 1 shown at the profile-grid crop. **Adjust crop** lets you drag and zoom each slide. Export renders `carousel-NN.jpg` at 1080 px wide. The re-encode drops EXIF, GPS, XMP and IPTC. Sequential capture times can be written back so the slides sort in order in Photos.

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
