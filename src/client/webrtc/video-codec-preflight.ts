import {
  configureVideoSender,
  startupVideoProfile,
  type QualityProfile,
} from "../media/quality";
import {
  applyProbeCodec,
  normalizeVideoOfferSdp,
  supportsVideoCodecSend,
  VIDEO_CODEC_QUALITY_ORDER,
  type BrowserVideoCodec,
} from "./video-codec";
import { addRemoteIceCandidate } from "./nat-prediction";
import { mediaSourceRecord } from "./stats";

// One codec probe keeps its own budget; the whole ladder shares a larger one so
// a machine that cannot encode the top candidate still answers in finite time.
const PREFLIGHT_DEADLINE_MS = 4_000;
const PREFLIGHT_TOTAL_DEADLINE_MS = 10_000;
const PREFLIGHT_MIN_BUDGET_MS = 1_200;
const PREFLIGHT_POLL_MS = 100;
const PREFLIGHT_WARMUP_MS = 500;
const PREFLIGHT_MEASUREMENT_MS = 1_000;

export interface ProbeTarget {
  width: number;
  height: number;
  frameRate: number;
}

interface ProbeTrack {
  track: MediaStreamTrack;
  stop: () => void;
}

export interface ProbeSample {
  outboundId: string;
  sourceId: string;
  timestamp: number;
  codec: string;
  framesEncoded: number | null;
  sourceFrames: number | null;
  encodedFramesPerSecond: number | null;
  sourceFramesPerSecond: number | null;
  qualityLimitationReason: string | null;
}

type StatsRecord = RTCStats & Record<string, unknown>;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function evenDimension(value: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(2, Math.round(value / 2) * 2));
}

export function probeTarget(
  settings: MediaTrackSettings,
  profile: QualityProfile,
): ProbeTarget {
  const ceiling = profile.resolution;
  const sourceWidth = positiveNumber(settings.width, ceiling.width);
  const sourceHeight = positiveNumber(settings.height, ceiling.height);
  const scale = Math.max(
    sourceWidth / ceiling.width,
    sourceHeight / ceiling.height,
    1,
  );
  return {
    width: evenDimension(sourceWidth / scale, ceiling.width),
    height: evenDimension(sourceHeight / scale, ceiling.height),
    frameRate: profile.maxFramerate,
  };
}

function drawProbeFrame(
  context: CanvasRenderingContext2D,
  target: ProbeTarget,
  frame: number,
): void {
  const columns = 24;
  const rows = 14;
  const tileWidth = Math.ceil(target.width / columns);
  const tileHeight = Math.ceil(target.height / rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const hue = (frame * 29 + row * 71 + column * 43) % 360;
      const lightness = 35 + ((frame + row + column) % 30);
      context.fillStyle = `hsl(${hue} 80% ${lightness}%)`;
      context.fillRect(
        column * tileWidth,
        row * tileHeight,
        tileWidth,
        tileHeight,
      );
    }
  }
  const sweep =
    (frame * Math.max(8, Math.floor(target.width / 120))) % target.width;
  context.fillStyle = "#ffffff";
  context.fillRect(
    sweep,
    0,
    Math.max(4, Math.floor(target.width / 180)),
    target.height,
  );
}

