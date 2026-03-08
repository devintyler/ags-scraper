# Phase 4 — Image Processing

## Goal
Selected images are resized, cropped, converted, and padded to GSP spec. A live processed preview is shown in the Image Picker after the user picks an image and selects a crop preset.

## Context
- Phase 3 must be complete (image picker with selections working).
- All processing happens in Rust using the `image` crate only — no external tools.
- Processing is applied to the cached copy of the image; the original cache file is never modified.
- Processed output is written to a temp location until export (Phase 5).

## Image Processing Rules (full reference in PLAN.md)

| Type | Target size | Scale rule | Crop | Format |
|---|---|---|---|---|
| Boxart | 236×322 | Scale down to fit, preserve AR | Preset (top/center/bottom) | PNG |
| Screenshot | max 362×278 | Scale down only if over limit | Never crop | JPEG |
| Title/Logo | 960×186 | Fit within, preserve AR | Pad with transparency | PNG |
| Menu | 236×322 | Scale down to fit, preserve AR | Preset (top/center/bottom) | PNG |

**Never scale up.** If the source is already within the target bounds, skip resize.

## Work Items

1. **Implement image processing module (`src/image_processing.rs`)**

   **Resize function** — `fn resize_image(img: DynamicImage, target_w: u32, target_h: u32, allow_crop: bool) -> DynamicImage`
   - If `img` width <= target_w AND height <= target_h: return as-is (no upscale)
   - Otherwise: calculate scale factor for width (`target_w / img_w`) and for height (`target_h / img_h`), take the **larger** of the two (this fills the target dimension maximally without exceeding it)
   - Apply resize using `Lanczos3` filter

   **Crop function** — `fn apply_crop_preset(img: DynamicImage, target_w: u32, target_h: u32, preset: CropPreset) -> DynamicImage`
   - `CropPreset` enum: `Top`, `Center`, `Bottom`
   - Calculate excess pixels in the overflow dimension (width or height)
   - `Top`: take from (0,0); `Center`: offset by excess/2; `Bottom`: offset by full excess
   - Crop to exact target dimensions

   **Title pad function** — `fn pad_to_canvas(img: DynamicImage, canvas_w: u32, canvas_h: u32) -> DynamicImage`
   - Resize image to fit within canvas while preserving aspect ratio (scale down only)
   - Create a new RGBA canvas of `canvas_w × canvas_h` filled with transparent pixels
   - Composite the resized image centered on the canvas
   - Return as `DynamicImage::ImageRgba8`

   **Screenshot function** — `fn process_screenshot(img: DynamicImage) -> DynamicImage`
   - If both dimensions are already within 362×278, return as-is
   - Otherwise scale down using the **smaller** scale factor (ensures neither dimension exceeds the max)
   - No crop

   **Format conversion** — handled at save time via `image::save_buffer` with the appropriate format; no separate function needed

2. **Implement `process_image` Tauri command**
   - Signature: `process_image(cache_path: String, image_type: ImageType, crop_preset: Option<CropPreset>) -> Result<String, String>`
   - `ImageType` enum: `Boxart`, `Screenshot`, `Title`, `Menu`
   - Dispatches to the correct processing function based on type
   - Saves processed result to a temp path: `%APPDATA%\gsp-scraper\temp\{hash}_{type}_{preset}.{ext}`
   - Returns the temp file path

3. **Add crop preset selector to Image Picker (frontend)**
   - After selecting an image in the Boxart or Menu tab, show three preset buttons: Top | Center | Bottom
   - Default to Center
   - On preset select: call `process_image` with the new preset, update the preview image in-place
   - Screenshot and Title tabs do not show the crop preset selector
   - Show a small "processing..." indicator while `process_image` runs

4. **Live preview in picker**
   - After processing, replace the selected image preview with the processed version (correct dimensions)
   - Show the output dimensions as a label below the preview (e.g. "236 × 301 → cropped to 236 × 322")

## Acceptance Criteria
- [ ] Boxart/Menu: selecting an image and a crop preset produces a 236×322 PNG preview
- [ ] Screenshot: image is scaled down only if it exceeds 362×278; no cropping
- [ ] Title/Logo: image is fit within 960×186 and padded with transparency; aspect ratio preserved
- [ ] Switching crop presets on a selected image updates the preview without re-downloading
- [ ] A source image already within target dimensions is not scaled up

## Notes
- The `image` crate's `DynamicImage::crop` method takes `(x, y, width, height)` — calculate offsets carefully.
- For RGBA compositing (title pad), use `image::imageops::overlay`.
- Save JPEG with quality 90 (`image::codecs::jpeg::JpegEncoder::new_with_quality`).
- The temp directory should be cleaned up on app exit or at the start of a new scrape session.
