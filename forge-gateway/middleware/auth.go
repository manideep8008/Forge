package middleware

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/rs/zerolog/log"
)

type contextKey string

const (
	// ClaimsKey is used to store parsed JWT claims in the request context.
	ClaimsKey contextKey = "jwt_claims"
)

// GetUserID extracts the user_id claim from the request context.
// Returns "anonymous" when auth is disabled or the claim is absent.
func GetUserID(r *http.Request) string {
	claims, ok := r.Context().Value(ClaimsKey).(jwt.MapClaims)
	if !ok {
		return "anonymous"
	}
	if uid, ok := claims["user_id"].(string); ok && uid != "" {
		return uid
	}
	return "anonymous"
}

// JWTAuth validates a Bearer token using HS256 and the JWT_SECRET env var.
// Requests to /health are skipped.
func JWTAuth(next http.Handler) http.Handler {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		log.Warn().Msg("JWT_SECRET not set – auth will reject all requests")
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip health check.
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
			http.Error(w, `{"error":"invalid authorization header format"}`, http.StatusUnauthorized)
			return
		}
		tokenStr := parts[1]

		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(secret), nil
		})
		if err != nil || !token.Valid {
			log.Debug().Err(err).Msg("jwt validation failed")
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), ClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
