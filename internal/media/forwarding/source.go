package forwarding

import (
	"cmp"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/diagnostics"
	"github.com/TNTcraftHIM/Piik/internal/media/encoded"
	"github.com/livekit/livekit-server/pkg/sfu"
	"github.com/livekit/livekit-server/pkg/sfu/buffer"
	"github.com/livekit/mediatransportutil"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/utils"
	"github.com/livekit/protocol/utils/mono"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type LayerFormat struct {
	Width, Height, Bitrate uint32
}

// Representation describes how one published track carries its layers. RID
// simulcast gives every spatial layer its own stream; a single-stream SVC
// publication carries all spatial layers in one.
type Representation struct {
	// RIDs has one entry per declared layer for RID simulcast, lowest first.
	// A spatial publication leaves it empty and carries every layer in one stream.
	RIDs    []string
	Spatial bool
}

// Streams is the number of encoded streams the publisher sends.
func (representation Representation) Streams(layers int) int {
	if representation.Spatial {
		return 1
	}
	return layers
}

// Internal encoders and RTP copies already know the local time of their source
// RTP/NTP correlation. Received reports still need the remote clock estimate.
type sourceBuffer struct {
	*buffer.Buffer
	knownInputClock atomic.Bool
}

func (input *sourceBuffer) GetSenderReportData() *livekit.RTCPSenderReportState {
	report := input.Buffer.GetSenderReportData()
	if report != nil && input.knownInputClock.Load() {
		report.AtAdjusted = report.At
	}
	return report
}

type SourceOptions struct {
	ID, StreamID     string
	Codec            webrtc.RTPCodecParameters
	Formats          []LayerFormat
	Representation   Representation
	HeaderExtensions []webrtc.RTPHeaderExtensionParameter
	MaxPackets       int
	OnRTCP           func(layer int, packets []rtcp.Packet)
}

// Source owns finite RTP layers and their mature forwarding buffers. The caller
// owns input generations, codec clocks and PeerConnections. Feedback callbacks
// run without Source's mutex and may retire the source.
type Source struct {
	*sfu.ReceiverBase
	mu                   sync.Mutex
	buffers              []*sourceBuffer
	maxPackets           int
	representation       Representation
	onRTCP               func(int, []rtcp.Packet)
	closed               bool
	currentTrackInfo     atomic.Pointer[livekit.TrackInfo]
	lowestRateControlled atomic.Bool
}

// The live codec owner sets this after startup and clears it at retirement.
func (source *Source) SetLowestLayerRateControlled(controlled bool) {
	source.lowestRateControlled.Store(controlled)
}

func (source *Source) RateControlled(layer int32) bool {
	return layer == 0 && !source.IsClosed() && source.lowestRateControlled.Load()
}

func NewSource(options SourceOptions) (*Source, error) {
	audio := strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeOpus) && options.Codec.ClockRate == 48_000
	video := options.Codec.ClockRate == 90_000 && (strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeH264) ||
		strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeVP8) ||
		strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeVP9) ||
		strings.EqualFold(options.Codec.MimeType, webrtc.MimeTypeAV1))
	if options.ID == "" || options.StreamID == "" || (!audio && !video) {
		return nil, errors.New("forwarded source is invalid")
	}
	minimum, defaultPackets := buffer.InitPacketBufferSizeVideo, encoded.MaxPacketWindow
	if audio {
		minimum, defaultPackets = buffer.InitPacketBufferSizeAudio, buffer.InitPacketBufferSizeAudio
	}
	if options.MaxPackets == 0 {
		options.MaxPackets = defaultPackets
	}
	if options.MaxPackets < minimum || options.MaxPackets > 1<<16 {
		return nil, errors.New("forwarded packet bound is invalid")
	}
	info := &livekit.TrackInfo{
		Sid: options.ID, Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_SCREEN_SHARE,
		MimeType: options.Codec.MimeType,
	}
	kind, layers := webrtc.RTPCodecTypeVideo, len(options.Formats)
	if audio {
		if len(options.Formats) != 0 {
			return nil, errors.New("forwarded audio cannot declare video layers")
		}
		info.Type, info.Source = livekit.TrackType_AUDIO, livekit.TrackSource_MICROPHONE
		kind, layers = webrtc.RTPCodecTypeAudio, 1
	} else {
		if err := setLayerFormats(info, options.Formats, options.Representation); err != nil {
			return nil, err
		}
		layers = options.Representation.Streams(len(options.Formats))
	}
	source := &Source{
		ReceiverBase: sfu.NewReceiverBase(sfu.ReceiverBaseParams{
			TrackID: livekit.TrackID(options.ID), StreamID: options.StreamID,
			Kind: kind, Codec: options.Codec,
			HeaderExtensions: canonicalHeaderExtensions(options.HeaderExtensions), Logger: diagnostics.MediaLogger("source").WithValues("trackId", diagnostics.ID(options.ID)),
			StreamTrackerManagerConfig: sfu.DefaultStreamTrackerManagerConfig,
		}, info, sfu.ReceiverCodecStateNormal),
		buffers:        make([]*sourceBuffer, layers),
		representation: options.Representation,
		maxPackets:     options.MaxPackets, onRTCP: options.OnRTCP,
	}
	source.currentTrackInfo.Store(info)
	return source, nil
}

