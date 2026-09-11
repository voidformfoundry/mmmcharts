# MindMonitor EEG Viewer

A static web page that charts a [Mind Monitor](https://mind-monitor.com/) CSV log, the session export from
the Mind Monitor app for Muse EEG headbands.

The file is parsed in the browser with the File API. Nothing is uploaded, and there is no backend, no
database and no analytics. Open the page, drop a CSV on it, and the whole session is charted.

**Live:** <https://voidformfoundry.github.io/mmmcharts/> — press *See a sample session* to load the
69-minute demo recording in `sample/` without a file of your own.

## What it charts

Columns are matched by name, so exports from different Mind Monitor versions and headband models work, and
anything unrecognised is still plotted rather than dropped.

| Section | Columns used | Charts |
|---|---|---|
| Band power | `Delta_*`, `Theta_*`, `Alpha_*`, `Beta_*`, `Gamma_*` | smoothed band powers averaged across electrodes; a per-band detail panel with each band on its own scale; one band at a time across TP9 / AF7 / AF8 / TP10 |
| Derived indices | `Alpha_*`, `Theta_*`, `Beta_*` | relaxation (alpha ÷ theta) and focus (beta ÷ theta) on a ratio axis |
| Heart rate | `Heart_Rate` | beats per minute with the session mean |
| Session averages | band columns | band × electrode heatmap of mean log power |
| Events and movement | `Elements`, `Accelerometer_*` | blink and jaw-clench ticks over head-movement magnitude |
| Raw EEG | `RAW_*` | traces stacked by electrode |
| Signal quality | `HSI_*`, `HeadBandOn`, `Battery` | contact-quality strips, headband-on, battery |
| Other | any other numeric column | plotted as logged |

A **Table** tab lists per-column statistics, the event log and the raw rows.

## Reading the charts

Mind Monitor records band power as log10 of the power in µV², so the unit on the band charts is the Bel:
`0` means 1 µV², `+1` means ten times that, and a step of `0.3` is a doubling.

- **Relative to baseline** redraws each band as its distance from its own baseline, the session median or the
  mean of the first 1, 2 or 5 minutes. All bands then share one axis labelled in `×2` / `÷2` steps.
- **Smoothing** applies a centred moving average of 5 to 60 seconds, or none.
- Every chart has a **?** button that opens an explanation of what it shows and how to read it.

## Using it

Drag across any chart to zoom into a time range and every chart follows; double-click or press *Reset zoom*
to go back. Hovering a line dims the others; clicking a legend entry hides that series. Any chart, or the
whole dashboard, can be downloaded as a PNG rendered at a fixed width so the image is identical on a phone
and on a desktop.

## Running it locally

There is no build step and no dependencies to install. Serve the directory with any static file server:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` directly from the filesystem also works in most
browsers.

## Deploying

The repository is the site. GitHub Pages serves it from the default branch root with no workflow; any other
static host works the same way. `.nojekyll` disables Jekyll processing, and `404.html` is self-contained so
it renders correctly when served from an arbitrary path.

## Sample data

`sample/sample-session.csv` is a real Muse S recording published with the site so the viewer can be tried
without your own export. See `sample/README.md` for what it contains. Your own recordings stay private:
`.gitignore` excludes `*.csv` everywhere except that one file.

## Dependencies

[uPlot](https://github.com/leeoniya/uPlot) for the charts, vendored under `vendor/` so the page loads no
third-party resources at runtime. See `vendor/README.md` for the version and upgrade steps.

## Privacy

EEG recordings are personal data. The page never sends the file anywhere: parsing, charting and PNG export
all happen locally in the browser, and the only network requests the page makes are for its own files.
`.gitignore` excludes `*.csv` so recordings are not committed by accident.

## Licence

MIT, see `LICENSE`. Mind Monitor and Muse are trademarks of their respective owners; this project is
independent and not affiliated with either.
