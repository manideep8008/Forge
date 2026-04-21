package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"forge-gateway/database"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

// AuthHandler groups the authentication endpoints and holds shared dependencies.
type AuthHandler struct {
	rdb *redis.Client
}

// NewAuthHandler constructs an AuthHandler with the given Redis client.
func NewAuthHandler(rdb *redis.Client) *AuthHandler {
	return &AuthHandler{rdb: rdb}
}

// ---------- request / response types ----------

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

// ---------- helpers ----------

// Placeholder bcrypt hash for timing-attack mitigation.
// Computed once at startup so the bcrypt comparison always runs for
// non-existent users, preventing user enumeration via response time.
var placeholderHash []byte

func init() {
	// Dummy password + random salt → deterministic ~200ms bcrypt run.
	// This is computed once so subsequent non-existent-user logins are constant-time.
	hash, _ := bcrypt.GenerateFromPassword([]byte("placeholder-not-a-real-password"), bcrypt.DefaultCost)
	placeholderHash = hash
}

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 7 * 24 * time.Hour
)

func jwtSecret() []byte {
	return []byte(os.Getenv("JWT_SECRET"))
}

func (h *AuthHandler) issueTokenPair(w http.ResponseWriter, r *http.Request, userID, email string) {
	now := time.Now()
	secret := jwtSecret()

	// Access token
	accessClaims := jwt.MapClaims{
		"user_id": userID,
		"email":   email,
		"exp":     now.Add(accessTokenTTL).Unix(),
		"iat":     now.Unix(),
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(secret)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Refresh token
	jti := uuid.New().String()
	refreshClaims := jwt.MapClaims{
		"jti":     jti,
		"user_id": userID,
		"exp":     now.Add(refreshTokenTTL).Unix(),
		"iat":     now.Unix(),
	}
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(secret)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Persist refresh token ID in Redis so we can revoke it.
	h.rdb.Set(r.Context(), "refresh:"+jti, userID, refreshTokenTTL)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int(accessTokenTTL.Seconds()),
		TokenType:    "Bearer",
	})
}

// ---------- handlers ----------

// Register handles POST /auth/register.
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		jsonError(w, "email and password are required", http.StatusBadRequest)
		return
	}
	if len(req.Password) < 8 {
		jsonError(w, "password must be at least 8 characters", http.StatusBadRequest)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	pool := database.Pool()
	if pool == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}

	var userID string
	err = pool.QueryRow(r.Context(),
		"INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
		req.Email, string(hash),
	).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "unique") || strings.Contains(err.Error(), "duplicate") {
			jsonError(w, "email already registered", http.StatusConflict)
			return
		}
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":    userID,
		"email": req.Email,
	})
}

// Login handles POST /auth/login.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		jsonError(w, "email and password are required", http.StatusBadRequest)
		return
	}

	pool := database.Pool()
	if pool == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}

	var userID, passwordHash string
	err := pool.QueryRow(r.Context(),
		"SELECT id, password_hash FROM users WHERE email = $1",
		req.Email,
	).Scan(&userID, &passwordHash)
	if err != nil {
		// Use constant-time comparison — even for non-existent users.
		bcrypt.CompareHashAndPassword(placeholderHash, []byte(req.Password)) //nolint
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		jsonError(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	h.issueTokenPair(w, r, userID, req.Email)
}

// Refresh handles POST /auth/refresh — issues a new access token using a valid refresh token.
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RefreshToken == "" {
		jsonError(w, "refresh_token is required", http.StatusBadRequest)
		return
	}

	token, err := jwt.Parse(body.RefreshToken, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return jwtSecret(), nil
	})
	if err != nil || !token.Valid {
		jsonError(w, "invalid or expired refresh token", http.StatusUnauthorized)
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		jsonError(w, "invalid token claims", http.StatusUnauthorized)
		return
	}
	jti, _ := claims["jti"].(string)
	userID, _ := claims["user_id"].(string)
	if jti == "" || userID == "" {
		jsonError(w, "invalid token claims", http.StatusUnauthorized)
		return
	}

	// Verify refresh token is still live in Redis.
	storedUserID, err := h.rdb.Get(r.Context(), "refresh:"+jti).Result()
	if err != nil || storedUserID != userID {
		jsonError(w, "refresh token revoked or expired", http.StatusUnauthorized)
		return
	}

	// Fetch email for new claims.
	pool := database.Pool()
	var email string
	if pool != nil {
		pool.QueryRow(r.Context(), "SELECT email FROM users WHERE id = $1", userID).Scan(&email) //nolint
	}

	// Issue NEW token pair FIRST, then revoke old token.
	// This prevents lockout if token issuance succeeds but revocation fails.
	h.issueTokenPair(w, r, userID, email)

	// Now revoke the old token (best-effort; non-fatal if it fails).
	h.rdb.Del(r.Context(), "refresh:"+jti)
}

// Logout handles POST /auth/logout — revokes the refresh token.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	// Best-effort: if we can't decode or the token is already gone, still return 204.
	if err := json.NewDecoder(r.Body).Decode(&body); err == nil && body.RefreshToken != "" {
		token, err := jwt.Parse(body.RefreshToken, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return jwtSecret(), nil
		})
		if err == nil && token.Valid {
			if claims, ok := token.Claims.(jwt.MapClaims); ok {
				if jti, ok := claims["jti"].(string); ok && jti != "" {
					h.rdb.Del(r.Context(), "refresh:"+jti)
				}
			}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
