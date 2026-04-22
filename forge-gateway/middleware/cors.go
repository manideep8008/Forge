package middleware

import (
	"net/http"
	"os"
	"strings"
)

// allowedOrigins returns the set of permitted origins. In production set
// CORS_ALLOWED_ORIGINS to a comma-separated list (e.g. "https://app.forge.io").
// Falls back to localhost origins for development.
func allowedOrigins() map[string]bool {
	env := os.Getenv("CORS_ALLOWED_ORIGINS")
	if env != "" {
		m := make(map[string]bool)
		for _, o := range strings.Split(env, ",") {
			m[strings.TrimSpace(o)] = true
		}
		return m
	}
	return map[string]bool{
		"http://localhost:3000": true,
		"http://localhost:8080": true,
	}
}

// CORSMiddleware sets CORS headers based on CORS_ALLOWED_ORIGINS env var.
func CORSMiddleware(next http.Handler) http.Handler {
	origins := allowedOrigins()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-Correlation-ID, X-Request-ID")
		w.Header().Set("Access-Control-Expose-Headers", "X-Correlation-ID, X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining")
		w.Header().Set("Access-Control-Max-Age", "3600")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
