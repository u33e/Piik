# ADR-0016: LiveKit-Shaped SFU Edge

- Status: Accepted; upload gating closed by inspection, see "Upload Gating" below. Supersedes the representation plan in [ADR-0015](./0015-scalable-video-forwarding.md)
- Date: 2026-11-08

## Context

Piik reuses LiveKit's media components (`sfu.ReceiverBase`, `sfu.DownTrack`,
`sfu.Forwarder`, `buffer`, `streamallocator`, `pacer`, `sendsidebwe`) but writes
its own edge orchestration in `internal/server/sfu` and
`internal/media/forwarding`. That orchestration drifted away from the shape the
components were designed for, and each new capability pays for the drift:

- Ingress binds a track to a layer by looking its RID up in a Piik-maintained
  list (`internal/server/sfu/media.go`: `slices.Index(publication.metadata.RIDs, track.RID())`).
  A track without a RID — every single-stream SVC publication — is treated as
  invalid.
- Upload gating runs backwards: the SFU keeps a publication connection, counts
  active encodings, and mutes them (`Publication.SetActiveCount` →
  `track.PubMute(index >= count)`; the page turns that into
  `encoding.active`). LiveKit's own shape declares layers from the client and
  gates upload through Dynacast.
- Layer truth is split: the page's `SfuMedia` message, the server's
  `metadata.Formats`, and `TrackInfo` each describe the same geometry.
- The components already implement what Piik re-derives: LiveKit's
  `pkg/rtc/mediatrackreceiver.go` maps SDP RIDs and scalar modes onto one
  `simulcastReceiver` per stream, keeps `TrackInfo` as the layer truth, and its
  forwarder picks simulcast or VP9/dependency-descriptor selection from that. SVC
  and VP9/AV1 fall out of that shape instead of needing a new wire field.

Adopting LiveKit's **room service** (`pkg/rtc` `Room`, `Participant`,
`TransportManager`, LiveKit signalling and tokens) is not in scope: Piik's room
authority, invitations, route graph and wire contract stay as they are.

## Decision

1. The SFU edge follows LiveKit's `pkg/rtc` shape, ported — not invented. Piik
   keeps the components and copies the orchestration structure, adapting only the
   authority hooks (room, route, wire).
2. Ingress is SDP-driven: one receiver per published stream, RIDs and their
   spatial-layer mapping read from the description, `TrackInfo` owning layer
   geometry and `VideoLayerMode`. A single-stream SVC publication is legal
   without a Piik-side RID list, and a codec's representation is never inferred
   from payload bytes or from a Piik-only wire field.
3. The page declares what it publishes (`codec`, layer geometry, scalar mode) the
   way a LiveKit client does with `UpdateVideoLayers`; the server does not
   maintain a second description of the same geometry.
4. Upload gating follows Dynacast's shape: one server-side demand owner unions
   each subscriber's forwarder-selected spatial layer and reports the needed
   encodings; the publisher stops the rest. See "Upload Gating" below for why the
   wire keeps a contiguous count.
5. Subscriber DownTracks are created by the subscription owner, as
   `MediaTrackSubscriptions` does; bandwidth estimation, allocation, selection,
   pacing and recovery stay with the existing LiveKit components.
6. `SfuMedia` keeps only what LiveKit's client also declares — codec, per-layer
   geometry and bitrate ceilings — and drops the SVC/`mode` extension proposed in
   ADR-0015. Codec admission extends to VP9/AV1 with capability advertisement
   under the [versioning policy](../standards/versioning.md).
7. Piik's room, route, capacity, clock projection and native-control owners do
   not move. Only the media-edge orchestration changes shape.

## Consequences And Release Boundary

- This is a media-edge rewrite, not a codec patch: `internal/server/sfu` and the
  orchestration half of `internal/media/forwarding` are replaced by ported
  LiveKit structure plus thin Piik adapters. Component behaviour and framework
  ownership stay the same, so product-visible behavior should not change for
  H264/VP8.
- VP9/AV1 and SVC arrive as a consequence of the shape, not as a second feature.
- Existing acceptance must re-pass: NACK/RTX ownership, SRTP replay, sender-report
  clock projection, recovery, pause/resume, source replacement, and the two-Viewer
  and SFU-only paths.
- The reverse publication connection is the riskiest removal: upload gating must
  keep working for Browser and Native publishers before the old path is deleted.
- Physical browser acceptance remains required; in-process tests do not replace it.

## Upload Gating

Tracing the path after the media model landed: the server already owns the single
demand fact. `Transport.RequiredActiveCount` reads the forwarder's selected
spatial layer per subscriber, `mediaPublication.requiredActiveCount` unions them,
and one message drives both publishers — the page maps it to
`encoding.active`, the App maps it to its own senders. There is no second
gating authority, so nothing needs to be retired.

The only remaining difference from Dynacast is shape of the answer: a contiguous
count instead of an explicit layer set. For the screen-share publication's two
ordered layers the two are identical, while a set needs a new message variant
gated by a client-advertised capability. Emitting a new variant to pages that do
not advertise it is exactly what the [versioning policy](../standards/versioning.md)
forbids. This record therefore keeps the count and revisits it only if a
publication declares non-contiguous spatial layers (three or more with a gap).

## Staged Delivery

1. **Ingress shape.** Port the receiver: SDP-driven RID/layer mapping,
   `TrackInfo` as the single layer truth, SVC-ready stream count. Keep the current
   publication and gating path so that H264/VP8 behavior is unchanged and the
   existing forwarding tests still pass.
2. ~~Upload gating shape.~~ Closed by inspection above: one owner already exists.
3. **Publication and admission.** Declare VP9/AV1 with capability advertisement;
   SVC shares publish one encoding with spatial layers; `sfuVideoCodec` narrows
   only when the server does not advertise the codec.
4. **Acceptance.** Physical matrix for direct, relay and SFU-only paths, layer
   drops under constrained budget, recovery, and codec fallback.

## References

- LiveKit `pkg/rtc/mediatrackreceiver.go`, `mediatracksubscriptions.go`,
  `transportmanager.go` and `dynacast/` in the pinned fork: the shape being
  ported.
- LiveKit `pkg/sfu/forwarder.go` and `pkg/sfu/utils/helpers.go`: simulcast versus
  VP9/dependency-descriptor selection keyed by `VideoLayerMode`.
- [ADR-0013](./0013-embedded-node-local-media.md): forwarding-only SFU and
  framework-owned adaptation.
- [ADR-0007](./0007-path-isolated-representation-quality.md): codec selection.
