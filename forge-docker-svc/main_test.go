package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testPipelineID = "123e4567-e89b-12d3-a456-426614174000"

func TestValidateForgeImageTag(t *testing.T) {
	tests := []struct {
		name    string
		image   string
		wantErr bool
	}{
		{name: "latest tag", image: "forge-" + testPipelineID + ":latest"},
		{name: "custom tag", image: "forge-" + testPipelineID + ":build_20260421-1"},
		{name: "missing tag", image: "forge-" + testPipelineID, wantErr: true},
		{name: "wrong pipeline", image: "forge-123e4567-e89b-12d3-a456-426614174001:latest", wantErr: true},
		{name: "remote image", image: "attacker/rootkit:latest", wantErr: true},
		{name: "registry path", image: "registry.example.com/forge-" + testPipelineID + ":latest", wantErr: true},
		{name: "invalid tag path", image: "forge-" + testPipelineID + ":bad/tag", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateForgeImageTag(testPipelineID, tt.image)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateForgeImageTag() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestRequireInternalAPIKey(t *testing.T) {
	handler := requireInternalAPIKey("shared-secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	tests := []struct {
		name       string
		key        string
		wantStatus int
	}{
		{name: "missing key", wantStatus: http.StatusUnauthorized},
		{name: "bad key", key: "wrong", wantStatus: http.StatusUnauthorized},
		{name: "valid key", key: "shared-secret", wantStatus: http.StatusNoContent},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/docker/deploy", nil)
			if tt.key != "" {
				req.Header.Set(internalAPIKeyHeader, tt.key)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

func TestCleanWorkspaceContextPath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		want    string
		wantErr bool
	}{
		{name: "workspace root", path: "/workspace", want: "/workspace"},
		{name: "workspace child", path: "/workspace/app", want: "/workspace/app"},
		{name: "clean valid path", path: "/workspace/app/../service", want: "/workspace/service"},
		{name: "host root", path: "/", wantErr: true},
		{name: "path traversal outside workspace", path: "/workspace/../etc", wantErr: true},
		{name: "workspace sibling prefix", path: "/workspace-secrets/app", wantErr: true},
		{name: "relative workspace path", path: "workspace/app", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := cleanWorkspaceContextPath(tt.path)
			if (err != nil) != tt.wantErr {
				t.Fatalf("cleanWorkspaceContextPath() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("cleanWorkspaceContextPath() = %q, want %q", got, tt.want)
			}
		})
	}
}
