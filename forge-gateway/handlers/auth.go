package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"forge-gateway/database"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

type issuedTokenPair struct {
	accessToken         string
	refreshToken        string
	refreshTokenID      string
	refreshTokenExpires time.Time
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
	accessTokenTTL         = 15 * time.Minute
	refreshTokenTTL        = 7 * 24 * time.Hour
	refreshTokenCookie     = "refresh_token"
	refreshTokenCookiePath = "/auth"
)

var rotateRefreshTokenScript = redis.NewScript(`
local current = redis.call("GET", KEYS[1])
if not current or current ~= ARGV[1] then
	return 0
end
redis.call("SET", KEYS[2], ARGV[1], "PX", ARGV[2])
redis.call("DEL", KEYS[1])
return 1
`)

func jwtSecret() []byte {
	return []byte(os.Getenv("JWT_SECRET"))
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func setRefreshTokenCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshTokenCookie,
		Value:    token,
		Path:     refreshTokenCookiePath,
		Expires:  expires,
		MaxAge:   int(refreshTokenTTL.Seconds()),
		HttpOnly: true,
		Secure:   !strings.EqualFold(os.Getenv("DEV_MODE"), "true"),
		SameSite: http.SameSiteStrictMode,
	})
}

func clearRefreshTokenCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshTokenCookie,
		Value:    "",
		Path:     refreshTokenCookiePath,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !strings.EqualFold(os.Getenv("DEV_MODE"), "true"),
		SameSite: http.SameSiteStrictMode,
	})
}

func refreshTokenFromCookie(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(refreshTokenCookie)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	return cookie.Value, true
}

func newTokenPair(userID, email string) (issuedTokenPair, error) {
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
		return issuedTokenPair{}, err
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
		return issuedTokenPair{}, err
	}

	return issuedTokenPair{
		accessToken:         accessToken,
		refreshToken:        refreshToken,
		refreshTokenID:      jti,
		refreshTokenExpires: now.Add(refreshTokenTTL),
	}, nil
}

func writeTokenPairResponse(w http.ResponseWriter, pair issuedTokenPair) {
	setRefreshTokenCookie(w, pair.refreshToken, pair.refreshTokenExpires)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tokenResponse{
		AccessToken: pair.accessToken,
		ExpiresIn:   int(accessTokenTTL.Seconds()),
		TokenType:   "Bearer",
	})
}

func (h *AuthHandler) issueTokenPair(w http.ResponseWriter, r *http.Request, userID, email string) bool {
	pair, err := newTokenPair(userID, email)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return false
	}

	// Persist refresh token ID in Redis so we can revoke it.
	if err := h.rdb.Set(r.Context(), "refresh:"+pair.refreshTokenID, userID, refreshTokenTTL).Err(); err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return false
	}

	writeTokenPairResponse(w, pair)
	return true
}

func (h *AuthHandler) rotateRefreshToken(r *http.Request, oldJTI, newJTI, userID string) (bool, error) {
	status, err := rotateRefreshTokenScript.Run(
		r.Context(),
		h.rdb,
		[]string{"refresh:" + oldJTI, "refresh:" + newJTI},
		userID,
		refreshTokenTTL.Milliseconds(),
	).Int()
	if err != nil {
		return false, err
	}
	return status == 1, nil
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

	pool := database.PoolContext(r.Context())
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
		if isUniqueViolation(err) {
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

	pool := database.PoolContext(r.Context())
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

	if !h.issueTokenPair(w, r, userID, req.Email) {
		return
	}
}

// Refresh handles POST /auth/refresh — issues a new access token using a valid refresh token.
func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	refreshToken, ok := refreshTokenFromCookie(r)
	if !ok {
		jsonError(w, "refresh_token is required", http.StatusBadRequest)
		return
	}

	token, err := jwt.Parse(refreshToken, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return jwtSecret(), nil
	})
	if err != nil || !token.Valid {
		clearRefreshTokenCookie(w)
		jsonError(w, "invalid or expired refresh token", http.StatusUnauthorized)
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		clearRefreshTokenCookie(w)
		jsonError(w, "invalid token claims", http.StatusUnauthorized)
		return
	}
	jti, _ := claims["jti"].(string)
	userID, _ := claims["user_id"].(string)
	if jti == "" || userID == "" {
		clearRefreshTokenCookie(w)
		jsonError(w, "invalid token claims", http.StatusUnauthorized)
		return
	}

	// Fetch email for new claims.
	pool := database.PoolContext(r.Context())
	var email string
	if pool == nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := pool.QueryRow(r.Context(), "SELECT email FROM users WHERE id = $1", userID).Scan(&email); err != nil {
		clearRefreshTokenCookie(w)
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, "invalid or expired refresh token", http.StatusUnauthorized)
			return
		}
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	pair, err := newTokenPair(userID, email)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Atomically consume the old refresh token and persist the replacement.
	rotated, err := h.rotateRefreshToken(r, jti, pair.refreshTokenID, userID)
	if err != nil {
		jsonError(w, "internal error", http.StatusInternalServerError)
		return
	}
	if !rotated {
		// A duplicate refresh request can lose the rotation race after a newer
		// response has already set a valid cookie. Do not clear that newer cookie.
		jsonError(w, "refresh token revoked or expired", http.StatusUnauthorized)
		return
	}

	writeTokenPairResponse(w, pair)
}

// Logout handles POST /auth/logout — revokes the refresh token.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	// Best-effort: if the cookie is already gone or invalid, still clear it and return 204.
	if refreshToken, ok := refreshTokenFromCookie(r); ok {
		token, err := jwt.Parse(refreshToken, func(t *jwt.Token) (interface{}, error) {
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
	clearRefreshTokenCookie(w)
	w.WriteHeader(http.StatusNoContent)
}