// Streams is the number of encoded streams this source receives: one per RID
// for simulcast, one for a single-stream SVC publication.
func (source *Source) Streams() int {
	source.mu.Lock()
	defer source.mu.Unlock()
	return len(source.buffers)
}

func (source *Source) TrackInfo() *livekit.TrackInfo {
	return utils.CloneProto(source.currentTrackInfo.Load())
}

// ReceiverBase reads initial metadata before registering the subscriber. A
// concurrent discovery notification can fall into that gap. Refresh after
// registration; DownTrack's seen-layer setters retain the highest observation.
// Replay accepted clocks so a new forwarder need not await another wire report.
func (source *Source) AddDownTrack(track sfu.TrackSender) error {
	if err := source.ReceiverBase.AddDownTrack(track); err != nil {
		return err
	}
	if source.Kind() == webrtc.RTPCodecTypeVideo {
		tracker := source.StreamTrackerManager()
		track.UpTrackMaxPublishedLayerChange(tracker.GetMaxPublishedLayer())
		track.UpTrackMaxTemporalLayerSeenChange(tracker.GetMaxTemporalLayerSeen())
	}
	for layer, input := range source.ReceiverBase.GetAllBuffers() {
		if input != nil {
			if report := input.GetSenderReportData(); report != nil {
				_ = track.HandleRTCPSenderReportData(source.Codec().PayloadType, int32(layer), report)
			}
		}
	}
	return nil
}

func (source *Source) currentSenderReport(layer int32) *livekit.RTCPSenderReportState {
	inputs := source.ReceiverBase.GetAllBuffers()
	if layer < 0 || int(layer) >= len(inputs) || inputs[layer] == nil {
		return nil
	}
	return inputs[layer].GetSenderReportData()
}

func canonicalHeaderExtensions(extensions []webrtc.RTPHeaderExtensionParameter) []webrtc.RTPHeaderExtensionParameter {
	result := slices.Clone(extensions)
	slices.SortFunc(result, func(left, right webrtc.RTPHeaderExtensionParameter) int {
		if order := cmp.Compare(left.ID, right.ID); order != 0 {
			return order
		}
		return cmp.Compare(left.URI, right.URI)
	})
	return result
}

func setLayerFormats(info *livekit.TrackInfo, formats []LayerFormat, representation Representation) error {
	if len(formats) < 1 || len(formats) > int(buffer.DefaultMaxLayerSpatial)+1 {
		return errors.New("forwarded video layer count is invalid")
	}
	if len(representation.RIDs) != 0 && len(representation.RIDs) != len(formats) {
		return errors.New("forwarded video rids do not match its layers")
	}
	layers := make([]*livekit.VideoLayer, len(formats))
	for index, format := range formats {
		if (format.Width == 0) != (format.Height == 0) {
			return errors.New("forwarded video layer format is invalid")
		}
		quality := livekit.VideoQuality(index)
		if index == len(formats)-1 {
			quality = livekit.VideoQuality_HIGH
		}
		// An unnamed simulcast source keeps the library's stable RID order.
		rid := buffer.DefaultVideoLayersRid[index]
		if representation.Spatial {
			rid = ""
		} else if len(representation.RIDs) != 0 {
			rid = representation.RIDs[index]
		}
		layers[index] = &livekit.VideoLayer{
			Quality: quality, SpatialLayer: int32(index), Rid: rid,
			Width: format.Width, Height: format.Height, Bitrate: format.Bitrate,
		}
	}
	highest := formats[len(formats)-1]
	info.Width, info.Height = highest.Width, highest.Height
	info.Simulcast, info.Layers = !representation.Spatial && len(layers) > 1, layers
	mode := livekit.VideoLayer_ONE_SPATIAL_LAYER_PER_STREAM
	if representation.Spatial {
		mode = livekit.VideoLayer_MULTIPLE_SPATIAL_LAYERS_PER_STREAM
	}
	info.Codecs = []*livekit.SimulcastCodecInfo{{
		MimeType: info.MimeType, VideoLayerMode: mode, Layers: layers,
	}}
	return nil
}

