package main

import (
	"strings"
	"testing"
)

func TestPreviewHealthcheckCommandUsesLoopbackIP(t *testing.T) {
	cmd := previewHealthcheckCommand("26694")

	if !strings.Contains(cmd, "http://127.0.0.1:26694/health") {
		t.Fatalf("healthcheck command = %q, want 127.0.0.1 health probe", cmd)
	}
	if strings.Contains(cmd, "localhost") {
		t.Fatalf("healthcheck command = %q, should not use localhost", cmd)
	}
}

func TestNodeTestRunnerDoesNotBlockOnNetworklessInstall(t *testing.T) {
	_, cmd := testRunnerImageAndCmd("node")

	if !strings.Contains(cmd, "npm install --offline") {
		t.Fatalf("node test command should install in offline mode: %q", cmd)
	}
	if !strings.Contains(cmd, "|| true") {
		t.Fatalf("node test command should continue when offline install cannot resolve optional deps: %q", cmd)
	}
	if strings.Contains(cmd, "npm install --prefer-offline --silent 2>/dev/null;") {
		t.Fatalf("node test command still contains the old blocking install: %q", cmd)
	}
}
