import {
  DERIVATIVE_JPEG_QUALITY,
  DERIVATIVE_LONG_EDGE,
  type DerivativeKind,
} from "@tinyglow/shared";
import { type DecodedSource, DecodeError } from "./decode";

// Derivatives (docs/plans/step-4.md 2.7 step 7; PRD FR-4.4, FR-5.1, FR-6.1, "Image compression
// for the model"). Every output is a progressive mozjpeg JPEG, q75, sRGB, with NO metadata of any
// kind: sharp drops EXIF/XMP/IPTC/ICC unless a metadata-keeping call is chained, and none ever is
// in this worker (a unit test and a CI grep enforce that). Transparent inputs are flattened onto
// white (JPEG has no alpha).

export interface RenderedDerivative {
  kind: DerivativeKind;
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/** Render one derivative: long edge `DERIVATIVE_LONG_EDGE[kind]`, never enlarged. */
export async function renderDerivative(
  source: DecodedSource,
  kind: DerivativeKind,
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
