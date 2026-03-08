# Phase 5 — Preview Screen & File Export

## Goal
A final confirmation screen showing all four processed images side by side with their output filenames. The user can go back to change selections or confirm to write the files to the output directory. After this phase, the app is fully functional end-to-end.

## Context
- Phases 1–4 must be complete.
- The ROM name (from the filename, not the search term) determines all output filenames.
- Output directory was set by the user on the Main view and stored in config.

## Output Filenames (always derived from ROM filename, not search term)
| Type | Filename |
|---|---|
| Boxart | `{rom_name}.png` |
| Screenshot | `{rom_name}.jpg` |
| Title/Logo | `{rom_name}_title.png` |
| Menu | `{rom_name}_menu.png` |

Example: ROM file `mspacman.zip` → `mspacman.png`, `mspacman.jpg`, `mspacman_title.png`, `mspacman_menu.png`

## Work Items

1. **Build Preview view (frontend)**
   - Layout: four columns displayed horizontally, equal width
   - Each column contains (top to bottom):
     - Processed image preview (scaled to fit the column, aspect ratio preserved — display only, not reprocessed)
     - Output filename label below the image (e.g. `mspacman.png`)
     - Image type label below filename (e.g. "Boxart")
   - Below all columns: two buttons — "← Back" and "Confirm & Save"
   - "← Back" returns to Image Picker with all selections and crop presets intact

2. **Implement `export_images` Tauri command**
   - Signature: `export_images(selections: ExportSelections, rom_name: String, output_dir: String) -> Result<ExportReport, String>`
   - `ExportSelections`: struct containing temp file paths for each of the four image types
   - `ExportReport`: struct with output paths and any per-file warnings
   - Steps per image:
     1. Read processed temp file
     2. Write to `{output_dir}\{filename}` with correct format (already correct from Phase 4)
     3. Confirm file exists and size > 0
   - If output directory doesn't exist, return a clear error (don't create it — user should control their SD card structure)

3. **Overwrite handling**
   - Before writing, check if any of the four output files already exist
   - If any exist: show an inline warning in the Preview view listing the conflicting filenames
   - Offer two options: "Overwrite" (proceeds) and "Cancel"
   - If none exist: "Confirm & Save" proceeds immediately without a confirmation dialog

4. **Success state**
   - After successful export, show a success message with the output directory path
   - Offer a "Scrape Another ROM" button that resets the session and returns to the Main view
   - Do not auto-close the app

5. **Error state**
   - If any file fails to write (permissions, disk full, etc.), show which file failed and the error reason
   - Partial writes: if 2 of 4 files wrote successfully before an error, report which succeeded and which failed
   - Do not silently swallow errors

## Acceptance Criteria
- [ ] Preview view shows all four processed images and their correct output filenames
- [ ] "← Back" returns to picker with selections and crop presets unchanged
- [ ] Confirming writes all four files to the correct output directory with correct names and formats
- [ ] Overwrite warning appears when output files already exist
- [ ] Success message shown after export; "Scrape Another ROM" resets the session
- [ ] Write errors surface a readable message identifying which file failed

## Notes
- The preview images in this view are display-only — use the processed temp files from Phase 4 directly via `asset://`. Do not re-process.
- `rom_name` = ROM filename with extension stripped. Always use this for output filenames, regardless of what was typed in the search field.
- Keep the layout responsive enough that it works at Tauri's default window size (800×600 minimum).
