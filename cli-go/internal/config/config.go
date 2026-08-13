package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// Config mirrors vr-cf.toml structure.
type Config struct {
	R2 struct {
		Endpoint        string `toml:"endpoint"`
		BucketName      string `toml:"bucket_name"`
		AccessKeyID     string `toml:"access_key_id"`
		SecretAccessKey string `toml:"secret_access_key"`
	} `toml:"r2"`
	Worker struct {
		URL            string `toml:"url"`
		SharedPassword string `toml:"shared_password"`
	} `toml:"worker"`
	Thumbnail struct {
		SeekSeconds int `toml:"seek_seconds"`
		Width       int `toml:"width"`
		Quality     int `toml:"quality"`
	} `toml:"thumbnail"`
}

var requiredFields = []string{
	"r2.endpoint",
	"r2.bucket_name",
	"r2.access_key_id",
	"r2.secret_access_key",
	"worker.url",
	"worker.shared_password",
}

const (
	defaultSeek    = 30
	defaultWidth   = 640
	defaultQuality = 4
)

// LoadConfig searches for vr-cf.toml in standard locations and returns the parsed config.
// Search order: ./vr-cf.toml, ../vr-cf.toml, $HOME/.config/vr-cf.toml
func LoadConfig() (*Config, error) {
	paths := searchPaths()

	for _, p := range paths {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			continue
		}
		cfg, err := loadFile(p)
		if err != nil {
			return nil, err
		}
		if err := validate(cfg, p); err != nil {
			return nil, err
		}
		return cfg, nil
	}

	var tried strings.Builder
	for _, p := range paths {
		tried.WriteString("  - " + p + "\n")
	}
	return nil, fmt.Errorf("vr-cf.toml not found. Searched:\n%s\nCopy vr-cf.toml.example to vr-cf.toml and fill it in", tried.String())
}

func searchPaths() []string {
	cwd, _ := os.Getwd()
	home, _ := os.UserHomeDir()

	var paths []string
	if cwd != "" {
		paths = append(paths, filepath.Join(cwd, "vr-cf.toml"))
		paths = append(paths, filepath.Join(cwd, "..", "vr-cf.toml"))
	}
	if home != "" {
		paths = append(paths, filepath.Join(home, ".config", "vr-cf.toml"))
	}
	return paths
}

func loadFile(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", path, err)
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse %s: %w", path, err)
	}
	applyDefaults(&cfg)
	return &cfg, nil
}

func applyDefaults(cfg *Config) {
	if cfg.Thumbnail.SeekSeconds == 0 {
		cfg.Thumbnail.SeekSeconds = defaultSeek
	}
	if cfg.Thumbnail.Width == 0 {
		cfg.Thumbnail.Width = defaultWidth
	}
	if cfg.Thumbnail.Quality == 0 {
		cfg.Thumbnail.Quality = defaultQuality
	}
}

func validate(cfg *Config, path string) error {
	missing := []string{}
	fieldMap := map[string]string{
		"r2.endpoint":          cfg.R2.Endpoint,
		"r2.bucket_name":       cfg.R2.BucketName,
		"r2.access_key_id":     cfg.R2.AccessKeyID,
		"r2.secret_access_key": cfg.R2.SecretAccessKey,
		"worker.url":           cfg.Worker.URL,
		"worker.shared_password": cfg.Worker.SharedPassword,
	}
	for _, f := range requiredFields {
		if strings.TrimSpace(fieldMap[f]) == "" {
			missing = append(missing, f)
		}
	}
	if len(missing) > 0 {
		var b strings.Builder
		b.WriteString(fmt.Sprintf("Missing required config in %s:\n", path))
		for _, f := range missing {
			b.WriteString("  - " + f + "\n")
		}
		return fmt.Errorf("%s", strings.TrimRight(b.String(), "\n"))
	}
	return nil
}
