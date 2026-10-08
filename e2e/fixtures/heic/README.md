# HEIC fixtures

Synthetic gradient images (white bar, red circle, blue triangle; no people, no real photos), so
there is no licence or privacy question. Generated once on macOS and committed (5-7 KB each).
Used by `apps/worker/src/ingest/*.test.ts` and `e2e/upload/gate.ts`.

| File | Content |
| --- | --- |
| `plain-640x480.heic` | 640x480, no EXIF |
| `portrait-480x640.heic` | 480x640 (asymmetric content, to detect rotation errors) |
| `gps-640x480.heic` | 640x480, GPS 47.6062 N / 122.3321 W (Seattle) |
| `datetime-tz.heic` | 640x480, DateTimeOriginal 2026-06-14 15:04:05 with OffsetTimeOriginal -07:00 (= 22:04:05Z) |
| `heif-mif1.heif` | 640x480, different pixels, major brand patched to `mif1` (`sips` writes `heic`) |

## Regenerate

From the repo root (needs macOS `sips`, Node with the root `sharp`, and Docker for exiftool):

```sh
mkdir -p /tmp/ll-heic-src
node --input-type=module -e "$(cat <<'JS'
import sharp from "sharp";
const out = process.argv.at(-1);
const svg = (w, h, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,60%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},60%,35%)"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="0" y="0" width="${w * 0.3}" height="${h * 0.15}" fill="#fff"/>
  <circle cx="${w * 0.75}" cy="${h * 0.7}" r="${Math.min(w, h) * 0.18}" fill="#e63946"/>
  <polygon points="${w * 0.1},${h * 0.9} ${w * 0.3},${h * 0.5} ${w * 0.45},${h * 0.9}" fill="#1d3557"/></svg>`;
for (const [name, w, h, hue] of [["plain", 640, 480, 200], ["portrait", 480, 640, 30], ["gps", 640, 480, 120], ["datetime", 640, 480, 300], ["mif1", 640, 480, 60]]) {
  await sharp(Buffer.from(svg(w, h, hue))).jpeg({ quality: 70 }).toFile(`${out}/${name}.jpg`);
}
JS
)" /tmp/ll-heic-src

D=e2e/fixtures/heic
sips -s format heic /tmp/ll-heic-src/plain.jpg    --out $D/plain-640x480.heic
sips -s format heic /tmp/ll-heic-src/portrait.jpg --out $D/portrait-480x640.heic
sips -s format heic /tmp/ll-heic-src/gps.jpg      --out $D/gps-640x480.heic
sips -s format heic /tmp/ll-heic-src/datetime.jpg --out $D/datetime-tz.heic
sips -s format heic /tmp/ll-heic-src/mif1.jpg     --out $D/heif-mif1.heif
printf 'mif1' | dd of=$D/heif-mif1.heif bs=1 seek=8 conv=notrunc   # ftyp major brand heic -> mif1

docker run --rm -v "$PWD/$D:/w" -w /w alpine:3.22 sh -c 'apk add --no-cache exiftool >/dev/null &&
  exiftool -overwrite_original -GPSLatitude=47.6062 -GPSLatitudeRef=N -GPSLongitude=122.3321 -GPSLongitudeRef=W gps-640x480.heic &&
  exiftool -overwrite_original "-DateTimeOriginal=2026:06:14 15:04:05" "-OffsetTimeOriginal=-07:00" datetime-tz.heic'
```

Verify (the host exiftool is not used):

```sh
docker run --rm -v "$PWD/e2e/fixtures/heic:/w" -w /w alpine:3.22 sh -c \
  'apk add --no-cache exiftool >/dev/null && exiftool -G1 -s -GPS:all -DateTimeOriginal -OffsetTimeOriginal -ImageSize -MajorBrand *.heic *.heif'
```
