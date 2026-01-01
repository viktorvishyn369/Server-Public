#!/bin/bash

# Regenerate all server-tray app icons from source
SOURCE_ICON="assets/icon-source.png"
ASSETS_DIR="assets"

echo "Regenerating server-tray app icons from $SOURCE_ICON..."

# Check if source icon exists
if [ ! -f "$SOURCE_ICON" ]; then
    echo "⚠ Source icon not found: $SOURCE_ICON"
    echo "Creating from existing icon.png..."
    SOURCE_ICON="icon.png"
fi

# Main app icon (1024x1024 with transparency preserved)
magick "$SOURCE_ICON" -resize 1024x1024 "icon.png"

# macOS tray icons (template images - monochrome with transparency)
# Template icons should be black/transparent for proper theme adaptation
mkdir -p "$ASSETS_DIR/mac"
magick "$SOURCE_ICON" -resize 16x16 -colorspace Gray "$ASSETS_DIR/mac/iconTemplate.png"
magick "$SOURCE_ICON" -resize 32x32 -colorspace Gray "$ASSETS_DIR/mac/iconTemplate@2x.png"
magick "$SOURCE_ICON" -resize 48x48 -colorspace Gray "$ASSETS_DIR/mac/iconTemplate@3x.png"

# macOS app icons (regular with transparency)
magick "$SOURCE_ICON" -resize 16x16 "$ASSETS_DIR/mac/icon.png"
magick "$SOURCE_ICON" -resize 32x32 "$ASSETS_DIR/mac/icon@2x.png"

# Windows tray icons (with transparency)
mkdir -p "$ASSETS_DIR/win"
magick "$SOURCE_ICON" -resize 16x16 "$ASSETS_DIR/win/icon-16.png"
magick "$SOURCE_ICON" -resize 24x24 "$ASSETS_DIR/win/icon-24.png"
magick "$SOURCE_ICON" -resize 32x32 "$ASSETS_DIR/win/icon-32.png"
magick "$SOURCE_ICON" -resize 48x48 "$ASSETS_DIR/win/icon-48.png"
magick "$SOURCE_ICON" -resize 64x64 "$ASSETS_DIR/win/icon-64.png"
magick "$SOURCE_ICON" -resize 256x256 "$ASSETS_DIR/win/icon-256.png"
magick "$SOURCE_ICON" -resize 256x256 "$ASSETS_DIR/win/icon.png"

# Linux tray icons (with transparency)
mkdir -p "$ASSETS_DIR/linux"
magick "$SOURCE_ICON" -resize 16x16 "$ASSETS_DIR/linux/icon-16.png"
magick "$SOURCE_ICON" -resize 24x24 "$ASSETS_DIR/linux/icon-24.png"
magick "$SOURCE_ICON" -resize 32x32 "$ASSETS_DIR/linux/icon-32.png"
magick "$SOURCE_ICON" -resize 48x48 "$ASSETS_DIR/linux/icon-48.png"
magick "$SOURCE_ICON" -resize 64x64 "$ASSETS_DIR/linux/icon-64.png"
magick "$SOURCE_ICON" -resize 128x128 "$ASSETS_DIR/linux/icon-128.png"
magick "$SOURCE_ICON" -resize 256x256 "$ASSETS_DIR/linux/icon-256.png"
magick "$SOURCE_ICON" -resize 512x512 "$ASSETS_DIR/linux/icon.png"

echo "✓ All server-tray icons regenerated with transparency preserved"
echo "  • macOS template icons are grayscale for proper theme adaptation"
echo "  • All other icons preserve transparency for adaptive backgrounds"
