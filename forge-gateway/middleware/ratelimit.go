package middleware

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// RateLimiter returns middleware that enforces a per-IP token-bucket rate limit
// backed by Redis. Limits are configurable per endpoint family via environment
// variables RATE_LIMIT_PIPELINE (default 10 req/min) and RATE_LIMIT_QUERY
// (default 100 req/min).
//
// IP resolution: uses X-Forwarded-For only when the request comes from a
// trusted proxy (listed in TRUSTED_PROXIES, comma-separated). Otherwise
// falls back to r.RemoteAddr to prevent IP spoofing.
func RateLimiter(rdb *redis.Client) func(http.Handler) http.Handler {
	pipelineLimit := envInt("RATE_LIMIT_PIPELINE", 10)
	queryLimit := envInt("RATE_LIMIT_QUERY", 100)
	trustedProxies := loadTrustedProxies()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Determine bucket and limit.
			limit := queryLimit
			bucket := "query"
			failClosed := !isReadOnlyMethod(r.Method)
			if failClosed && isPipelineRoute(r.URL.Path) {
				limit = pipelineLimit
				bucket = "pipeline"
			}

			ip := resolvedClientIP(r, trustedProxies)
			key := fmt.Sprintf("rl:%s:%s", bucket, ip)

			ctx := r.Context()
			count, err := rdb.Incr(ctx, key).Result()
			if err != nil {
				log.Warn().
					Err(err).
					Bool("fail_closed", failClosed).
					Str("method", r.Method).
					Str("path", r.URL.Path).
					Msg("rate limiter: redis unavailable")
				if failClosed {
					w.Header().Set("Retry-After", "10")
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusServiceUnavailable)
					fmt.Fprint(w, `{"error":"rate limiter unavailable"}`)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			// Set expiry on first increment (1-minute window).
			if count == 1 {
				rdb.Expire(ctx, key, 1*time.Minute)
			}

			if count > int64(limit) {
				w.Header().Set("Retry-After", "60")
				w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprintf(w, `{"error":"rate limit exceeded","limit":%d,"bucket":"%s"}`, limit, bucket)
				return
			}

			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(limit-int(count)))
			next.ServeHTTP(w, r)
		})
	}
}

func isReadOnlyMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

func isPipelineRoute(path string) bool {
	return path == "/api/pipeline" || strings.HasPrefix(path, "/api/pipeline/")
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Warn().Str("key", key).Str("value", v).Msg("invalid int env var, using default")
		return fallback
	}
	return n
}

// loadTrustedProxies parses the TRUSTED_PROXIES env var (comma-separated list of
// IP addresses/CIDR) and returns a map for O(1) lookup. Empty string = no
// proxies are trusted (X-Forwarded-For will be ignored).
func loadTrustedProxies() map[string]bool {
	env := os.Getenv("TRUSTED_PROXIES")
	if env == "" {
		return nil // nil map = no proxies trusted
	}
	result := make(map[string]bool)
	for _, p := range strings.Split(env, ",") {
		result[strings.TrimSpace(p)] = true
	}
	return result
}

// resolvedClientIP returns the real client IP for rate limiting.
// It uses X-Forwarded-For only when the direct connection comes from a trusted
// proxy; otherwise it falls back to r.RemoteAddr to prevent spoofing.
func resolvedClientIP(r *http.Request, trusted map[string]bool) string {
	remoteAddr := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}

	// If no proxies are trusted, or the direct connection is not from a trusted
	// proxy, use RemoteAddr.
	if trusted == nil || !trusted[remoteAddr] {
		return remoteAddr
	}

	// Direct connection is from a trusted proxy — safe to use X-Forwarded-For.
	xfwd := r.Header.Get("X-Forwarded-For")
	if xfwd == "" {
		return remoteAddr
	}

	// X-Forwarded-For is a comma-separated list: client, proxy1, proxy2, ...
	// We want the leftmost untrusted IP (the real client).
	// If all proxies are trusted, use the leftmost IP.
	parts := strings.Split(strings.TrimSpace(xfwd), ",")
	for _, part := range parts {
		ip := strings.TrimSpace(part)
		// If we find an IP that is NOT in our trusted list, use it.
		if trusted == nil || !trusted[ip] {
			return ip
		}
		// All IPs so far are trusted — continue to next.
	}

	// Fallback: last IP in the chain.
	return strings.TrimSpace(parts[len(parts)-1])
}