// UpdateFormats changes one source owner's declared layer metadata without
// replacing its buffers or packet identities. Zero values remain unknown.
// The caller serializes updates with its capture/source generation changes.
func (source *Source) UpdateFormats(formats []LayerFormat) error {
	source.mu.Lock()
	closed := source.closed
	source.mu.Unlock()
	if closed {
		return sfu.ErrReceiverClosed
	}
	if source.Kind() != webrtc.RTPCodecTypeVideo || len(formats) != len(source.TrackInfo().Layers) {
		return errors.New("forwarded video layer count changed")
	}
	info := source.TrackInfo()
	if err := setLayerFormats(info, formats, source.representation); err != nil {
		return err
	}
	source.currentTrackInfo.Store(info)
	// The library can notify downtracks while applying metadata.
	source.UpdateTrackInfo(info)
	return nil
}

// UpdateDimensions publishes actual encoder dimensions without UpdateTrackInfo's
// mute propagation, which resets every active layer's tracker and bitrate.
func (source *Source) UpdateDimensions(layer int, width, height uint32) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return sfu.ErrReceiverClosed
	}
	current := source.currentTrackInfo.Load()
	if source.Kind() != webrtc.RTPCodecTypeVideo || layer < 0 || layer >= len(current.Layers) || width == 0 || height == 0 {
		return errors.New("forwarded video layer dimensions are invalid")
	}
	if current.Layers[layer].Width == width && current.Layers[layer].Height == height {
		return nil
	}
	info := utils.CloneProto(current)
	info.Layers[layer].Width, info.Layers[layer].Height = width, height
	info.Codecs[0].Layers[layer].Width, info.Codecs[0].Layers[layer].Height = width, height
	if layer == len(current.Layers)-1 {
		info.Width, info.Height = width, height
	}
	source.currentTrackInfo.Store(info)
	return nil
}

// BindLayer installs a single source identity. A different SSRC requires the
// caller's source-generation replacement, not silent buffer reuse.
func (source *Source) BindLayer(layer int, ssrc uint32, parameters webrtc.RTPParameters) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return sfu.ErrReceiverClosed
	}
	if layer < 0 || layer >= len(source.buffers) || ssrc == 0 {
		return sfu.ErrInvalidLayer
	}
	if source.buffers[layer] != nil {
		return sfu.ErrDuplicateLayer
	}
	codec := source.Codec()
	if !slices.ContainsFunc(parameters.Codecs, func(candidate webrtc.RTPCodecParameters) bool {
		return candidate.PayloadType == codec.PayloadType && candidate.ClockRate == codec.ClockRate &&
			strings.EqualFold(candidate.MimeType, codec.MimeType) && candidate.SDPFmtpLine == codec.SDPFmtpLine
	}) || !slices.Equal(canonicalHeaderExtensions(parameters.HeaderExtensions), source.HeaderExtensions()) {
		return errors.New("forwarded layer codec does not match the source")
	}
	for _, existing := range source.buffers {
		if existing != nil && existing.SSRC() == ssrc {
			return errors.New("forwarded video layers cannot share an SSRC")
		}
	}
	audioPackets, bitrate := buffer.InitPacketBufferSizeAudio, 0
	if source.Kind() == webrtc.RTPCodecTypeAudio {
		audioPackets = source.maxPackets
	} else {
		bitrate = int(source.TrackInfo().Layers[layer].Bitrate)
	}
	input := &sourceBuffer{Buffer: buffer.NewBuffer(ssrc, source.maxPackets, audioPackets)}
	input.SetLogger(diagnostics.MediaLogger("rtp-buffer").WithValues("trackId", diagnostics.ID(string(source.TrackID()))))
	if err := input.Bind(parameters, codec.RTPCodecCapability, bitrate); err != nil {
		_ = input.Close()
		return err
	}
	if source.onRTCP != nil {
		input.OnRtcpFeedback(func(packets []rtcp.Packet) { source.onRTCP(layer, packets) })
	}
	source.AddBuffer(input, int32(layer))
	source.buffers[layer] = input
	source.StartBuffer(input, int32(layer))
	return nil
}

