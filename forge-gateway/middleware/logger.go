package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

const (
	// CorrelationIDHeader is the HTTP header carrying the correlation ID.
	CorrelationIDHeader = "X-Correlation-ID"
	// RequestIDHeader is the HTTP header carrying the per-request ID.
	RequestIDHeader = "X-Request-ID"

	correlationCtxKey contextKey = "correlation_id"
	requestIDCtxKey   contextKey = "request_id"
)

// CorrelationID ensures every request has a correlation_id. If the incoming
// request already carries one in the X-Correlation-ID header it is reused;
// otherwise a new UUID is generated. A unique request_id is always created.
func CorrelationID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		correlationID := r.Header.Get(CorrelationIDHeader)
		if correlationID == "" {
			correlationID = uuid.New().String()
		}
		requestID := uuid.New().String()

		// Propagate via headers.
		w.Header().Set(CorrelationIDHeader, correlationID)
		w.Header().Set(RequestIDHeader, requestID)

		// Store in context.
		ctx := context.WithValue(r.Context(), correlationCtxKey, correlationID)
		ctx = context.WithValue(ctx, requestIDCtxKey, requestID)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequestLogger logs every HTTP request with zerolog, including timing,
// status code, correlation_id, and request_id.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &statusWriter{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(ww, r)

		duration := time.Since(start)

		var evt *zerolog.Event
		switch {
		case ww.status >= 500:
			evt = log.Error()
		case ww.status >= 400:
			evt = log.Warn()
		default:
			evt = log.Info()
		}

		correlationID, _ := r.Context().Value(correlationCtxKey).(string)
		requestID, _ := r.Context().Value(requestIDCtxKey).(string)

		evt.
			Str("correlation_id", correlationID).
			Str("request_id", requestID).
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Int("status", ww.status).
			Dur("duration_ms", duration).
			Str("remote_addr", r.RemoteAddr).
			Msg("request")
	})
}

// CorrelationIDFromCtx extracts the correlation ID from a context.
func CorrelationIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(correlationCtxKey).(string)
	return v
}

// statusWriter wraps http.ResponseWriter to capture the status code.
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (sw *statusWriter) WriteHeader(code int) {
	if !sw.wroteHeader {
		sw.status = code
		sw.wroteHeader = true
	}
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Write(b []byte) (int, error) {
	if !sw.wroteHeader {
		sw.wroteHeader = true
	}
	return sw.ResponseWriter.Write(b)
}
