package parser

import (
	"regexp"
	"strconv"
	"strings"
)

// StereoMode describes the 3-D layout of the video frame.
type StereoMode string

const (
	StereoSBS StereoMode = "sbs"
	StereoTB  StereoMode = "tb"
	StereoOff StereoMode = "off"
)

// Projection describes the lens / equirect geometry.
type Projection string

const (
	ProjEquirect180 Projection = "equirect-180"
	ProjEquirect360 Projection = "equirect-360"
	ProjMKX200      Projection = "mkx200"
	ProjMKX220      Projection = "mkx220"
	ProjRF52        Projection = "rf52"
	ProjFisheye     Projection = "fisheye"
	ProjFlat        Projection = "flat"
)

// ScreenTypeForDeovr maps Projection to DeoVR's screenType field.
var ScreenTypeForDeovr = map[Projection]string{
	ProjEquirect180: "dome",
	ProjEquirect360: "sphere",
	ProjMKX200:      "mkx200",
	ProjMKX220:      "mkx220",
	ProjRF52:        "rf52",
	ProjFisheye:     "fisheye",
	ProjFlat:        "flat",
}

// VrMetadata is the structured result of parsing a VR video filename.
type VrMetadata struct {
	Filename        string     `json:"filename"`
	Title           string     `json:"title"`
	Studio          *string    `json:"studio"`
	Resolution      *int       `json:"resolution"`
	ResolutionLabel *string    `json:"resolutionLabel"`
	Projection      Projection `json:"projection"`
	FOV             int        `json:"fov"`
	StereoMode      StereoMode `json:"stereoMode"`
	Is3D            bool       `json:"is3d"`
}

type studioMatcher struct {
	studio  string
	pattern *regexp.Regexp
}

var studioMatchers = []studioMatcher{
	{studio: "NaughtyAmericaVR", pattern: regexp.MustCompile(`(?i)^NaughtyAmericaVR\b`)},
	{studio: "VirtualRealPorn", pattern: regexp.MustCompile(`(?i)^VirtualRealPorn[_-]`)},
	{studio: "VRBangers", pattern: regexp.MustCompile(`(?i)^VRBANGERS[_-]`)},
	{studio: "WankzVR", pattern: regexp.MustCompile(`(?i)^wankzvr[_-]`)},
	{studio: "SLR", pattern: regexp.MustCompile(`(?i)^SLR[_-]`)},
	{studio: "Manny S (SLR)", pattern: regexp.MustCompile(`(?i)^Manny_S[_-]`)},
}

// Short codes handled separately because Go RE2 doesn't support lookahead.
var naShortCodes = []string{"nam", "naw", "tdrm", "tspa", "ptgs"}

var tagTokenSet = map[string]struct{}{
	"mkx200": {}, "mkx220": {}, "rf52": {}, "fisheye": {},
	"180x180": {}, "360x180": {}, "180": {}, "360": {},
	"lr": {}, "tb": {}, "ou": {}, "sbs": {}, "3dh": {}, "3dv": {}, "mono": {},
	"vr265": {}, "vrdesktophd": {}, "8kvr265": {}, "6kvr265": {}, "4kvr265": {},
	"2k": {}, "4k": {}, "6k": {}, "8k": {},
}

func isTagToken(token string) bool {
	lower := strings.ToLower(token)
	if _, ok := tagTokenSet[lower]; ok {
		return true
	}
	// \d{3,4}p  e.g. 2900p, 1080p, 4096p
	if len(lower) >= 2 && lower[len(lower)-1] == 'p' {
		num := lower[:len(lower)-1]
		if len(num) >= 3 && len(num) <= 4 {
			allDigits := true
			for _, c := range num {
				if c < '0' || c > '9' {
					allDigits = false
					break
				}
			}
			if allDigits {
				return true
			}
		}
	}
	// numeric 4-6 digits (scene IDs)
	if len(lower) >= 4 && len(lower) <= 6 {
		allDigits := true
		for _, c := range lower {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return true
		}
	}
	return false
}

