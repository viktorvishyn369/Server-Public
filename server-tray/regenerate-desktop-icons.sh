#!/bin/bash

# Desktop App Icon Regeneration Script
# Regenerates platform-specific icons from source icon.png

SOURCE_ICON="assets/icon.png"

echo "🔄 Regenerating desktop app icons from $SOURCE_ICON..."

# macOS icons
echo "📱 Generating macOS icons..."
magick "$SOURCE_ICON" -resize 16x16 "assets/mac/icon.png"
magick "$SOURCE_ICON" -resize 32x32 "assets/mac/icon@2x.png"
magick "$SOURCE_ICON" -resize 16x16 -colorspace Gray "assets/mac/iconTemplate.png"
magick "$SOURCE_ICON" -resize 32x32 -colorspace Gray "assets/mac/iconTemplate@2x.png"
magick "$SOURCE_ICON" -resize 48x48 -colorspace Gray "assets/mac/iconTemplate@3x.png"
cp "assets/mac/iconTemplate.png" "iconTemplate.png"
cp "assets/mac/iconTemplate@2x.png" "iconTemplate@2x.png"

# Windows icons
echo "🪟 Generating Windows icons..."
magick "$SOURCE_ICON" -resize 16x16 "assets/win/icon-16.png"
magick "$SOURCE_ICON" -resize 24x24 "assets/win/icon-24.png"
magick "$SOURCE_ICON" -resize 32x32 "assets/win/icon-32.png"
magick "$SOURCE_ICON" -resize 48x48 "assets/win/icon-48.png"
magick "$SOURCE_ICON" -resize 64x64 "assets/win/icon-64.png"
magick "$SOURCE_ICON" -resize 256x256 "assets/win/icon-256.png"
cp "assets/win/icon-256.png" "assets/win/icon.png"
cp "assets/win/icon-256.png" "icon.png"

# Linux icons
echo "🐧 Generating Linux icons..."
magick "$SOURCE_ICON" -resize 16x16 "assets/linux/icon-16.png"
magick "$SOURCE_ICON" -resize 24x24 "assets/linux/icon-24.png"
magick "$SOURCE_ICON" -resize 32x32 "assets/linux/icon-32.png"
magick "$SOURCE_ICON" -resize 48x48 "assets/linux/icon-48.png"
magick "$SOURCE_ICON" -resize 64x64 "assets/linux/icon-64.png"
magick "$SOURCE_ICON" -resize 128x128 "assets/linux/icon-128.png"
magick "$SOURCE_ICON" -resize 256x256 "assets/linux/icon-256.png"
cp "assets/linux/icon-256.png" "assets/linux/icon.png"
cp "$SOURCE_ICON" "assets/mac/icon-source.png"
cp "$SOURCE_ICON" "assets/win/icon-source.png"
cp "$SOURCE_ICON" "assets/linux/icon-source.png"

echo "✅ All desktop icons regenerated!"
echo "📦 Ready for building desktop apps with updated icons"