function createProbeTrack(
  source: MediaStreamTrack,
  profile: QualityProfile,
): ProbeTrack | null {
  if (typeof document === "undefined") {
    return null;
  }
  const target = probeTarget(source.getSettings(), profile);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof canvas.captureStream !== "function") {
    return null;
  }
  const stream = canvas.captureStream(target.frameRate);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    return null;
  }
  track.contentHint = "motion";
  let frame = 1;
  drawProbeFrame(context, target, frame);
  const timer = window.setInterval(() => {
    frame += 1;
    drawProbeFrame(context, target, frame);
  }, 1_000 / target.frameRate);
  return {
    track,
    stop: () => {
      window.clearInterval(timer);
      track.stop();
    },
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordById(
  report: RTCStatsReport,
  id: unknown,
): StatsRecord | null {
  if (typeof id !== "string") {
    return null;
  }
  return (report.get(id) as StatsRecord | undefined) ?? null;
}

function readProbeSample(
  report: RTCStatsReport,
  mimeType: string,
): ProbeSample | null {
  const candidates: StatsRecord[] = [];
  report.forEach((raw) => {
    const record = raw as StatsRecord;
    if (
      record.type === "outbound-rtp" &&
      record.kind === "video" &&
      record.isRemote !== true &&
      finiteNumber(record.framesEncoded) !== null
    ) {
      candidates.push(record);
    }
  });
  if (candidates.length !== 1) {
    return null;
  }
  const outbound = candidates[0]!;
  const codec = recordById(report, outbound.codecId);
  const source = mediaSourceRecord(report, outbound);
  const actual = stringValue(codec?.mimeType);
  if (
    codec?.type !== "codec" ||
    source?.type !== "media-source" ||
    actual?.toLowerCase() !== mimeType
  ) {
    return null;
  }
  return {
    outboundId: outbound.id,
    sourceId: source.id,
    timestamp: finiteNumber(outbound.timestamp) ?? 0,
    codec: actual,
    framesEncoded: finiteNumber(outbound.framesEncoded),
    sourceFrames: finiteNumber(source.frames),
    encodedFramesPerSecond: finiteNumber(outbound.framesPerSecond),
    sourceFramesPerSecond: finiteNumber(source.framesPerSecond),
    qualityLimitationReason: stringValue(outbound.qualityLimitationReason),
  };
}

function allowedFrameLag(targetFrameRate: number): number {
  return Math.max(
    1,
    Math.ceil((targetFrameRate * PREFLIGHT_POLL_MS) / 1_000),
  );
}

export function probeSustainsTarget(
  baseline: ProbeSample,
  current: ProbeSample,
  targetFrameRate: number,
): boolean | null {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp ||
    // A negotiation that fell back to another codec is not this candidate.
    current.codec.toLowerCase() !== baseline.codec.toLowerCase() ||
    current.qualityLimitationReason === "cpu"
  ) {
    return false;
  }
  const elapsedMs = current.timestamp - baseline.timestamp;
  if (elapsedMs < PREFLIGHT_MEASUREMENT_MS) {
    return null;
  }
  const expectedFrames = (targetFrameRate * elapsedMs) / 1_000;
  const frameLag = allowedFrameLag(targetFrameRate);
  if (
    baseline.framesEncoded !== null &&
    current.framesEncoded !== null &&
    baseline.sourceFrames !== null &&
    current.sourceFrames !== null &&
    current.framesEncoded >= baseline.framesEncoded &&
    current.sourceFrames >= baseline.sourceFrames
  ) {
    const encoded = current.framesEncoded - baseline.framesEncoded;
    const source = current.sourceFrames - baseline.sourceFrames;
    return (
      source > 0 && encoded > 0 &&
      source + frameLag >= expectedFrames &&
      encoded + frameLag >= expectedFrames &&
      encoded + frameLag >= source
    );
  }
  if (
    current.encodedFramesPerSecond === null ||
    current.sourceFramesPerSecond === null
  ) {
    return null;
  }
  return (
    current.sourceFramesPerSecond > 0 && current.encodedFramesPerSecond > 0 &&
    current.sourceFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >=
      current.sourceFramesPerSecond
  );
}

function hasProbeWindow(
  baseline: ProbeSample,
  current: ProbeSample,
): boolean {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp
  ) {
    return false;
  }
  return current.timestamp - baseline.timestamp >= PREFLIGHT_WARMUP_MS;
}

