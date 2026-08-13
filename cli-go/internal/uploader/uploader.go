package uploader

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	cfgpkg "vr-cf-go/internal/config"
)

// Progress mirrors the TS UploadProgress interface.
type Progress struct {
	Loaded         int64
	Total          int64
	Percent        int
	BytesPerSecond float64
}

const (
	PartSizeBytes          = 50 * 1024 * 1024 // 50 MB
	PartConcurrency        = 3
	MultipartThresholdBytes = 100 * 1024 * 1024
)

// R2Uploader wraps S3 client for Cloudflare R2.
type R2Uploader struct {
	client     *s3.Client
	bucketName string
}

// New creates an R2Uploader from config.
func New(cfg *cfgpkg.Config) (*R2Uploader, error) {
	awsCfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion("auto"),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			cfg.R2.AccessKeyID,
			cfg.R2.SecretAccessKey,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.R2.Endpoint)
		o.UsePathStyle = true
	})

	return &R2Uploader{
		client:     client,
		bucketName: cfg.R2.BucketName,
	}, nil
}

// Client returns the underlying S3 client for direct operations (list, delete).
func (u *R2Uploader) Client() *s3.Client {
	return u.client
}

// Bucket returns the bucket name.
func (u *R2Uploader) Bucket() string {
	return u.bucketName
}

// Exists checks if an object exists with expected size. If expectedSize <0, just checks existence.
func (u *R2Uploader) Exists(ctx context.Context, key string, expectedSize int64) (bool, error) {
	out, err := u.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(u.bucketName),
		Key:    aws.String(key),
	})
	if err != nil {
		// Treat any error as not exists (matching TS behavior which swallows all errors)
		return false, nil
	}
	if expectedSize < 0 {
		return true, nil
	}
	if out.ContentLength == nil {
		return false, nil
	}
	return *out.ContentLength == expectedSize, nil
}

// UploadFile uploads a file from disk with progress. Caller is responsible for
// skip-if-exists checks (scanner already does HeadObject). Always uploads.
func (u *R2Uploader) UploadFile(ctx context.Context, key, filePath, contentType string, onProgress func(Progress)) (bool, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return false, err
	}
	fileSize := info.Size()

	if fileSize < MultipartThresholdBytes {
		if err := u.uploadSinglePart(ctx, key, filePath, fileSize, contentType, onProgress); err != nil {
			return false, err
		}
	} else {
		if err := u.uploadMultipart(ctx, key, filePath, fileSize, contentType, onProgress); err != nil {
			return false, err
		}
	}
	return true, nil
}

// UploadBytes uploads an in-memory buffer.
func (u *R2Uploader) UploadBytes(ctx context.Context, key string, body []byte, contentType string) error {
	_, err := u.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(u.bucketName),
		Key:           aws.String(key),
		Body:          bytes.NewReader(body),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(int64(len(body))),
	})
	return err
}

// Delete deletes a single key.
func (u *R2Uploader) Delete(ctx context.Context, key string) error {
	_, err := u.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(u.bucketName),
		Key:    aws.String(key),
	})
	return err
}

func (u *R2Uploader) uploadSinglePart(ctx context.Context, key, filePath string, fileSize int64, contentType string, onProgress func(Progress)) error {
	start := time.Now()
	if onProgress != nil {
		onProgress(Progress{Loaded: 0, Total: fileSize, Percent: 0, BytesPerSecond: 0})
	}

	body, err := readRange(filePath, 0, fileSize)
	if err != nil {
		return err
	}

	_, err = u.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(u.bucketName),
		Key:           aws.String(key),
		Body:          bytes.NewReader(body),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(fileSize),
	})
	if err != nil {
		return err
	}

	if onProgress != nil {
		elapsed := time.Since(start).Seconds()
		var bps float64
		if elapsed > 0 {
			bps = float64(fileSize) / elapsed
		}
		onProgress(Progress{Loaded: fileSize, Total: fileSize, Percent: 100, BytesPerSecond: bps})
	}
	return nil
}

