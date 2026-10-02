#!/usr/bin/env sh
set -eu

command -v rsvg-convert >/dev/null
command -v iconutil >/dev/null

rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
rsvg-convert -w 2048 -h 2048 icon.svg -o icon@2x.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -a -w 22 -h 22 saygm-mark.svg -o iconTemplate.png
rsvg-convert -a -w 44 -h 44 saygm-mark.svg -o iconTemplate@2x.png
cp iconTemplate.png iconTemplateUpdate.png
cp iconTemplate@2x.png iconTemplateUpdate@2x.png

mkdir -p icon.iconset
rsvg-convert -w 16 -h 16 icon.svg -o icon.iconset/icon_16x16.png
rsvg-convert -w 32 -h 32 icon.svg -o icon.iconset/icon_16x16@2x.png
rsvg-convert -w 32 -h 32 icon.svg -o icon.iconset/icon_32x32.png
rsvg-convert -w 64 -h 64 icon.svg -o icon.iconset/icon_32x32@2x.png
rsvg-convert -w 128 -h 128 icon.svg -o icon.iconset/icon_128x128.png
rsvg-convert -w 256 -h 256 icon.svg -o icon.iconset/icon_128x128@2x.png
rsvg-convert -w 256 -h 256 icon.svg -o icon.iconset/icon_256x256.png
rsvg-convert -w 512 -h 512 icon.svg -o icon.iconset/icon_256x256@2x.png
rsvg-convert -w 512 -h 512 icon.svg -o icon.iconset/icon_512x512.png
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.iconset/icon_512x512@2x.png
iconutil -c icns -o icon.icns icon.iconset

node <<'NODE'
const fs = require('node:fs');
const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((size) => {
  const path = `icon.ico-${size}.png`;
  require('node:child_process').execFileSync('rsvg-convert', [
    '-w', String(size), '-h', String(size), 'icon.svg', '-o', path,
  ]);
  return { size, path, data: fs.readFileSync(path) };
});

let offset = 6 + images.length * 16;
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
images.forEach(({ size, data }, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header[entry + 2] = 0;
  header[entry + 3] = 0;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += data.length;
});

fs.writeFileSync('icon.ico', Buffer.concat([header, ...images.map(({ data }) => data)]));
images.forEach(({ path }) => fs.unlinkSync(path));
NODE

rm -rf icon.iconset
