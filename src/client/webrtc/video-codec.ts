import { parse } from "sdp-transform";

export type BrowserVideoCodec = "h264" | "vp8" | "vp9" | "av1";
export type BrowserVideoCodecMode = "vp8" | "auto" | "h264" | "vp9" | "av1";
/** Scalable codecs publish one stream carrying several spatial layers. */
export function isScalableVideoCodec(codec: BrowserVideoCodec): boolean {
  return codec === "vp9" || codec === "av1";
}

export interface BrowserVideoCodecPreference {
  primary: BrowserVideoCodec;
  /** Ordered codecs an automatic negotiation may select instead. */
  fallbacks: BrowserVideoCodec[];
}

export const VP8_ONLY_VIDEO_CODEC: BrowserVideoCodecPreference = {
  primary: "vp8",
  fallbacks: [],
};

/** Quality-first order: Auto proves candidates in this order, and an automatic
 * negotiation keeps the same tail so a Viewer without the selected codec still
 * negotiates the next best one instead of losing video. */
export const VIDEO_CODEC_QUALITY_ORDER: readonly BrowserVideoCodec[] = [
  "av1",
  "vp9",
  "h264",
  "vp8",
];

export function automaticVideoCodecPreference(
  codec: BrowserVideoCodec,
): BrowserVideoCodecPreference {
  return {
    primary: codec,
    fallbacks: VIDEO_CODEC_QUALITY_ORDER.filter((candidate) => candidate !== codec),
  };
}

export function manualVideoCodecPreference(
  codec: BrowserVideoCodec,
): BrowserVideoCodecPreference {
  return { primary: codec, fallbacks: [] };
}

/** A native sender publishes only H264 or VP8; a scalable share stays Browser-only. */
export function nativeSenderCodec(codec: BrowserVideoCodec): "h264" | "vp8" {
  if (codec === "h264" || codec === "vp8") {
    return codec;
  }
  throw new Error("native sender codec is unavailable");
}

/** The codec this server may forward for one share: the share codec when the
 * server advertises it, otherwise VP8 rather than losing that fallback route. */
export function sfuVideoCodec(
  codec: BrowserVideoCodec,
  supported: readonly BrowserVideoCodec[],
): BrowserVideoCodec {
  return supported.includes(codec) ? codec : "vp8";
}

const REPAIR_CODEC_MIME_TYPES = new Set([
  "video/rtx",
  "video/red",
  "video/ulpfec",
  "video/flexfec-03",
]);

function videoCapabilities(): RTCRtpCodec[] {
  return RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
}

function mimeTypeCodecs(
  codecs: readonly RTCRtpCodec[],
  mimeType: string,
): RTCRtpCodec[] {
  return codecs.filter(
    ({ mimeType: candidate }) => candidate.toLowerCase() === mimeType,
  );
}

function h264ModeOneCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType, sdpFmtpLine }) => {
    if (mimeType.toLowerCase() !== "video/h264") {
      return false;
    }
    return (
      !sdpFmtpLine ||
      /(?:^|;)\s*packetization-mode=1(?:;|$)/i.test(sdpFmtpLine)
    );
  });
}

function codecsFor(
  codec: BrowserVideoCodec,
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  switch (codec) {
    case "h264":
      return h264ModeOneCodecs(codecs);
    case "vp8":
      return mimeTypeCodecs(codecs, "video/vp8");
    case "vp9":
      return mimeTypeCodecs(codecs, "video/vp9");
    case "av1":
      return mimeTypeCodecs(codecs, "video/av1");
  }
}

export function supportsVideoCodecSend(codec: BrowserVideoCodec): boolean {
  return typeof RTCRtpSender !== "undefined" &&
    codecsFor(codec, videoCapabilities()).length > 0;
}

export function supportsH264Receive(): boolean {
  return typeof RTCRtpReceiver !== "undefined" &&
    h264ModeOneCodecs(RTCRtpReceiver.getCapabilities?.("video")?.codecs ?? []).length > 0;
}

function repairCodecs(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] {
  return codecs.filter(({ mimeType }) =>
    REPAIR_CODEC_MIME_TYPES.has(mimeType.toLowerCase()),
  );
}

function applyCodecs(
  transceiver: RTCRtpTransceiver,
  codecs: RTCRtpCodec[],
): boolean {
  if (typeof transceiver.setCodecPreferences !== "function") {
    return false;
  }
  try {
    transceiver.setCodecPreferences(codecs);
    return true;
  } catch {
    return false;
  }
}

export function applyVideoCodecPreference(
  transceiver: RTCRtpTransceiver,
  preference: BrowserVideoCodecPreference,
): boolean {
  if (typeof RTCRtpSender === "undefined") {
    return false;
  }
  const codecs = videoCapabilities();
  const primary = codecsFor(preference.primary, codecs);
  if (primary.length === 0) {
    return false;
  }
  const ordered = [primary];
  for (const fallback of preference.fallbacks) {
    const group = codecsFor(fallback, codecs);
    if (group.length > 0) ordered.push(group);
  }
  return applyCodecs(transceiver, [...ordered.flat(), ...repairCodecs(codecs)]);
}

/** Restrict one probe connection to the candidate codec being measured. */
export function applyProbeCodec(
  transceiver: RTCRtpTransceiver,
  codec: BrowserVideoCodec,
): boolean {
  if (typeof RTCRtpSender === "undefined") {
    return false;
  }
  const codecs = videoCapabilities();
  const selected = codecsFor(codec, codecs);
  return selected.length > 0 &&
    applyCodecs(transceiver, [...selected, ...repairCodecs(codecs)]);
}

/** Remove only attributes of codecs excluded from a locally generated offer.
 * Firefox can retain them after setCodecPreferences (Mozilla bug 1909443),
 * making the whole offer unparseable in Chromium. Do not rewrite codec choices,
 * valid feedback, unknown attributes or answers with asymmetric payload types.
 */
export function normalizeVideoOfferSdp(sdp: string): string {
  let payloads: Set<number> | null = null;
  let changed = false;
  const lines = sdp.split(/\r?\n/).filter(line => {
    if (line.startsWith("m=")) {
      const fields = line.trim().split(/\s+/);
      payloads = fields[0] === "m=video" && fields.length >= 4
        ? new Set(fields.slice(3).map(Number)) : null;
    }
    const attribute = /^a=(?:fmtp|rtcp-fb):(\d+)(?:\s|$)/.exec(line);
    if (payloads && attribute && !payloads.has(Number(attribute[1]))) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? lines.join(sdp.includes("\r\n") ? "\r\n" : "\n") : sdp;
}

export class VideoReceiveRejectedError extends Error {
  constructor() { super("Browser rejected the offered video"); }
}

// JSEP rejects a media section with port zero. Let the Browser negotiate codecs;
// reject only an answer that explicitly declines every offered sending video.
export function requireReceivingVideo(
  offer: RTCSessionDescriptionInit,
  answer: RTCSessionDescriptionInit,
): void {
  if (offer.type !== "offer" || answer.type !== "answer" || !offer.sdp || !answer.sdp) return;
  const remote = parse(offer.sdp), local = parse(answer.sdp);
  const sendingVideo = remote.media.flatMap((media, index) => {
    const direction = media.direction ?? remote.direction;
    return media.type === "video" && (media.port !== 0 || media.bundleOnly !== undefined) &&
      direction !== "inactive" && direction !== "recvonly" ? [index] : [];
  });
  if (sendingVideo.length > 0 && sendingVideo.every(index =>
    local.media[index]?.type === "video" && local.media[index]?.port === 0,
  )) throw new VideoReceiveRejectedError();
}
