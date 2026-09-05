#[path = "build/ffmpeg.rs"]
mod ffmpeg;

fn main() {
    // GPU Acceleration Detection and Build Guidance
    detect_and_report_gpu_capabilities();

    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=Foundation");

        // Let the enhanced_macos crate handle its own Swift compilation
        // The swift-rs crate build will be handled in the enhanced_macos crate's build.rs
    }

    alias_vulkan_import_lib_for_msvc();

    // Download and bundle FFmpeg binary at build-time
    ffmpeg::ensure_ffmpeg_binary();

    tauri_build::build()
}

/// transcribe.cpp's link manifest records the Vulkan loader as the Unix `-lvulkan`
/// (cmake/transcribe-install.cmake), which rustc turns into `vulkan.lib`. The Windows
/// SDK only ships `vulkan-1.lib`, so the final link fails with LNK1181. Copy it under
/// the name the manifest asks for and point the linker at the copy.
/// ponytail: alias instead of a patched fork — drop this once upstream records the
/// imported target's real path.
fn alias_vulkan_import_lib_for_msvc() {
    if std::env::var_os("CARGO_FEATURE_VULKAN").is_none()
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let sdk = std::env::var("VULKAN_SDK").expect("VULKAN_SDK must be set to build with --features vulkan");
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let source = std::path::Path::new(&sdk).join("Lib").join("vulkan-1.lib");
    let alias = std::path::Path::new(&out_dir).join("vulkan.lib");

    std::fs::copy(&source, &alias)
        .unwrap_or_else(|e| panic!("copy {} -> {}: {e}", source.display(), alias.display()));
    println!("cargo:rustc-link-search=native={out_dir}");
}

/// Detects GPU acceleration capabilities and provides build guidance
fn detect_and_report_gpu_capabilities() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    println!("cargo:warning=🚀 Building Conversationaly for: {}", target_os);

    match target_os.as_str() {
        "macos" => {
            // No CoreML line: `coreml` was dropped as a feature (Cargo.toml, "Dropped vs
            // the whisper-rs era") because transcribe.cpp has no CoreML path and Metal
            // covers Apple Silicon. The `#[cfg(feature = "coreml")]` that used to guard a
            // message here named a feature nothing declares, so rustc reported it as
            // `unexpected_cfgs` on every build — and that one warning is what stopped
            // `-D warnings` from ever reaching the rest of the crate.
            println!("cargo:warning=✅ macOS: Metal GPU acceleration ENABLED by default");
        }
        "windows" => {
            if cfg!(feature = "cuda") {
                println!("cargo:warning=✅ Windows: CUDA GPU acceleration ENABLED");
            } else if cfg!(feature = "vulkan") {
                println!("cargo:warning=✅ Windows: Vulkan GPU acceleration ENABLED");
            } else {
                println!("cargo:warning=⚠️  Windows: Using CPU-only mode (no GPU acceleration)");
                println!("cargo:warning=💡 For NVIDIA GPU: cargo build --release --features cuda");
                println!("cargo:warning=💡 For AMD/Intel GPU: cargo build --release --features vulkan");
                println!("cargo:warning=💡 For CPU threading: cargo build --release --features openmp");

                // Try to detect NVIDIA GPU
                if which::which("nvidia-smi").is_ok() {
                    println!("cargo:warning=🎯 NVIDIA GPU detected! Consider rebuilding with --features cuda");
                }
            }
        }
        "linux" => {
            if cfg!(feature = "cuda") {
                println!("cargo:warning=✅ Linux: CUDA GPU acceleration ENABLED");
            } else if cfg!(feature = "vulkan") {
                println!("cargo:warning=✅ Linux: Vulkan GPU acceleration ENABLED");
            } else if cfg!(feature = "rocm") {
                println!("cargo:warning=✅ Linux: AMD ROCm (HIP) acceleration ENABLED");
            } else {
                println!("cargo:warning=⚠️  Linux: Using CPU-only mode (no GPU acceleration)");
                println!("cargo:warning=💡 For NVIDIA GPU: cargo build --release --features cuda");
                println!("cargo:warning=💡 For AMD GPU: cargo build --release --features rocm");
                println!("cargo:warning=💡 For other GPUs: cargo build --release --features vulkan");
                println!("cargo:warning=💡 For CPU threading: cargo build --release --features openmp");

                // Try to detect NVIDIA GPU
                if which::which("nvidia-smi").is_ok() {
                    println!("cargo:warning=🎯 NVIDIA GPU detected! Consider rebuilding with --features cuda");
                }

                // Try to detect AMD GPU
                if which::which("rocm-smi").is_ok() {
                    println!("cargo:warning=🎯 AMD GPU detected! Consider rebuilding with --features rocm");
                }
            }
        }
        _ => {
            println!("cargo:warning=ℹ️  Unknown platform: {}", target_os);
        }
    }

    // Performance guidance
    if !cfg!(feature = "cuda") && !cfg!(feature = "vulkan") && !cfg!(feature = "rocm") && target_os != "macos" {
        println!("cargo:warning=📊 Performance: CPU-only builds are significantly slower than GPU builds");
        println!("cargo:warning=📚 See README.md for GPU setup instructions");
    }
}
