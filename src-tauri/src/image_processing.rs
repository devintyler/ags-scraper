use image::{DynamicImage, GenericImageView, ImageFormat, imageops::FilterType};
use sha2::Digest;
use std::path::PathBuf;

#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq)]
pub enum ImageType {
    Boxart,
    Screenshot,
    Title,
    Menu,
}

#[derive(serde::Deserialize, Debug, Clone, Copy, PartialEq)]
pub enum CropPreset {
    Top,
    Center,
    Bottom,
}

pub fn temp_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(appdata).join("gsp-scraper").join("temp"))
}

/// Creates the temp directory and returns its path.
pub fn ensure_temp_dir() -> Result<PathBuf, String> {
    let dir = temp_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    Ok(dir)
}

pub fn cleanup_temp_dir() {
    if let Ok(dir) = temp_dir() {
        if dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Scales `img` down using cover semantics so it fills the target box on at least
/// one axis (the other may overflow and be trimmed by `apply_crop_preset`).
/// Never scales up — images already fitting within the target are returned as-is.
fn resize_boxart_menu(img: DynamicImage, target_w: u32, target_h: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return img;
    }
    if w <= target_w && h <= target_h {
        return img;
    }
    // .max() picks the larger scale factor so the image covers both axes of the
    // target box; .min(1.0) prevents upscaling.
    let scale = (target_w as f32 / w as f32)
        .max(target_h as f32 / h as f32)
        .min(1.0);
    let new_w = (w as f32 * scale).round() as u32;
    let new_h = (h as f32 * scale).round() as u32;
    img.resize_exact(new_w, new_h, FilterType::Lanczos3)
}

/// Crops `img` to `target_w × target_h`. The preset controls vertical alignment;
/// horizontal excess is always centered.
fn apply_crop_preset(
    img: DynamicImage,
    target_w: u32,
    target_h: u32,
    preset: CropPreset,
) -> DynamicImage {
    let (w, h) = img.dimensions();
    let excess_x = w.saturating_sub(target_w);
    let excess_y = h.saturating_sub(target_h);
    // Horizontal excess is always centered — the preset only affects vertical alignment.
    let x = excess_x / 2;
    let y = match preset {
        CropPreset::Top => 0,
        CropPreset::Center => excess_y / 2,
        CropPreset::Bottom => excess_y,
    };
    img.crop_imm(x, y, target_w.min(w), target_h.min(h))
}

fn pad_to_canvas(img: DynamicImage, canvas_w: u32, canvas_h: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return img;
    }
    // No .min(1.0): allow upscaling so the image fills one canvas dimension
    // fully, minimising transparent padding on that axis.
    let scale = (canvas_w as f32 / w as f32).min(canvas_h as f32 / h as f32);
    let new_w = (w as f32 * scale).round() as u32;
    let new_h = (h as f32 * scale).round() as u32;
    let resized = img.resize_exact(new_w, new_h, FilterType::Lanczos3).to_rgba8();
    let mut canvas = image::RgbaImage::new(canvas_w, canvas_h);
    // saturating_sub guards against 1-pixel rounding drift that could make new_w > canvas_w.
    let offset_x = (canvas_w.saturating_sub(new_w) / 2) as i64;
    let offset_y = (canvas_h.saturating_sub(new_h) / 2) as i64;
    image::imageops::overlay(&mut canvas, &resized, offset_x, offset_y);
    DynamicImage::ImageRgba8(canvas)
}

fn process_screenshot(img: DynamicImage) -> DynamicImage {
    let max_w = 362u32;
    let max_h = 278u32;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 || (w <= max_w && h <= max_h) {
        return img;
    }
    // resize() fits within the bounds preserving aspect ratio; never crops.
    img.resize(max_w, max_h, FilterType::Lanczos3)
}

pub fn process_image(
    cache_path: &str,
    image_type: ImageType,
    crop_preset: Option<CropPreset>,
) -> Result<String, String> {
    // Read the raw bytes and let the image crate detect the format from the
    // magic bytes — not the file extension. SS media URLs often have no
    // extension (e.g. image.php?gameid=...), so extension-based detection fails.
    let bytes = std::fs::read(cache_path)
        .map_err(|e| format!("Failed to read image: {e}"))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to open image: {e}"))?;

    let processed = match image_type {
        ImageType::Boxart | ImageType::Menu => {
            let resized = resize_boxart_menu(img, 236, 322);
            let preset = crop_preset.unwrap_or(CropPreset::Center);
            apply_crop_preset(resized, 236, 322, preset)
        }
        ImageType::Title => pad_to_canvas(img, 960, 186),
        ImageType::Screenshot => process_screenshot(img),
    };

    let type_str = match image_type {
        ImageType::Boxart => "boxart",
        ImageType::Screenshot => "screenshot",
        ImageType::Title => "title",
        ImageType::Menu => "menu",
    };
    let preset_str = match crop_preset {
        Some(CropPreset::Top) => "top",
        Some(CropPreset::Bottom) => "bottom",
        Some(CropPreset::Center) | None => "center",
    };

    let mut hasher = sha2::Sha256::new();
    hasher.update(cache_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    let dir = ensure_temp_dir()?;

    // Screenshots ignore crop_preset, so the filename omits it to avoid false
    // cache misses when the caller passes a non-None preset.
    let out_path = match image_type {
        ImageType::Screenshot => dir.join(format!("{hash}_{type_str}.jpg")),
        _ => dir.join(format!("{hash}_{type_str}_{preset_str}.png")),
    };

    match image_type {
        ImageType::Screenshot => {
            use image::codecs::jpeg::JpegEncoder;
            let rgb = processed.to_rgb8();
            let file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            let mut writer = std::io::BufWriter::new(file);
            JpegEncoder::new_with_quality(&mut writer, 90)
                .encode_image(&rgb)
                .map_err(|e| e.to_string())?;
        }
        _ => {
            processed
                .save_with_format(&out_path, ImageFormat::Png)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(out_path.to_string_lossy().into_owned())
}