func (u *R2Uploader) uploadMultipart(ctx context.Context, key, filePath string, fileSize int64, contentType string, onProgress func(Progress)) error {
	createOut, err := u.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(u.bucketName),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return err
	}
	uploadID := createOut.UploadId
	if uploadID == nil || *uploadID == "" {
		return fmt.Errorf("no upload id returned by R2")
	}

	partCount := int((fileSize + PartSizeBytes - 1) / PartSizeBytes)
	type partDef struct {
		partNumber int32
		offset     int64
		length     int64
	}
	defs := make([]partDef, partCount)
	for i := 0; i < partCount; i++ {
		offset := int64(i) * PartSizeBytes
		length := PartSizeBytes
		if offset+int64(length) > fileSize {
			length = int(fileSize - offset)
		}
		defs[i] = partDef{partNumber: int32(i + 1), offset: offset, length: int64(length)}
	}

	var (
		mu            sync.Mutex
		parts         []types.CompletedPart
		uploadedBytes int64
		start         = time.Now()
	)

	reportProgress := func() {
		if onProgress == nil {
			return
		}
		mu.Lock()
		loaded := uploadedBytes
		mu.Unlock()
		elapsed := time.Since(start).Seconds()
		var bps float64
		if elapsed > 0 {
			bps = float64(loaded) / elapsed
		}
		percent := 0
		if fileSize > 0 {
			percent = int((loaded * 100) / fileSize)
		}
		onProgress(Progress{
			Loaded:         loaded,
			Total:          fileSize,
			Percent:        percent,
			BytesPerSecond: bps,
		})
	}

	// worker pool
	errCh := make(chan error, 1)
	defCh := make(chan partDef)

	var wg sync.WaitGroup
	concurrency := PartConcurrency
	if partCount < concurrency {
		concurrency = partCount
	}

	// need to capture multipart failure for abort
	ctx2 := ctx

	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for def := range defCh {
				select {
				case <-ctx2.Done():
					return
				default:
				}

				buf, err := readRange(filePath, def.offset, def.length)
				if err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}

				out, err := u.client.UploadPart(ctx2, &s3.UploadPartInput{
					Bucket:        aws.String(u.bucketName),
					Key:           aws.String(key),
					UploadId:      uploadID,
					PartNumber:    aws.Int32(def.partNumber),
					Body:          bytes.NewReader(buf),
					ContentLength: aws.Int64(def.length),
				})
				if err != nil {
					select {
					case errCh <- err:
					default:
					}
					return
				}
				if out.ETag == nil {
					select {
					case errCh <- fmt.Errorf("no ETag for part %d", def.partNumber):
					default:
					}
					return
				}

				mu.Lock()
				parts = append(parts, types.CompletedPart{
					ETag:       out.ETag,
					PartNumber: aws.Int32(def.partNumber),
				})
				uploadedBytes += def.length
				mu.Unlock()
				reportProgress()
			}
		}()
	}

	go func() {
		for _, d := range defs {
			defCh <- d
		}
		close(defCh)
	}()

	wg.Wait()

	// check for error
	select {
	case e := <-errCh:
		// abort
		_, _ = u.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
			Bucket:   aws.String(u.bucketName),
			Key:      aws.String(key),
			UploadId: uploadID,
		})
		return e
	default:
	}

	sort.Slice(parts, func(i, j int) bool {
		return *parts[i].PartNumber < *parts[j].PartNumber
	})

	_, err = u.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:   aws.String(u.bucketName),
		Key:      aws.String(key),
		UploadId: uploadID,
		MultipartUpload: &types.CompletedMultipartUpload{
			Parts: parts,
		},
	})
	if err != nil {
		_, _ = u.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
			Bucket:   aws.String(u.bucketName),
			Key:      aws.String(key),
			UploadId: uploadID,
		})
		return err
	}

	if onProgress != nil {
		onProgress(Progress{Loaded: fileSize, Total: fileSize, Percent: 100, BytesPerSecond: 0})
	}
	return nil
}

// readRange reads [offset, offset+length) from disk using SectionReader.
func readRange(filePath string, offset, length int64) ([]byte, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sr := io.NewSectionReader(f, offset, length)
	return io.ReadAll(sr)
}
