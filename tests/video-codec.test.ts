import { expect, it, vi } from "vitest";
import {
  applyVideoCodecPreference,
  automaticVideoCodecPreference,
  sfuVideoCodec,
  manualVideoCodecPreference,
  normalizeVideoOfferSdp,
  requireReceivingVideo,
  supportsH264Receive,
  VideoReceiveRejectedError,
} from "../src/client/webrtc/video-codec";

it("checks H264 receive capability independently of sender support", () => {
  const h264 = { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=1" };
  const receive = vi.fn(() => ({ codecs: [h264] }));
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [h264] }) });
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: receive });
  try {
    expect(supportsH264Receive()).toBe(true);
    expect(receive).toHaveBeenCalledWith("video");
    receive.mockReturnValue({ codecs: [{ ...h264, sdpFmtpLine: "packetization-mode=0" }] });
    expect(supportsH264Receive()).toBe(false);
    receive.mockReturnValue({ codecs: [] });
    expect(supportsH264Receive()).toBe(false);
    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(supportsH264Receive()).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("recognizes a Browser-rejected video answer without inferring codec support", () => {
  const offer = (sdp: string): RTCSessionDescriptionInit => ({ type: "offer", sdp });
  const answer = (sdp: string): RTCSessionDescriptionInit => ({ type: "answer", sdp });
  const video = "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\na=rtpmap:96 H264/90000\r\n";
  const rejected = "m=video 0 UDP/TLS/RTP/SAVPF 120\r\n";
  expect(() => requireReceivingVideo(offer(video), answer(rejected))).toThrow(VideoReceiveRejectedError);
  for (const [offered, accepted] of [
    [video, video.replace("sendonly", "recvonly")],
    [video + video, rejected + video.replace("sendonly", "recvonly")],
    [video.replace("9 UDP", "0 UDP"), rejected],
    [video.replace("sendonly", "inactive"), rejected],
    [video.replace("sendonly", "recvonly"), rejected],
    ["m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", "m=audio 0 UDP/TLS/RTP/SAVPF 111\r\n"],
  ]) expect(() => requireReceivingVideo(offer(offered!), answer(accepted!))).not.toThrow();
  expect(() => requireReceivingVideo(offer(video.replace("9 UDP", "0 UDP") + "a=bundle-only\r\n"),
    answer(rejected))).toThrow(VideoReceiveRejectedError);
});

it.each(["\r\n", "\n"])("removes orphan codec attributes within each offered video section (%j)", newline => {
  const lines = [
    "v=0", "a=x-session:keep",
    "m=video 9 UDP/TLS/RTP/SAVPF 120 124", "a=mid:0", "a=ice-ufrag:unchanged",
    "a=rtpmap:120 VP8/90000", "a=rtpmap:124 rtx/90000", "a=fmtp:124 apt=120",
    "a=rtcp-fb:120 nack", "a=rtcp-fb:* transport-cc", "a=x-video:keep",
    "a=fmtp:126 profile-level-id=42e01f", "a=rtcp-fb:126 nack pli",
    "m=video 9 UDP/TLS/RTP/SAVPF 126", "a=mid:1", "a=rtpmap:126 H264/90000",
    "a=fmtp:126 profile-level-id=42e01f;packetization-mode=1", "a=rtcp-fb:126 nack",
    "a=rtcp-fb:120 nack pli",
    "m=audio 9 UDP/TLS/RTP/SAVPF 0", "a=fmtp:0 keep-audio",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=sctp-port:5000", "",
  ];
  const omitted = new Set([11, 12, 18]);
  const expected = lines.filter((_line, index) => !omitted.has(index)).join(newline);
  expect(normalizeVideoOfferSdp(lines.join(newline))).toBe(expected);
  expect(normalizeVideoOfferSdp(expected)).toBe(expected);
});

it("preserves valid codec parameters, feedback and opaque data without reserializing SDP", () => {
  const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n" +
    "a=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e034;packetization-mode=1\r\n" +
    "a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtcp-fb:96 nack\r\n" +
    "a=rtcp-fb:* transport-cc\r\na=unknown:exact spacing  and values\r\n";
  expect(normalizeVideoOfferSdp(sdp)).toBe(sdp);
});

it("orders automatic fallbacks quality-first and keeps manual choices strict", () => {
  const codecs = [
    { mimeType: "video/H264", clockRate: 90_000, sdpFmtpLine: "packetization-mode=1" },
    { mimeType: "video/VP8", clockRate: 90_000 },
    { mimeType: "video/VP9", clockRate: 90_000, sdpFmtpLine: "profile-id=0" },
    { mimeType: "video/AV1", clockRate: 90_000, sdpFmtpLine: "profile=0" },
    { mimeType: "video/rtx", clockRate: 90_000 },
  ];
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs }) });
  const applied: { mimeType: string }[][] = [];
  const transceiver = {
    setCodecPreferences: (preference: { mimeType: string }[]) => applied.push(preference),
  } as unknown as RTCRtpTransceiver;
  try {
    expect(applyVideoCodecPreference(transceiver, automaticVideoCodecPreference("av1"))).toBe(true);
    expect(applied.at(-1)!.map((codec) => codec.mimeType)).toEqual([
      "video/AV1", "video/VP9", "video/H264", "video/VP8", "video/rtx",
    ]);
    expect(applyVideoCodecPreference(transceiver, manualVideoCodecPreference("vp9"))).toBe(true);
    expect(applied.at(-1)!.map((codec) => codec.mimeType)).toEqual(["video/VP9", "video/rtx"]);
    expect(applyVideoCodecPreference(transceiver, manualVideoCodecPreference("vp8"))).toBe(true);
    expect(applied.at(-1)!.map((codec) => codec.mimeType)).toEqual(["video/VP8", "video/rtx"]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects a selection this Browser cannot send and forwards only the SFU set", () => {
  expect(sfuVideoCodec("av1", ["h264", "vp8", "vp9", "av1"])).toBe("av1");
  expect(sfuVideoCodec("vp9", ["h264", "vp8", "vp9", "av1"])).toBe("vp9");
  expect(sfuVideoCodec("av1", ["h264", "vp8"])).toBe("vp8");
  expect(sfuVideoCodec("h264", ["h264", "vp8"])).toBe("h264");
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8", clockRate: 90_000 }] }),
  });
  const transceiver = { setCodecPreferences: vi.fn() } as unknown as RTCRtpTransceiver;
  try {
    expect(applyVideoCodecPreference(transceiver, manualVideoCodecPreference("av1"))).toBe(false);
    expect(applyVideoCodecPreference(transceiver, manualVideoCodecPreference("h264"))).toBe(false);
    expect(applyVideoCodecPreference(transceiver, manualVideoCodecPreference("vp8"))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
