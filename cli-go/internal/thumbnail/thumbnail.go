package thumbnail

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"vr-cf-go/internal/parser"
)

// Options controls thumbnail extraction.
type Options struct {
	SeekSeconds int
	Width       int
	Quality     int // ffmpeg -q:v 1=best 31=worst
	StereoMode  parser.StereoMode
	Duration    *float64 // optional video duration to clamp seek
}

// GenerateThumbnail extracts a single-frame JPEG from videoPath using ffmpeg.
// It crops to single-eye (sbs->left half, tb->top half) and scales to width.
func GenerateThumbnail(videoPath string, opts Options) ([]byte, error) {
	seek := clampSeek(opts.SeekSeconds, opts.Duration)

	tmpDir, err := os.MkdirTemp("", "vr-cf-thumb-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	outPath := filepath.Join(tmpDir, "thumb.jpg")

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-ss", fmt.Sprintf("%d", seek),
		"-i", videoPath,
		"-vframes", "1",
		"-vf", buildFilter(opts),
		"-q:v", fmt.Sprintf("%d", opts.Quality),
		"-y", outPath,
	}

	if err := runFfmpeg(args); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(outPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read thumbnail: %w", err)
	}
	return data, nil
}

func buildFilter(opts Options) string {
	var filters []string
	switch opts.StereoMode {
	case parser.StereoSBS:
		filters = append(filters, "crop=in_w/2:in_h:0:0")
	case parser.StereoTB:
		filters = append(filters, "crop=in_w:in_h/2:0:0")
	}
	filters = append(filters, fmt.Sprintf("scale=%d:-2", opts.Width))
	return strings.Join(filters, ",")
}

func clampSeek(requested int, duration *float64) int {
	if duration != nil && *duration > 0 && float64(requested) > *duration-2 {
		v := math.Max(1, math.Floor(*duration/4))
		return int(v)
	}
	if requested < 0 {
		return 0
	}
	return requested
}

func runFfmpeg(args []string) error {
	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if _, ok := err.(*exec.Error); ok {
			return fmt.Errorf("ffmpeg spawn failed: %w. Is ffmpeg installed?", err)
		}
		msg := stderr.String()
		if msg == "" {
			msg = err.Error()
		}
		// try to get exit code
		if exitErr, ok := err.(*exec.ExitError); ok {
			return fmt.Errorf("ffmpeg exited %d: %s", exitErr.ExitCode(), msg)
		}
		return fmt.Errorf("ffmpeg failed: %s", msg)
	}
	return nil
}
