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
func RateLimiter(rdb *redis.Client) func(http.Handler) http.Handler {
	pipelineLimit := envInt("RATE_LIMIT_PIPELINE", 10)
	queryLimit := envInt("RATE_LIMIT_QUERY", 100)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Determine bucket and limit.
			limit := queryLimit
			bucket := "query"
			if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/pipeline") {
				limit = pipelineLimit
				bucket = "pipeline"
			}

			ip := r.RemoteAddr
			if host, _, err := net.SplitHostPort(ip); err == nil {
				ip = host
			}
			key := fmt.Sprintf("rl:%s:%s", bucket, ip)

			ctx := r.Context()
			count, err := rdb.Incr(ctx, key).Result()
			if err != nil {
				// If Redis is down, allow the request but log a warning.
				log.Warn().Err(err).Msg("rate limiter: redis unavailable, allowing request")
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
