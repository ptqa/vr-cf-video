package parser

import "testing"

func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func intVal(i *int) int {
	if i == nil {
		return -1
	}
	return *i
}

func TestParseVrFilename_Synthetic(t *testing.T) {
	cases := []struct {
		filename string
		studio   string
		title    string
		proj     Projection
		stereo   StereoMode
		resLabel string
	}{
		{"Sample_Scene_One_2900p_MKX200.mp4", "", "Sample Scene One", ProjMKX200, StereoSBS, "2900p"},
		{"Sample_Title_Two_8K_MKX200_LR.mp4", "", "Sample Title Two", ProjMKX200, StereoSBS, "8K"},
		{"Sample_Title_Three_6K_180x180_TB.mp4", "", "Sample Title Three", ProjEquirect180, StereoTB, "6K"},
		{"Sample_Scene_Four_4K.mp4", "", "Sample Scene Four", ProjEquirect180, StereoSBS, "4K"},
		{"Sample_Title_Five_6K.mp4", "", "Sample Title Five", ProjEquirect180, StereoSBS, "6K"},
		{"Sample_Scene_Five_4096p_FISHEYE_3dh.mp4", "", "Sample Scene Five", ProjFisheye, StereoSBS, "4096p"},
		{"Sample_Scene_Six_2K_mono.mp4", "", "Sample Scene Six", ProjEquirect180, StereoOff, "2K"},
		{"generic_clip_1080p.mp4", "", "generic clip", ProjEquirect180, StereoSBS, "1080p"},
		{"MyClip_TB_360.mp4", "", "MyClip", ProjEquirect360, StereoTB, ""},
	}

	for _, c := range cases {
		m := ParseVrFilename(c.filename)
		if strVal(m.Studio) != c.studio {
			t.Errorf("%s: studio got %q want %q", c.filename, strVal(m.Studio), c.studio)
		}
		if m.Title != c.title {
			t.Errorf("%s: title got %q want %q", c.filename, m.Title, c.title)
		}
		if m.Projection != c.proj {
			t.Errorf("%s: projection got %q want %q", c.filename, m.Projection, c.proj)
		}
		if m.StereoMode != c.stereo {
			t.Errorf("%s: stereo got %q want %q", c.filename, m.StereoMode, c.stereo)
		}
		if strVal(m.ResolutionLabel) != c.resLabel {
			t.Errorf("%s: resLabel got %q want %q", c.filename, strVal(m.ResolutionLabel), c.resLabel)
		}
	}

	// Spot-check numeric resolution.
	m := ParseVrFilename("Sample_Clip_2900p_MKX200.mp4")
	if intVal(m.Resolution) != 2900 {
		t.Errorf("resolution got %d want 2900", intVal(m.Resolution))
	}
	if m.FOV != 200 {
		t.Errorf("fov got %d want 200", m.FOV)
	}
	if !m.Is3D {
		t.Errorf("expected is3d true")
	}

	mono := ParseVrFilename("Sample_Clip_2K_mono.mp4")
	if mono.Is3D {
		t.Errorf("mono should not be is3d")
	}
	if mono.StereoMode != StereoOff {
		t.Errorf("mono stereo got %q want off", mono.StereoMode)
	}
}
