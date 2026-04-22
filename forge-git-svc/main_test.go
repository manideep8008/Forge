package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestIsSafeGitRefParam(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "simple branch", value: "feature/login", want: true},
		{name: "slug characters", value: "abc.DEF_123-fix", want: true},
		{name: "leading dash", value: "--output=/tmp/exfil", want: false},
		{name: "space", value: "feature bad", want: false},
		{name: "colon", value: "feature:bad", want: false},
		{name: "too long", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", want: false},
		{name: "empty", value: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSafeGitRefParam(tt.value); got != tt.want {
				t.Fatalf("isSafeGitRefParam(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestCreateBranchHandlerRejectsUnsafeSlug(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost,
		"/git/branch",
		strings.NewReader(`{"pipeline_id":"pipeline-123","slug":"--output=/tmp/exfil"}`),
	)
	rec := httptest.NewRecorder()

	createBranchHandler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("createBranchHandler status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestDiffHandlerRejectsUnsafeBranch(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/git/diff/--output=/tmp/exfil", nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("branch", "--output=/tmp/exfil")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()

	diffHandler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("diffHandler status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}