func (source *Source) layerBuffer(layer int) (*sourceBuffer, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return nil, sfu.ErrReceiverClosed
	}
	if layer < 0 || layer >= len(source.buffers) || source.buffers[layer] == nil {
		return nil, sfu.ErrInvalidLayer
	}
	return source.buffers[layer], nil
}

func (source *Source) WriteRTP(layer int, packet *rtp.Packet) error {
	input, err := source.layerBuffer(layer)
	if err != nil {
		return err
	}
	if packet == nil || packet.Version != 2 || packet.SSRC != input.SSRC() ||
		packet.PayloadType != uint8(source.Codec().PayloadType) {
		return errors.New("forwarded RTP packet does not match its layer")
	}
	data, err := packet.Marshal()
	if err != nil {
		return err
	}
	_, err = input.Write(data)
	return err
}

func (source *Source) SenderReport(layer int, report *rtcp.SenderReport) error {
	input, err := source.layerBuffer(layer)
	if err != nil {
		return err
	}
	if report == nil || report.SSRC != input.SSRC() {
		return errors.New("forwarded sender report does not match its layer")
	}
	input.SetSenderReportData(&livekit.RTCPSenderReportState{
		RtpTimestamp: report.RTPTime, NtpTimestamp: report.NTPTime,
		Packets: report.PacketCount, Octets: uint64(report.OctetCount), At: mono.UnixNano(),
	})
	return nil
}

// ReferenceTime keeps derived outputs on the received source's RTP/NTP clock.
// The bounded input history makes the nearest 32-bit timestamp delta unambiguous.
func (source *Source) ReferenceTime(layer int, timestamp uint32) (time.Time, bool) {
	input, err := source.layerBuffer(layer)
	if err != nil {
		return time.Time{}, false
	}
	report := input.GetSenderReportData()
	if report == nil || report.NtpTimestamp == 0 {
		return time.Time{}, false
	}
	delta := time.Duration(int32(timestamp-report.RtpTimestamp)) * time.Second / time.Duration(source.Codec().ClockRate)
	return mediatransportutil.NtpTime(report.NtpTimestamp).Time().Add(delta), true
}

// LocalTime projects the source's clock through its current received report.
// A derived encoder shares this clock offset with the untouched original layer.
func (source *Source) LocalTime(layer int, sourceTime time.Time) (time.Time, bool) {
	input, err := source.layerBuffer(layer)
	if err != nil {
		return time.Time{}, false
	}
	report := input.GetSenderReportData()
	if report == nil || report.NtpTimestamp == 0 || report.AtAdjusted == 0 {
		return time.Time{}, false
	}
	delta := sourceTime.Sub(mediatransportutil.NtpTime(report.NtpTimestamp).Time())
	return time.Unix(0, report.AtAdjusted).Add(delta), true
}

// CopyCorrelation shares an already received clock with an internal RTP copy.
// The original owns network-delay estimation; this buffer still extends and
// orders its own RTP timestamps, including when it starts after a wrap.
func (source *Source) CopyCorrelation(layer int, original *Source) error {
	input, err := original.layerBuffer(layer)
	if err != nil {
		return err
	}
	report := input.GetSenderReportData()
	if report == nil {
		return nil
	}
	report.At = report.AtAdjusted
	return source.SetCorrelation(layer, report)
}

// SetCorrelation receives the source owner's RTP/NTP mapping and its known
// local input time in At. Encoder completion is not a network delay observation.
// The layer must already have received RTP; the media core owns report ordering.
func (source *Source) SetCorrelation(layer int, correlation *livekit.RTCPSenderReportState) error {
	input, err := source.layerBuffer(layer)
	if err != nil {
		return err
	}
	if correlation == nil {
		return errors.New("forwarded source correlation is absent")
	}
	input.knownInputClock.Store(true)
	input.SetSenderReportData(correlation)
	return nil
}

func (source *Source) Close() {
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return
	}
	source.closed = true
	source.mu.Unlock()
	source.ReceiverBase.Close("source closed", true)
}
