package protocol

import (
	"errors"
	"slices"
)

// SfuMedia describes the publisher's real encodings, ordered low to high.
type SfuMedia struct {
	Codec        string     `json:"codec"`
	Layers       []SfuLayer `json:"layers"`
	Audio        bool       `json:"audio"`
	AudioBitrate Int        `json:"audioBitrate"`
}

type SfuLayer struct {
	RID     string `json:"rid"`
	Width   Int    `json:"width"`
	Height  Int    `json:"height"`
	Bitrate Int    `json:"bitrate"`
}

func (value *SfuMedia) UnmarshalJSON(data []byte) error {
	type raw SfuMedia
	present, err := decodeObject(data, (*raw)(value))
	if err != nil {
		return err
	}
	if err := present.require("codec", "layers", "audio", "audioBitrate"); err != nil {
		return err
	}
	if !enumOf(value.Codec, "h264", "vp8", "vp9", "av1") ||
		len(value.Layers) < 1 || len(value.Layers) > 3 ||
		!inRangeInt(value.AudioBitrate, 0, MaxAudioBitrate) || value.Audio && value.AudioBitrate == 0 {
		return errors.New("invalid SFU media")
	}
	// One SVC stream carries several spatial layers and therefore no RIDs. Only
	// the scalable codecs may publish that shape.
	spatial := len(value.Layers) > 1 && !slices.ContainsFunc(value.Layers, func(layer SfuLayer) bool {
		return layer.RID != ""
	})
	if spatial && value.Codec != "vp9" && value.Codec != "av1" {
		return errors.New("invalid SFU media")
	}
	for index, layer := range value.Layers {
		if len(layer.RID) > 16 || layer.RID == "" && len(value.Layers) != 1 && !spatial ||
			!inRangeInt(layer.Width, 1, 0xffff_ffff) || !inRangeInt(layer.Height, 1, 0xffff_ffff) || !inRangeInt(layer.Bitrate, 1, 0xffff_ffff) {
			return errors.New("invalid SFU layer")
		}
		if layer.RID == "" {
			continue
		}
		for _, previous := range value.Layers[:index] {
			if previous.RID == layer.RID {
				return errors.New("duplicate SFU RID")
			}
		}
	}
	return nil
}

func (value *SfuLayer) UnmarshalJSON(data []byte) error {
	type raw SfuLayer
	present, err := decodeObject(data, (*raw)(value))
	if err != nil {
		return err
	}
	return present.require("rid", "width", "height", "bitrate")
}

// SfuSignalMessage travels only on the room's authenticated WebSocket.
type SfuSignalMessage struct {
	Type                  string              `json:"type"`
	Revision              Int                 `json:"revision"`
	PublicationGeneration string              `json:"publicationGeneration"`
	ConnectionID          string              `json:"connectionId"`
	Kind                  string              `json:"kind"`
	Description           *SessionDescription `json:"description,omitempty"`
	Candidate             *IceCandidate       `json:"candidate,omitempty"`
	Media                 *SfuMedia           `json:"media,omitempty"`
	ActiveCount           *Int                `json:"activeCount,omitempty"`
}

func (SfuSignalMessage) isClientMessage() {}
func (SfuSignalMessage) isServerMessage() {}

func decodeSfuSignal(data []byte) (SfuSignalMessage, error) {
	var message SfuSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return message, err
	}
	if err := present.require("type", "revision", "publicationGeneration", "connectionId", "kind"); err != nil {
		return message, err
	}
	if err := present.optional("description", "candidate", "media", "activeCount"); err != nil {
		return message, err
	}
	if message.Kind != "layers" && message.ActiveCount != nil {
		return message, errors.New("unexpected SFU layer demand")
	}
	if !validRevision(message.Revision) || !ValidOpaqueID(message.PublicationGeneration) || !ValidOpaqueID(message.ConnectionID) {
		return message, errors.New("invalid SFU signal fence")
	}
	switch message.Kind {
	case "layers":
		if message.ActiveCount == nil || !inRangeInt(*message.ActiveCount, 0, 3) || message.Description != nil || message.Candidate != nil || message.Media != nil {
			return message, errors.New("invalid SFU layer demand")
		}
	case "media":
		if message.Media == nil || message.Description != nil || message.Candidate != nil {
			return message, errors.New("invalid SFU media signal")
		}
	case "subscribe":
		if message.Description != nil || message.Candidate != nil || message.Media != nil {
			return message, errors.New("invalid SFU subscription signal")
		}
	case "description":
		if message.Description == nil || message.Candidate != nil || message.Media != nil && message.Description.Type != "offer" {
			return message, errors.New("invalid SFU description signal")
		}
	case "candidate":
		if message.Description != nil || message.Media != nil {
			return message, errors.New("invalid SFU ICE signal")
		}
	default:
		return message, errors.New("unknown SFU signal kind")
	}
	return message, nil
}