async function runCodecProbe(
  track: MediaStreamTrack,
  profile: QualityProfile,
  codec: BrowserVideoCodec,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const senderConnection = new RTCPeerConnection({ iceServers: [] });
  let receiver: RTCPeerConnection | undefined;
  let pollTimer: number | undefined;
  let stopReason: Error | undefined;
  let stop!: (reason: Error) => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = (reason) => {
      stopReason ??= reason;
      reject(stopReason);
    };
  });
  // Closing a PeerConnection need not settle its pending SDP operations.
  // Every await belongs to this one budget, including setup and statistics.
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopReason) throw stopReason;
    const value = await Promise.race([operation(), stopped]);
    if (stopReason) throw stopReason;
    return value;
  };
  const abort = () => stop(new DOMException("Codec probe cancelled", "AbortError"));
  const timer = window.setTimeout(
    () => stop(new Error("Codec probe timed out")), budgetMs,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const receiverConnection = receiver = new RTCPeerConnection({ iceServers: [] });
    // This in-process probe can start encoding as soon as one local pair works;
    // gathering every candidate must not extend the codec decision.
    const senderCandidates: RTCIceCandidate[] = [];
    const receiverCandidates: RTCIceCandidate[] = [];
    let senderRemoteReady = false;
    let receiverRemoteReady = false;
    let iceFailed = false;
    const addCandidate = async (
      target: RTCPeerConnection,
      candidate: RTCIceCandidate,
    ): Promise<void> => {
      try {
        await addRemoteIceCandidate(target, candidate);
      } catch {
        iceFailed = true;
      }
    };
    senderConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      if (receiverRemoteReady) {
        void addCandidate(receiverConnection, event.candidate);
      } else {
        senderCandidates.push(event.candidate);
      }
    });
    receiverConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      if (senderRemoteReady) {
        void addCandidate(senderConnection, event.candidate);
      } else {
        receiverCandidates.push(event.candidate);
      }
    });
    const transceiver = senderConnection.addTransceiver(track, {
      direction: "sendonly",
    });
    if (!applyProbeCodec(transceiver, codec)) {
      return false;
    }
    const mimeType = `video/${codec}`;
    await wait(() => configureVideoSender(
      transceiver.sender,
      startupVideoProfile(profile),
    ));
    const offer = await wait(() => senderConnection.createOffer());
    await wait(() => senderConnection.setLocalDescription(offer));
    await wait(() => receiverConnection.setRemoteDescription(
      { type: "offer", sdp: normalizeVideoOfferSdp(senderConnection.localDescription!.sdp) },
    ));
    receiverRemoteReady = true;
    await wait(() => Promise.all(
      senderCandidates.splice(0).map((candidate) =>
        addCandidate(receiverConnection, candidate),
      ),
    ));
    const answer = await wait(() => receiverConnection.createAnswer());
    await wait(() => receiverConnection.setLocalDescription(answer));
    await wait(() => senderConnection.setRemoteDescription(
      receiverConnection.localDescription!,
    ));
    senderRemoteReady = true;
    await wait(() => Promise.all(
      receiverCandidates.splice(0).map((candidate) =>
        addCandidate(senderConnection, candidate),
      ),
    ));

    let warmupBaseline: ProbeSample | null = null;
    let measurementBaseline: ProbeSample | null = null;
    for (;;) {
      if (signal?.aborted || track.readyState === "ended" || iceFailed) {
        return false;
      }
      const sample = readProbeSample(
        await wait(() => transceiver.sender.getStats()),
        mimeType,
      );
      if (sample) {
        warmupBaseline ??= sample;
        if (
          !measurementBaseline &&
          sample !== warmupBaseline &&
          hasProbeWindow(warmupBaseline, sample)
        ) {
          measurementBaseline = sample;
        } else if (measurementBaseline && sample !== measurementBaseline) {
          const result = probeSustainsTarget(
            measurementBaseline,
            sample,
            profile.maxFramerate,
          );
          if (result !== null) {
            return result;
          }
        }
      }
      await wait(() => new Promise<void>((resolve) => {
        pollTimer = window.setTimeout(resolve, PREFLIGHT_POLL_MS);
      }));
    }
  } finally {
    window.clearTimeout(timer);
    window.clearTimeout(pollTimer);
    signal?.removeEventListener("abort", abort);
    senderConnection.close();
    receiver?.close();
  }
}

/**
 * Proves one real sender per candidate in quality-first order and returns the
 * first codec whose encode pipeline sustains the selected profile. A Browser
 * that advertises no candidate, or a cancelled probe, keeps VP8.
 */
export async function preferredVideoCodecForTrack(
  track: MediaStreamTrack,
  profile: QualityProfile,
  signal?: AbortSignal,
): Promise<BrowserVideoCodec> {
  if (signal?.aborted || track.kind !== "video" || track.readyState === "ended") {
    return "vp8";
  }
  const deadline = Date.now() + PREFLIGHT_TOTAL_DEADLINE_MS;
  for (const codec of VIDEO_CODEC_QUALITY_ORDER) {
    if (signal?.aborted || track.readyState !== "live") break;
    const remaining = deadline - Date.now();
    if (remaining < PREFLIGHT_MIN_BUDGET_MS) break;
    if (!supportsVideoCodecSend(codec)) continue;
    let probe: ProbeTrack | null = null;
    try {
      probe = createProbeTrack(track, profile);
      // A missing probe canvas or encoder pipeline is not codec-specific.
      if (!probe) return "vp8";
      if (await runCodecProbe(
        probe.track,
        profile,
        codec,
        Math.min(PREFLIGHT_DEADLINE_MS, remaining),
        signal,
      )) {
        return codec;
      }
    } catch {
      // Cancellation ends the whole decision; one candidate's timeout or setup
      // failure only rejects that candidate.
      if (signal?.aborted) return "vp8";
    } finally {
      probe?.stop();
    }
  }
  return "vp8";
}
