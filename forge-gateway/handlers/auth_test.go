package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSetRefreshTokenCookieUsesHttpOnlySecureStrictCookie(t *testing.T) {
	rec := httptest.NewRecorder()
	expires := time.Now().Add(refreshTokenTTL)

	setRefreshTokenCookie(rec, "refresh.jwt", expires)

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}

	cookie := cookies[0]
	if cookie.Name != refreshTokenCookie {
		t.Fatalf("cookie name = %q, want %q", cookie.Name, refreshTokenCookie)
	}
	if cookie.Value != "refresh.jwt" {
		t.Fatalf("cookie value = %q, want refresh.jwt", cookie.Value)
	}
	if cookie.Path != refreshTokenCookiePath {
		t.Fatalf("cookie path = %q, want %q", cookie.Path, refreshTokenCookiePath)
	}
	if cookie.MaxAge != int(refreshTokenTTL.Seconds()) {
		t.Fatalf("cookie max age = %d, want %d", cookie.MaxAge, int(refreshTokenTTL.Seconds()))
	}
	if !cookie.HttpOnly {
		t.Fatal("cookie HttpOnly = false, want true")
	}
	if !cookie.Secure {
		t.Fatal("cookie Secure = false, want true")
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie SameSite = %v, want %v", cookie.SameSite, http.SameSiteStrictMode)
	}
}

func TestClearRefreshTokenCookieExpiresHttpOnlySecureStrictCookie(t *testing.T) {
	rec := httptest.NewRecorder()

	clearRefreshTokenCookie(rec)

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}

	cookie := cookies[0]
	if cookie.Name != refreshTokenCookie {
		t.Fatalf("cookie name = %q, want %q", cookie.Name, refreshTokenCookie)
	}
	if cookie.Path != refreshTokenCookiePath {
		t.Fatalf("cookie path = %q, want %q", cookie.Path, refreshTokenCookiePath)
	}
	if cookie.MaxAge != -1 {
		t.Fatalf("cookie max age = %d, want -1", cookie.MaxAge)
	}
	if !cookie.HttpOnly {
		t.Fatal("cookie HttpOnly = false, want true")
	}
	if !cookie.Secure {
		t.Fatal("cookie Secure = false, want true")
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie SameSite = %v, want %v", cookie.SameSite, http.SameSiteStrictMode)
	}
}
