package ffprobe

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
)

// ProbeResult holds basic stream/format info extracted via ffprobe.
type ProbeResult struct {
	Duration *float64 `json:"duration"`
	Width    *int     `json:"width"`
	Height   *int     `json:"height"`
}

// internal ffprobe JSON structures.
type ffprobeOutput struct {
	Streams []struct {
		Width  *int `json:"width"`
		Height *int `json:"height"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ProbeVideo runs ffprobe against a file and returns duration/dimensions.
func ProbeVideo(filePath string) (*ProbeResult, error) {
	cmd := exec.Command("ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-show_entries", "format=duration",
		"-of", "json",
		filePath,
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if _, ok := err.(*exec.Error); ok {
			return nil, fmt.Errorf("ffprobe spawn failed: %w. Is ffprobe installed?", err)
		}
		msg := stderr.String()
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("ffprobe exited: %s", msg)
	}

	var data ffprobeOutput
	if err := json.Unmarshal(stdout.Bytes(), &data); err != nil {
		return nil, fmt.Errorf("failed to parse ffprobe output: %w", err)
	}

	result := &ProbeResult{}
	if len(data.Streams) > 0 {
		result.Width = data.Streams[0].Width
		result.Height = data.Streams[0].Height
	}
	if data.Format.Duration != "" {
		if d, err := strconv.ParseFloat(data.Format.Duration, 64); err == nil {
			result.Duration = &d
		}
	}

	return result, nil
}
