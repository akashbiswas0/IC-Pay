#!/bin/bash
# Build the official World IDKit core and UniFFI bindings; no Rust/proof patches.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SHA="16bc527f52ec297a041fed9debfa6d17dea5ed28"
SOURCE_URL="https://github.com/worldcoin/idkit.git"
TOOLCHAIN="1.95.0"
BUILD_ROOT="$PROJECT_ROOT/.build/world-idkit"
SOURCE_DIR="$BUILD_ROOT/source"
PACKAGE_DIR="$PROJECT_ROOT/apps/ios/Vendor/IDKit"
mkdir -p "$BUILD_ROOT" "$(dirname "$PACKAGE_DIR")"

for command in git rustup cargo xcodebuild swift shasum; do
  command -v "$command" >/dev/null || { printf 'Required tool is missing: %s\n' "$command" >&2; exit 1; }
done
if [ "$(uname -m)" != "arm64" ]; then
  printf 'This package build targets Apple Silicon hosts and arm64 Apple devices only.\n' >&2
  exit 1
fi
if [ ! -d "$SOURCE_DIR/.git" ]; then
  if [ -e "$SOURCE_DIR" ]; then
    printf 'Refusing to replace an existing non-Git source directory: %s\n' "$SOURCE_DIR" >&2
    exit 1
  fi
  git init -q "$SOURCE_DIR"
  git -C "$SOURCE_DIR" remote add origin "$SOURCE_URL"
  git -C "$SOURCE_DIR" fetch --depth 1 origin "$SOURCE_SHA"
  git -C "$SOURCE_DIR" checkout --detach "$SOURCE_SHA"
fi
if [ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" != "$SOURCE_SHA" ] || ! git -C "$SOURCE_DIR" diff --quiet HEAD; then
  printf 'Source checkout must be clean and pinned to %s. No source was changed.\n' "$SOURCE_SHA" >&2
  exit 1
fi
if [ -e "$PACKAGE_DIR" ] && [ ! -f "$PACKAGE_DIR/.source-built-idkit" ]; then
  printf 'Refusing to replace an unmarked vendor directory: %s\n' "$PACKAGE_DIR" >&2
  exit 1
fi
rustup toolchain install "$TOOLCHAIN" --profile minimal --no-self-update
rustup target add --toolchain "$TOOLCHAIN" aarch64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim
export CARGO_TARGET_DIR="$BUILD_ROOT/target"
export CARGO_PROFILE_RELEASE_STRIP=none
export IPHONEOS_DEPLOYMENT_TARGET=13.0
export MACOSX_DEPLOYMENT_TARGET=12.0
export RUSTFLAGS="-C link-arg=-Wl,-application_extension -C link-arg=-Wl,-dead_strip -C link-arg=-Wl,-dead_strip_dylibs"
cd "$SOURCE_DIR"

# Generate bindings from an unstripped macOS dylib so UniFFI metadata survives.
printf 'Building upstream IDKit %s for macOS arm64.\n' "$SOURCE_SHA"
cargo "+$TOOLCHAIN" build --package idkit-core --target aarch64-apple-darwin --release --locked --features uniffi-bindings
STAGE="$(mktemp -d "$BUILD_ROOT/stage.XXXXXX")"
mkdir -p "$STAGE/bindings" "$STAGE/Headers" "$STAGE/package/Sources/IDKit/Generated"
cargo "+$TOOLCHAIN" run --locked --package uniffi-bindgen -- generate \
  --library "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/libidkit.dylib" \
  --language swift --no-format --out-dir "$STAGE/bindings"
if ! grep -q 'sybilScore' "$STAGE/bindings/idkit_core.swift"; then
  printf 'Generated Swift bindings are missing sybilScore; refusing to package.\n' >&2
  exit 1
fi
printf 'Generated Swift bindings preserve sybilScore. Building physical iOS and simulator.\n'
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo "+$TOOLCHAIN" build --package idkit-core --target "$target" --release --locked --features uniffi-bindings
done

cp "$STAGE/bindings/idkit_coreFFI.h" "$STAGE/Headers/"
cp "$STAGE/bindings/idkit_coreFFI.modulemap" "$STAGE/Headers/module.modulemap"
for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin; do
  mkdir -p "$STAGE/$target"
  cp "$CARGO_TARGET_DIR/$target/release/libidkit.a" "$STAGE/$target/libidkitFFI.a"
  # Match the upstream packaging strip step only on copied static libraries.
  xcrun strip -S -x "$STAGE/$target/libidkitFFI.a"
done
xcodebuild -create-xcframework \
  -library "$STAGE/aarch64-apple-ios/libidkitFFI.a" -headers "$STAGE/Headers" \
  -library "$STAGE/aarch64-apple-ios-sim/libidkitFFI.a" -headers "$STAGE/Headers" \
  -library "$STAGE/aarch64-apple-darwin/libidkitFFI.a" -headers "$STAGE/Headers" \
  -output "$STAGE/package/IDKitFFI.xcframework"
cp -R "$SOURCE_DIR/swift/Sources/IDKit/." "$STAGE/package/Sources/IDKit/"
cp "$STAGE/bindings/idkit_core.swift" "$STAGE/package/Sources/IDKit/Generated/"
cp "$STAGE/bindings/idkit_coreFFI.h" "$STAGE/package/Sources/IDKit/Generated/"
cp "$STAGE/bindings/idkit_coreFFI.modulemap" "$STAGE/package/Sources/IDKit/Generated/"
cp "$SOURCE_DIR/LICENSE" "$STAGE/package/LICENSE"
printf '%s\n' "$SOURCE_SHA" > "$STAGE/package/.source-built-idkit"
cat > "$STAGE/package/.gitignore" <<'IGNORE'
.build/
IDKitFFI.xcframework/
IGNORE
cat > "$STAGE/package/Package.swift" <<'SWIFT'
// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "IDKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "IDKit", targets: ["IDKit"])],
    targets: [
        .binaryTarget(name: "idkitFFI", path: "IDKitFFI.xcframework"),
        .target(
            name: "IDKit",
            dependencies: ["idkitFFI"],
            path: "Sources/IDKit",
            exclude: ["Generated/idkit_coreFFI.h", "Generated/idkit_coreFFI.modulemap"]
        ),
    ]
)
SWIFT
cat > "$STAGE/package/README.md" <<'README'
# Source-built World IDKit for Apple Silicon

