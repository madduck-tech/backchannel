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

    link_vulkan_sdk_for_msvc();

    // Download and bundle FFmpeg binary at build-time
    ffmpeg::ensure_ffmpeg_binary();

    tauri_build::build()
}

/// Point the MSVC linker at the Vulkan SDK's import libraries.
///
/// From transcribe.cpp v0.4.1 the link manifest names the Windows loader `vulkan-1`
/// (`cmake/transcribe-install.cmake`), but the -sys crate emits the name without a search
/// directory. The SDK's `Lib` is not on the runner's default path, so the link died with
/// LNK1181 on `vulkan-1.lib` (#169, measured on the dispatched Windows build). Before v0.4.1
/// the manifest said `vulkan`, and this function copied `vulkan-1.lib` to `vulkan.lib`; that
/// alias is gone with the name it stood in for.
fn link_vulkan_sdk_for_msvc() {
    if std::env::var_os("CARGO_FEATURE_VULKAN").is_none()
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let sdk = std::env::var("VULKAN_SDK").expect("VULKAN_SDK must be set to build with --features vulkan");
    let lib = std::path::Path::new(&sdk).join("Lib");
    assert!(
        lib.join("vulkan-1.lib").is_file(),
        "{} has no vulkan-1.lib; is VULKAN_SDK the SDK's root?",
        lib.display()
    );
    println!("cargo:rustc-link-search=native={}", lib.display());
}

/// Detects GPU acceleration capabilities and provides build guidance
fn detect_and_report_gpu_capabilities() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    println!("cargo:warning=🚀 Building Backchannel for: {}", target_os);

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