var (
	rePx        = regexp.MustCompile(`(?i)(\d{3,4})p`)
	re8kvr265   = regexp.MustCompile(`(?i)8kvr265|_8K(_|\b)|8K_`)
	re6kvr265   = regexp.MustCompile(`(?i)6kvr265|_6K(_|\b)|6K_`)
	re4kvr265   = regexp.MustCompile(`(?i)_4K(_|\b)|4K_|4kvr265`)
	re2kvr265   = regexp.MustCompile(`(?i)_2K(_|\b)|2K_`)
	reVRDesktop = regexp.MustCompile(`(?i)vrdesktophd`)

	reMKX200  = regexp.MustCompile(`(?i)MKX200`)
	reMKX220  = regexp.MustCompile(`(?i)MKX220`)
	reRF52    = regexp.MustCompile(`(?i)RF52`)
	reFisheye = regexp.MustCompile(`(?i)FISHEYE`)
	re360     = regexp.MustCompile(`(?i)(?:^|[_\-])360(?:[_\-.]|$)|360x180`)
	reMono    = regexp.MustCompile(`(?i)(?:^|[_\-])mono(?:[_\-.]|$)|(?:^|[_\-])2D(?:[_\-.]|$)`)
	reTB      = regexp.MustCompile(`(?i)(?:^|[_\-])(?:TB|OU|3dv)(?:[_\-.]|$)`)

	reExt       = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)
	reSplit     = regexp.MustCompile(`[_]+|\s*-\s*`)
	reTrimLead  = regexp.MustCompile(`^[_\-\s]+`)
	reSpace     = regexp.MustCompile(`\s+`)
	reUnderscore = regexp.MustCompile(`[_]+`)
)

func detectResolution(filename string) (*int, *string) {
	if m := rePx.FindStringSubmatch(filename); m != nil {
		n, _ := strconv.Atoi(m[1])
		label := strconv.Itoa(n) + "p"
		return &n, &label
	}
	if re8kvr265.MatchString(filename) {
		n := 4320
		l := "8K"
		return &n, &l
	}
	if re6kvr265.MatchString(filename) {
		n := 3160
		l := "6K"
		return &n, &l
	}
	if re4kvr265.MatchString(filename) {
		n := 2160
		l := "4K"
		return &n, &l
	}
	if re2kvr265.MatchString(filename) {
		n := 1440
		l := "2K"
		return &n, &l
	}
	if reVRDesktop.MatchString(filename) {
		n := 1080
		l := "HD"
		return &n, &l
	}
	return nil, nil
}

func detectProjection(filename string) (Projection, int) {
	if reMKX200.MatchString(filename) {
		return ProjMKX200, 200
	}
	if reMKX220.MatchString(filename) {
		return ProjMKX220, 220
	}
	if reRF52.MatchString(filename) {
		return ProjRF52, 190
	}
	if reFisheye.MatchString(filename) {
		return ProjFisheye, 180
	}
	if re360.MatchString(filename) {
		return ProjEquirect360, 360
	}
	return ProjEquirect180, 180
}

func detectStereoMode(filename string) StereoMode {
	if reMono.MatchString(filename) {
		return StereoOff
	}
	if reTB.MatchString(filename) {
		return StereoTB
	}
	return StereoSBS
}

func detectStudio(stem string) (*string, string) {
	for _, m := range studioMatchers {
		loc := m.pattern.FindStringIndex(stem)
		if loc != nil && loc[0] == 0 {
			matched := stem[loc[0]:loc[1]]
			remainder := stem[len(matched):]
			remainder = reTrimLead.ReplaceAllString(remainder, "")
			s := m.studio
			return &s, remainder
		}
	}
	// Check short codes: prefix + lookahead [a-z] (case-insensitive).
	lower := strings.ToLower(stem)
	for _, code := range naShortCodes {
		if strings.HasPrefix(lower, code) && len(stem) > len(code) {
			next := stem[len(code)]
			if (next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') {
				remainder := stem[len(code):]
				remainder = reTrimLead.ReplaceAllString(remainder, "")
				s := "NaughtyAmerica"
				return &s, remainder
			}
		}
	}
	return nil, stem
}

func extractTitle(remainder, fullStem string) string {
	if remainder == "" {
		return fullStem
	}
	tokens := reSplit.Split(remainder, -1)
	var titleTokens []string
	for _, t := range tokens {
		if t == "" {
			continue
		}
		if !isTagToken(t) {
			titleTokens = append(titleTokens, t)
		}
	}
	if len(titleTokens) == 0 {
		fallback := reUnderscore.ReplaceAllString(remainder, " ")
		fallback = strings.TrimSpace(fallback)
		if fallback != "" {
			return fallback
		}
		return fullStem
	}
	joined := strings.Join(titleTokens, " ")
	joined = reSpace.ReplaceAllString(joined, " ")
	return strings.TrimSpace(joined)
}

// ParseVrFilename parses a VR video filename into structured metadata.
// Example: "Sample_Title_2900p_MKX200.mp4"
func ParseVrFilename(filename string) VrMetadata {
	stem := reExt.ReplaceAllString(filename, "")

	studio, remainder := detectStudio(stem)
	resolution, label := detectResolution(filename)
	projection, fov := detectProjection(filename)
	stereoMode := detectStereoMode(filename)
	title := extractTitle(remainder, stem)

	return VrMetadata{
		Filename:        filename,
		Title:           title,
		Studio:          studio,
		Resolution:      resolution,
		ResolutionLabel: label,
		Projection:      projection,
		FOV:             fov,
		StereoMode:      stereoMode,
		Is3D:            stereoMode != StereoOff,
	}
}
