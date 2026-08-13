package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/spf13/cobra"

	cfgpkg "vr-cf-go/internal/config"
	"vr-cf-go/internal/parser"
	"vr-cf-go/internal/scanner"
	"vr-cf-go/internal/uploader"
)

const version = "0.1.0"

func main() {
	root := &cobra.Command{
		Use:     "vr-cf",
		Short:   "Upload + manage VR videos for vr-cf-video on Cloudflare",
		Version: version,
	}

	root.AddCommand(newUploadCmd())
	root.AddCommand(newListCmd())
	root.AddCommand(newDeleteCmd())
	root.AddCommand(newThumbCmd())
	root.AddCommand(newRefreshCmd())
	root.AddCommand(newStatsCmd())

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func newUploadCmd() *cobra.Command {
	var noThumb bool
	var force bool

	cmd := &cobra.Command{
		Use:   "upload <path>",
		Short: "Upload a single file or every video in a directory",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			u, err := uploader.New(cfg)
			if err != nil {
				return err
			}

			target, err := filepath.Abs(args[0])
			if err != nil {
				return err
			}
			info, err := os.Stat(target)
			if err != nil {
				fmt.Fprintf(os.Stderr, "path not found: %s\n", target)
				os.Exit(1)
			}

			ctx := context.Background()

			if info.IsDir() {
				fmt.Printf("Scanning %s…\n", target)

				result, err := scanner.UploadDirectory(ctx, u, cfg, target, scanner.UploadOptions{
					NoThumb: noThumb,
					Force:   force,
					OnStep: func(filename, step string) {
						fmt.Printf("\r  %-40s | %s   ", short(filename), step)
					},
					OnProgress: func(filename string, p uploader.Progress) {
						fmt.Printf("\r  %-40s | %3d%% | %-9s | upload   ", short(filename), p.Percent, formatSpeed(p.BytesPerSecond))
					},
				})
				if err != nil {
					return err
				}
				fmt.Println()
				fmt.Printf("\n--- Done ---\n")
				fmt.Printf("  Total:    %d\n", result.Total)
				fmt.Printf("  Uploaded: %d\n", result.Uploaded)
				fmt.Printf("  Skipped:  %d\n", result.Skipped)
				fmt.Printf("  Failed:   %d\n", result.Failed)
				if len(result.Errors) > 0 {
					fmt.Printf("\nErrors:\n")
					for _, e := range result.Errors {
						fmt.Printf("  %s: %s\n", e.Filename, e.Error)
					}
				}
				refreshWorkerCatalog(cfg)
			} else {
				fmt.Printf("Uploading %s…\n", target)
				filename := filepath.Base(target)
				fmt.Printf("\r  %-40s | starting   ", short(filename))

				wasUploaded, err := scanner.UploadFile(ctx, u, cfg, target, scanner.UploadOptions{
					NoThumb: noThumb,
					Force:   force,
					OnStep: func(_, step string) {
						fmt.Printf("\r  %-40s | %s   ", short(filename), step)
					},
					OnProgress: func(_ string, p uploader.Progress) {
						fmt.Printf("\r  %-40s | %3d%% | %-9s | upload   ", short(filename), p.Percent, formatSpeed(p.BytesPerSecond))
					},
				})
				if err != nil {
					fmt.Println()
					return err
				}
				fmt.Println()
				if wasUploaded {
					fmt.Println("✓ uploaded")
				} else {
					fmt.Println("✓ already on R2 (skipped)")
				}
				refreshWorkerCatalog(cfg)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&noThumb, "no-thumb", false, "Skip thumbnail generation")
	// also support --no-thumb negated via Bool flag is direct; commander --no-thumb means thumb=false.
	// Cobra doesn't have negated flags natively; we expose --no-thumb as bool.
	// For compatibility, we also add --thumb hidden.
	cmd.Flags().BoolVar(&force, "force", false, "Re-upload even if R2 already has the same-size file")
	return cmd
}

func newListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List videos in R2 with parsed metadata",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			u, err := uploader.New(cfg)
			if err != nil {
				return err
			}
			objects, err := listAllVideos(context.Background(), u.Client(), cfg.R2.BucketName)
			if err != nil {
				return err
			}
			if len(objects) == 0 {
				fmt.Println("(empty)")
				return nil
			}
			fmt.Printf("%d videos:\n\n", len(objects))
			for _, obj := range objects {
				key := aws.ToString(obj.Key)
				filename := strings.TrimPrefix(key, "videos/")
				m := parser.ParseVrFilename(filename)
				sizeGB := float64(aws.ToInt64(obj.Size)) / 1024 / 1024 / 1024
				var tags []string
				if m.Studio != nil && *m.Studio != "" {
					tags = append(tags, *m.Studio)
				}
				if m.ResolutionLabel != nil && *m.ResolutionLabel != "" {
					tags = append(tags, *m.ResolutionLabel)
				}
				tags = append(tags, fmt.Sprintf("%d°", m.FOV))
				tagStr := strings.Join(tags, " · ")
				fmt.Printf("  %s\n", filename)
				fmt.Printf("    %s  [%s]  %.2f GB\n", m.Title, tagStr, sizeGB)
			}
			return nil
		},
	}
}

func newDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <filename>",
		Short: "Delete a video + its sidecar + thumbnail from R2",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			filename := args[0]
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			u, err := uploader.New(cfg)
			if err != nil {
				return err
			}
			ctx := context.Background()
			keys := []string{
				"videos/" + filename,
				"videos/" + filename + ".meta.json",
				"thumbs/" + filename + ".jpg",
			}
			for _, key := range keys {
				_, err := u.Client().DeleteObject(ctx, &s3.DeleteObjectInput{
					Bucket: aws.String(cfg.R2.BucketName),
					Key:    aws.String(key),
				})
				if err != nil {
					fmt.Printf("  not found: %s (%s)\n", key, err.Error())
				} else {
					fmt.Printf("  deleted: %s\n", key)
				}
			}
			refreshWorkerCatalog(cfg)
			return nil
		},
	}
}

func newThumbCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "thumb <localFile>",
		Short: "Regenerate a thumbnail from a local video file (uploads to thumbs/)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			localFile := args[0]
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			u, err := uploader.New(cfg)
			if err != nil {
				return err
			}
			target, err := filepath.Abs(localFile)
			if err != nil {
				return err
			}
			if _, err := os.Stat(target); os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "file not found: %s\n", target)
				os.Exit(1)
			}
			fmt.Printf("Generating thumbnail for %s…\n", filepath.Base(target))
			if err := scanner.GenerateAndUploadThumbnail(context.Background(), u, cfg, target); err != nil {
				return err
			}
			fmt.Println("✓ uploaded thumbnail")
			refreshWorkerCatalog(cfg)
			return nil
		},
	}
}

func newRefreshCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "refresh",
		Short: "Invalidate the worker catalog cache",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			refreshWorkerCatalog(cfg)
			return nil
		},
	}
}

func newStatsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stats",
		Short: "Print library statistics",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := cfgpkg.LoadConfig()
			if err != nil {
				return err
			}
			u, err := uploader.New(cfg)
			if err != nil {
				return err
			}
			objects, err := listAllVideos(context.Background(), u.Client(), cfg.R2.BucketName)
			if err != nil {
				return err
			}
			var totalBytes int64
			byStudio := map[string]int{}
			for _, obj := range objects {
				totalBytes += aws.ToInt64(obj.Size)
				key := aws.ToString(obj.Key)
				filename := strings.TrimPrefix(key, "videos/")
				studio := "Unknown"
				if m := parser.ParseVrFilename(filename); m.Studio != nil {
					studio = *m.Studio
				}
				byStudio[studio]++
			}
			fmt.Printf("Videos: %d\n", len(objects))
			fmt.Printf("Total:  %.2f GB\n", float64(totalBytes)/1024/1024/1024)
			fmt.Printf("\nBy studio:\n")
			type kv struct {
				k string
				v int
			}
			var sorted []kv
			for k, v := range byStudio {
				sorted = append(sorted, kv{k, v})
			}
			sort.Slice(sorted, func(i, j int) bool { return sorted[i].v > sorted[j].v })
			for _, kv := range sorted {
				fmt.Printf("  %-24s %d\n", kv.k, kv.v)
			}
			return nil
		},
	}
}

func listAllVideos(ctx context.Context, client *s3.Client, bucket string) ([]types.Object, error) {
	var out []types.Object
	var token *string
	for {
		page, err := client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(bucket),
			Prefix:            aws.String("videos/"),
			ContinuationToken: token,
			MaxKeys:           aws.Int32(1000),
		})
		if err != nil {
			return nil, err
		}
		for _, obj := range page.Contents {
			if obj.Key == nil {
				continue
			}
			key := aws.ToString(obj.Key)
			if strings.HasSuffix(key, ".meta.json") || key == "videos/" {
				continue
			}
			out = append(out, obj)
		}
		if page.IsTruncated != nil && *page.IsTruncated {
			token = page.NextContinuationToken
		} else {
			break
		}
	}
	return out, nil
}

func refreshWorkerCatalog(cfg *cfgpkg.Config) {
	base := strings.TrimRight(cfg.Worker.URL, "/")
	u, err := url.Parse(base + "/admin/refresh")
	if err != nil {
		fmt.Fprintf(os.Stderr, "worker refresh failed: %v\n", err)
		return
	}
	req, err := http.NewRequest(http.MethodPost, u.String(), nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "worker refresh failed: %v\n", err)
		return
	}
	creds := base64.StdEncoding.EncodeToString([]byte("vr-cf:" + cfg.Worker.SharedPassword))
	req.Header.Set("Authorization", "Basic "+creds)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "worker refresh failed: %v\n", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "worker refresh failed: %d %s\n", resp.StatusCode, resp.Status)
	}
}

func short(filename string) string {
	if len(filename) > 40 {
		return filename[:37] + "…"
	}
	return fmt.Sprintf("%-40s", filename)
}

func formatSpeed(bps float64) string {
	if bps <= 0 {
		return "—"
	}
	mb := bps / 1024 / 1024
	return fmt.Sprintf("%.1f MB/s", mb)
}
