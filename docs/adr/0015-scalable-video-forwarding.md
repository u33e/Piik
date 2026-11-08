# ADR-0015: Scalable Video Forwarding For VP9 And AV1

- Status: Superseded by [ADR-0016](./0016-livekit-shaped-sfu-edge.md); its evidence still applies, its wire `mode` plan does not
- Date: 2026-11-08

## Context

[ADR-0007](./0007-path-isolated-representation-quality.md) now lets a Browser
share prove and select VP9 or AV1. The embedded SFU still admits H264 and VP8
only, so such a share publishes VP8 to it. Lifting that boundary is not a codec
table change: the forwarding model itself carries an assumption.

The current representation is **RID simulcast**: `SfuMedia.Layers` describes one
`{rid, width, height, bitrate}` per spatial layer, ingress binds each RID stream
to its own buffer, and the publication sends one encoding per RID. That shape
matches VP8 and H264, where each layer is an independent encoder.

VP9 and AV1 in a Browser are not published that way. LiveKit's own client
constructs **one encoding with `scalabilityMode: "L3T3"`** for SVC codecs and
only falls back to rid `f/h/q` for engines without single-encoding SVC. The
pinned LiveKit server already implements the serving half: `forwarder.go`
switches between simulcast selectors and the VP9 / dependency-descriptor
selectors from `sfuutils.IsSimulcastMode`, and the RTP buffer parses VP9 and AV1
spatial layers. Its spatial-layer mode is
`VideoLayer_MULTIPLE_SPATIAL_LAYERS_PER_STREAM`; Piik currently declares
`ONE_SPATIAL_LAYER_PER_STREAM` for every layer.

So the missing capability is a second representation shape, not a third codec
entry. [AGENTS.md](../../AGENTS.md) forbids adding a hand-built SFU
representation without an accepted decision, which this record requests.

## Decision

1. Representation mode becomes explicit: `simulcast` (one spatial layer per RID
   stream) or `svc` (one stream carrying N spatial layers). H264 and VP8 use
   `simulcast`; VP9 and AV1 use `svc`. The mode travels on the wire and is never
   inferred from payload bytes.
2. `SfuMedia` gains `mode` and accepts `vp9`/`av1`; rid-less layers become valid
   for `svc` only. A page emits these values only after `sfu-config` advertises
   the codec set, per the [versioning policy](../standards/versioning.md). An
   absent advertisement keeps the 2.0 H264/VP8 baseline.
3. Ingress keeps one buffer per encoded stream. An `svc` source therefore binds
   one input at layer 0 while `TrackInfo` declares its spatial layers; simulcast
   keeps one buffer per RID. Layer metadata updates must not imply new buffers.
4. The publication connection sends one encoding for `svc`. `activeCount` stays
   1 and never mutes spatial layers: LiveKit's selector chooses the spatial layer
   per subscriber from the dependency descriptor or VP9 header, exactly as it
   does for the library's own SVC publications. Simulcast keeps the existing
   per-encoding activation.
5. Existing framework ownership does not move: no Piik layer ladder, per-Viewer
   transcode, custom quality score or parallel codec route. Piik declares layer
   geometry and ceiling; LiveKit owns selection.
6. An SVC encoding's `maxBitrate` covers all layers, so the declared spatial
   ceilings split that number instead of adding to it. The Host picture ceiling
   stays the single upper bound.
7. Native capture keeps H264 and VP8. Shipping an App-side VP9/AV1 encoder is a
   separate decision with its own dependency, packaging and version costs.

## Consequences And Release Boundary

- The Host still uploads the whole SVC stream. SVC saves encoder processes and
  subscriber egress, not Host uplink; the bandwidth win is at the SFU boundary,
  not on the wire to the SFU.
- Single-encoding SVC needs Chrome 113 or newer. The rid fallback path stays
  available for other engines, and Auto keeps proving H264/VP8 when AV1 or VP9
  cannot sustain the profile.
- One more representation shape touches ingress binding, publication construction,
  allocation messages and the wire contract together. A partial slice (wire
  without forwarding, or forwarding without publication) would ship an
  unusable path, so the stages below land as one phase.
- Physical acceptance remains required: a VP9/AV1 share must reach an SFU-only
  Viewer, drop spatial layers under a constrained subscriber budget without
  breaking recovery, and keep NACK/RTX and the source clock intact. In-process
  forwarding tests do not replace that.

## Staged Delivery

1. Wire and capability: `SfuMedia.mode`, codec enum, `sfu-config` codec
   advertisement, strict Go validation.
2. Ingress and forwarding: `NewSource` mode, one-buffer SVC binding, TrackInfo
   spatial layers, publication single encoding, allocation demand.
3. Browser publication: single encoding with `scalabilityMode`, media message
   with `mode`, layer-activation handling for SVC.
4. Physical acceptance on Windows/macOS Chrome, then removal of the
   `forwardedVideoCodec` VP8 clamp.

## References

- [LiveKit client 2.22.1 screen-share encoding construction](https://github.com/livekit/client-sdk-js/blob/v2.22.1/src/room/participant/publishUtils.ts):
  single encoding with `scalabilityMode` for SVC codecs, rid `f/h/q` fallback for
  engines without it, and bitrate factors VP9 ×0.85, AV1 ×0.7 of the VP8 baseline.
- Pinned LiveKit server fork (`pkg/sfu/forwarder.go`, `pkg/sfu/utils/helpers.go`,
  `pkg/sfu/buffer/buffer_base.go`): simulcast versus VP9/dependency-descriptor
  selectors, and VP9/AV1 spatial-layer parsing.
- [Media quality](../standards/media-quality.md#codec-decision) owns the current
  codec decision and the SFU boundary this record extends.
- [ADR-0013](./0013-embedded-node-local-media.md) owns forwarding-only SFU
  distribution; [ADR-0007](./0007-path-isolated-representation-quality.md) owns
  codec selection.