This is a local source build of the official [worldcoin/idkit](https://github.com/worldcoin/idkit) repository at commit `16bc527f52ec297a041fed9debfa6d17dea5ed28`, using the upstream Rust **1.95.0** toolchain and locked Cargo dependencies. It is not the prebuilt Swift 4.0.11 release. The upstream `IDKit.version` telemetry string remains unchanged; `.source-built-idkit` and `BUILD-INFO.txt` identify the actual source build.

The Rust core and Swift wrapper are copied without modification. Swift UniFFI bindings are regenerated from the unstripped macOS dylib and include the upstream Selfie Check `sybilScore` fields. No score, proof, nonce, or integrity data is synthesized. The application uses the public generated `IdKitBuilder` / `IdKitSessionConfig` interface because the upstream convenience session wrappers remain commented out.

## Rebuild

From the repository root, run `bash scripts/build-world-native.sh`. It fetches the exact commit into `.build/world-idkit/source`, installs the pinned Rust toolchain and Apple targets if needed, builds the unmodified core with `--locked --features uniffi-bindings`, regenerates bindings with upstream `uniffi-bindgen`, assembles the XCFramework, and compiles this Swift package. Xcode command-line tools and Apple Silicon are required.

Supported slices: **arm64 iOS device, arm64 iOS Simulator, arm64 macOS**. Intel simulator and Intel Mac slices are intentionally absent. iOS deployment floor is 15.0 for the Swift package; macOS floor is 12.0. The package product and module are both `IDKit`.

`IDKitFFI.xcframework` contains locally built binaries and is ignored by Git. Generated Swift bindings, headers, the wrapper, package manifest, and upstream MIT license are retained. Run the build script after a clean checkout before opening the Xcode app project. Existing marked vendor builds are moved into `.build/world-idkit` before replacement; unknown vendor directories are never deleted.

The build process follows upstream `scripts/package-swift.sh`, narrowed to the three arm64 targets. `CARGO_PROFILE_RELEASE_STRIP=none` preserves metadata for binding generation; only copied static libraries are stripped afterward. The Swift package omits upstream test fixtures and only declares the local binary target plus official Swift sources.
README
{
  printf 'Source: %s\nCommit: %s\nBuild identifier: source-built-%s\n' "$SOURCE_URL" "$SOURCE_SHA" "$SOURCE_SHA"
  rustc "+$TOOLCHAIN" --version
  xcodebuild -version
  printf 'Upstream locked inputs:\n'
  shasum -a 256 Cargo.lock rust/core/src/types.rs swift/Sources/IDKit/IDKit.swift
  printf 'Generated Swift:\n'
  (cd "$STAGE/package" && shasum -a 256 Sources/IDKit/Generated/idkit_core.swift)
} > "$STAGE/package/BUILD-INFO.txt"
if ! git -C "$SOURCE_DIR" diff --quiet HEAD; then
  printf 'Upstream tracked sources changed during the build; refusing installation.\n' >&2
  exit 1
fi
if [ -d "$PACKAGE_DIR" ]; then
  mv "$PACKAGE_DIR" "$BUILD_ROOT/previous-package-$(date +%s)-$$"
fi
mv "$STAGE/package" "$PACKAGE_DIR"
printf 'Vendor package assembled at %s. Compiling the Swift module.\n' "$PACKAGE_DIR"
swift build --package-path "$PACKAGE_DIR" --scratch-path "$BUILD_ROOT/swift-macos"
printf 'World IDKit source package and Swift module are ready.\n'
