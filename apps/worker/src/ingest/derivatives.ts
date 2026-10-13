import {
  DERIVATIVE_JPEG_QUALITY,
  DERIVATIVE_LONG_EDGE,
  type DerivativeKind,
  type ImageDerivativeKind,
} from "@tinyglow/shared";
import { type DecodedSource, DecodeError } from "./decode";

// Derivatives (docs/plans/step-4.md 2.7 step 7; PRD FR-4.4, FR-5.1, FR-6.1, "Image compression
// for the model"). Every output is a progressive mozjpeg JPEG, q75, sRGB, with NO metadata of any
// kind: sharp drops EXIF/XMP/IPTC/ICC unless a metadata-keeping call is chained, and none ever is
// in this worker (a unit test and a CI grep enforce that). Transparent inputs are flattened onto
// white (JPEG has no alpha). Step 12: a video's poster frame goes through the same three sizes,
// and its keyframes are rendered at the `analysis` size and relabelled `keyframe1..3`
// (`VIDEO_KEYFRAME_LONG_EDGE` = `DERIVATIVE_LONG_EDGE.analysis`); the `web` rendition is ffmpeg's.

export interface RenderedDerivative {
  kind: DerivativeKind;
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/** Render one image derivative: long edge `DERIVATIVE_LONG_EDGE[kind]`, never enlarged. */
export async function renderDerivative(
  source: DecodedSource,
  kind: ImageDerivativeKind,
): Promise<RenderedDerivative> {
  const edge = DERIVATIVE_LONG_EDGE[kind];
  try {
    const { data, info } = await source
      .pipeline()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({ quality: DERIVATIVE_JPEG_QUALITY, mozjpeg: true, progressive: true })
      .toBuffer({ resolveWithObject: true });
    return { kind, buffer: data, width: info.width, height: info.height, bytes: data.byteLength };
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    throw new DecodeError("render_failed");
  }
}
