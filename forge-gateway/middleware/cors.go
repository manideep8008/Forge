package middleware

import "net/http"

// CORSMiddleware sets permissive CORS headers suitable for development and
// internal microservice communication. Tighten AllowedOrigins for production.
func CORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
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
