package websocket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

const testJWTSecret = "test-secret"

func TestServeWSRejectsMissingOrInvalidJWT(t *testing.T) {
	t.Setenv("JWT_SECRET", testJWTSecret)

	tokenWithoutUserID := signedTestToken(t, jwt.MapClaims{"email": "user@example.com"})

	tests := []struct {
		name  string
		token string
	}{
		{name: "missing token"},
		{name: "invalid token", token: "not-a-jwt"},
		{name: "missing user id claim", token: tokenWithoutUserID},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hub := NewHub(nil, nil)
			req := websocketRequest(tt.token)
			rec := httptest.NewRecorder()

			hub.ServeWS(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("ServeWS status = %d, want %d", rec.Code, http.StatusUnauthorized)
			}
		})
	}
}

func TestServeWSFailsClosedWhenOwnershipCannotBeChecked(t *testing.T) {
	t.Setenv("JWT_SECRET", testJWTSecret)

	hub := NewHub(nil, nil)
	req := websocketRequest(signedTestToken(t, jwt.MapClaims{"user_id": "user-1"}))
	rec := httptest.NewRecorder()

	hub.ServeWS(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("ServeWS status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestHubShutdownIsIdempotent(t *testing.T) {
	hub := NewHub(nil, nil)

	hub.Shutdown()
	hub.Shutdown()
}

func TestClientSendCloseIsIdempotent(t *testing.T) {
	c := &client{send: make(chan []byte)}

	c.closeSend()
	c.closeSend()
}

func TestReserveConnectionEnforcesPipelineCap(t *testing.T) {
	oldPerPipeline := maxConnectionsPerPipeline
	oldPerIP := maxConnectionsPerIP
	maxConnectionsPerPipeline = 1
	maxConnectionsPerIP = 10
	t.Cleanup(func() {
		maxConnectionsPerPipeline = oldPerPipeline
		maxConnectionsPerIP = oldPerIP
	})

	hub := NewHub(nil, nil)
	if err := hub.reserveConnection("pipeline-1", "192.0.2.1"); err != nil {
		t.Fatalf("reserveConnection first connection: %v", err)
	}
	if err := hub.reserveConnection("pipeline-1", "192.0.2.2"); err == nil {
		t.Fatal("reserveConnection second pipeline connection succeeded, want cap error")
	}

	hub.releaseConnection(&client{pipelineID: "pipeline-1", ip: "192.0.2.1"})
	if err := hub.reserveConnection("pipeline-1", "192.0.2.2"); err != nil {
		t.Fatalf("reserveConnection after release: %v", err)
	}
}

func TestReserveConnectionEnforcesIPCap(t *testing.T) {
	oldPerPipeline := maxConnectionsPerPipeline
	oldPerIP := maxConnectionsPerIP
	maxConnectionsPerPipeline = 10
	maxConnectionsPerIP = 1
	t.Cleanup(func() {
		maxConnectionsPerPipeline = oldPerPipeline
		maxConnectionsPerIP = oldPerIP
	})

	hub := NewHub(nil, nil)
	if err := hub.reserveConnection("pipeline-1", "192.0.2.1"); err != nil {
		t.Fatalf("reserveConnection first connection: %v", err)
	}
	if err := hub.reserveConnection("pipeline-2", "192.0.2.1"); err == nil {
		t.Fatal("reserveConnection second IP connection succeeded, want cap error")
	}
}

func signedTestToken(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()

	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatalf("sign test token: %v", err)
	}
	return token
}

func websocketRequest(token string) *http.Request {
	target := "/ws/pipeline/pipeline-1"
	if token != "" {
		target += "?token=" + token
	}

	req := httptest.NewRequest(http.MethodGet, target, nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "pipeline-1")
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}
