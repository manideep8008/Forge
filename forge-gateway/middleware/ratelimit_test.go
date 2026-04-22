package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestResolvedClientIPIgnoresXForwardedForWithoutTrustedProxies(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	got := resolvedClientIP(req, nil)
	if got != "203.0.113.10" {
		t.Fatalf("resolvedClientIP() = %q, want %q", got, "203.0.113.10")
	}
}

func TestResolvedClientIPIgnoresXForwardedForFromUntrustedPeer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	trusted := map[string]bool{"10.0.0.1": true}
	got := resolvedClientIP(req, trusted)
	if got != "203.0.113.10" {
		t.Fatalf("resolvedClientIP() = %q, want %q", got, "203.0.113.10")
	}
}

func TestResolvedClientIPUsesXForwardedForFromTrustedPeer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:49152"
	req.Header.Set("X-Forwarded-For", "198.51.100.25, 10.0.0.1")

	trusted := map[string]bool{"10.0.0.1": true}
	got := resolvedClientIP(req, trusted)
	if got != "198.51.100.25" {
		t.Fatalf("resolvedClientIP() = %q, want %q", got, "198.51.100.25")
	}
}

func TestRateLimiterFailsClosedForMutationWhenRedisUnavailable(t *testing.T) {
	rdb := unavailableRedisClient()
	defer rdb.Close()

	called := false
	handler := RateLimiter(rdb)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/pipeline", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if called {
		t.Fatal("next handler was called for mutation request while Redis was unavailable")
	}
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusServiceUnavailable)
	}
}

func TestRateLimiterFailsOpenForReadOnlyWhenRedisUnavailable(t *testing.T) {
	rdb := unavailableRedisClient()
	defer rdb.Close()

	called := false
	handler := RateLimiter(rdb)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/pipeline/123/status", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if !called {
		t.Fatal("next handler was not called for read-only request while Redis was unavailable")
	}
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusNoContent)
	}
}

func unavailableRedisClient() *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         "127.0.0.1:0",
		DialTimeout:  time.Millisecond,
		ReadTimeout:  time.Millisecond,
		WriteTimeout: time.Millisecond,
		MaxRetries:   0,
	})
}
