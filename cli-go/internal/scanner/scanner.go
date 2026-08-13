package scanner

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	cfgpkg "vr-cf-go/internal/config"
	"vr-cf-go/internal/ffprobe"
	"vr-cf-go/internal/parser"
	"vr-cf-go/internal/thumbnail"
	"vr-cf-go/internal/uploader"
)

var videoExtensions = map[string]bool{
	".mp4":  true,
	".mkv":  true,
	".mov":  true,
	".webm": true,
}

// UploadOptions mirrors TS UploadOptions.
type UploadOptions struct {
	NoThumb   bool
	Force     bool
	OnProgress func(filename string, p uploader.Progress)
	OnStep     func(filename string, step string)
}

// UploadResult mirrors TS UploadResult.
type UploadResult struct {
	Total    int
	Uploaded int
	Skipped  int
	Failed   int
	Errors   []FileError
}

// FileError holds per-file failure.
type FileError struct {
	Filename string
	Error    string
}

// UploadDirectory scans directory recursively and uploads every video file found.
func UploadDirectory(ctx context.Context, u *uploader.R2Uploader, cfg *cfgpkg.Config, directory string, opts UploadOptions) (*UploadResult, error) {
	files, err := collectVideos(directory)
	if err != nil {
		return nil, err
	}
	result := &UploadResult{Total: len(files)}
	for _, filePath := range files {
		filename := filepath.Base(filePath)
		wasUploaded, err := uploadOne(ctx, u, cfg, filePath, filename, opts)
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, FileError{Filename: filename, Error: err.Error()})
			continue
		}
		if wasUploaded {
			result.Uploaded++
		} else {
			result.Skipped++
		}
	}
	return result, nil
}

// UploadFile uploads a single file.
func UploadFile(ctx context.Context, u *uploader.R2Uploader, cfg *cfgpkg.Config, filePath string, opts UploadOptions) (bool, error) {
	filename := filepath.Base(filePath)
	return uploadOne(ctx, u, cfg, filePath, filename, opts)
}

// GenerateAndUploadThumbnail regenerates a thumbnail for an already-uploaded video.
func GenerateAndUploadThumbnail(ctx context.Context, u *uploader.R2Uploader, cfg *cfgpkg.Config, filePath string) error {
	filename := filepath.Base(filePath)
	meta := parser.ParseVrFilename(filename)

	probe, err := ffprobe.ProbeVideo(filePath)
	if err != nil {
		// fallback to nulls like TS does on catch
		probe = &ffprobe.ProbeResult{}
	}

	jpeg, err := thumbnail.GenerateThumbnail(filePath, thumbnail.Options{
		SeekSeconds: cfg.Thumbnail.SeekSeconds,
		Width:       cfg.Thumbnail.Width,
		Quality:     cfg.Thumbnail.Quality,
		StereoMode:  meta.StereoMode,
		Duration:    probe.Duration,
	})
	if err != nil {
		return err
	}
	return u.UploadBytes(ctx, "thumbs/"+filename+".jpg", jpeg, "image/jpeg")
}

func uploadOne(ctx context.Context, u *uploader.R2Uploader, cfg *cfgpkg.Config, filePath, filename string, opts UploadOptions) (bool, error) {
	videoKey := "videos/" + filename
	metaKey := "videos/" + filename + ".meta.json"
	thumbKey := "thumbs/" + filename + ".jpg"

	if opts.OnStep != nil {
		opts.OnStep(filename, "probe")
	}
	probe, err := ffprobe.ProbeVideo(filePath)
	if err != nil {
		return false, fmt.Errorf("ffprobe failed: %w", err)
	}
	parsed := parser.ParseVrFilename(filename)

	if !opts.NoThumb {
		if opts.OnStep != nil {
			opts.OnStep(filename, "thumb")
		}
		jpeg, err := thumbnail.GenerateThumbnail(filePath, thumbnail.Options{
			SeekSeconds: cfg.Thumbnail.SeekSeconds,
			Width:       cfg.Thumbnail.Width,
			Quality:     cfg.Thumbnail.Quality,
			StereoMode:  parsed.StereoMode,
			Duration:    probe.Duration,
		})
		if err != nil {
			if opts.OnStep != nil {
				opts.OnStep(filename, fmt.Sprintf("thumb skipped: %s", err.Error()))
			}
		} else {
			if err := u.UploadBytes(ctx, thumbKey, jpeg, "image/jpeg"); err != nil {
				if opts.OnStep != nil {
					opts.OnStep(filename, fmt.Sprintf("thumb skipped: %s", err.Error()))
				}
			}
		}
	}

	if opts.OnStep != nil {
		opts.OnStep(filename, "upload")
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return false, err
	}
	sizeBytes := info.Size()

	if !opts.Force {
		exists, _ := u.Exists(ctx, videoKey, sizeBytes)
		if exists {
			if opts.OnStep != nil {
				opts.OnStep(filename, "already on R2 (skipped)")
			}
			if err := writeSidecar(ctx, u, metaKey, probe, parsed, sizeBytes); err != nil {
				return false, err
			}
			return false, nil
		}
	}

	wasUploaded, err := u.UploadFile(ctx, videoKey, filePath, contentTypeFor(filename), func(p uploader.Progress) {
		if opts.OnProgress != nil {
			opts.OnProgress(filename, p)
		}
	})
	if err != nil {
		return false, err
	}

	if err := writeSidecar(ctx, u, metaKey, probe, parsed, sizeBytes); err != nil {
		return false, err
	}
	return wasUploaded, nil
}

func writeSidecar(ctx context.Context, u *uploader.R2Uploader, metaKey string, probe *ffprobe.ProbeResult, parsed parser.VrMetadata, sizeBytes int64) error {
	sidecar := map[string]interface{}{
		"duration": probe.Duration,
		"width":    probe.Width,
		"height":   probe.Height,
		"size":     sizeBytes,
		"parsed":   parsed,
	}
	body, err := json.MarshalIndent(sidecar, "", "  ")
	if err != nil {
		return err
	}
	return u.UploadBytes(ctx, metaKey, body, "application/json")
}

func collectVideos(directory string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(directory, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("failed to read %s: %w", path, err)
		}
		if d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(d.Name()))
		if videoExtensions[ext] {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func contentTypeFor(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".mp4":
		return "video/mp4"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	default:
		return "application/octet-stream"
	}
}
