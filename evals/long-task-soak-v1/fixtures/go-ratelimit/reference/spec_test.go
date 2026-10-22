package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBucketKeepsFractionalRefill(t *testing.T) {
	clock := NewFakeClock(epoch)
	b := NewTokenBucket(2, 4, clock)
	b.Allow()
	b.Allow()
	var got []bool
	for i := 0; i < 4; i++ {
		clock.Advance(125 * time.Millisecond)
		got = append(got, b.Allow().Allowed)
	}
	if want := []bool{false, true, false, true}; !equalBools(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	clock.Advance(125 * time.Millisecond)
	if b.Tokens() != 0.5 {
		t.Fatalf("tokens %v", b.Tokens())
	}
}

func TestBucketCapsAtCapacity(t *testing.T) {
	clock := NewFakeClock(epoch)
	b := NewTokenBucket(2, 10, clock)
	clock.Advance(time.Hour)
	if b.Tokens() != 2 {
		t.Fatalf("tokens %v", b.Tokens())
	}
}

func TestSlidingWindow(t *testing.T) {
	clock := NewFakeClock(epoch)
	w := NewSlidingWindow(2, time.Minute, clock)
	if d := w.Allow(); !d.Allowed || d.Remaining != 1 {
		t.Fatalf("%+v", d)
	}
	clock.Advance(20 * time.Second)
	w.Allow()
	if d := w.Allow(); d.Allowed || d.RetryAfter != 40*time.Second {
		t.Fatalf("%+v", d)
	}
	clock.Advance(40 * time.Second)
	if d := w.Allow(); !d.Allowed || d.Remaining != 0 {
		t.Fatalf("record exactly one window old must have expired: %+v", d)
	}
}

func TestKeyedSweep(t *testing.T) {
	clock := NewFakeClock(epoch)
	k := NewKeyed(func() Limiter { return NewSlidingWindow(1, time.Hour, clock) }, clock, time.Minute)
	k.Allow("a")
	clock.Advance(30 * time.Second)
	k.Allow("b")
	clock.Advance(30 * time.Second)
	if n := k.Sweep(); n != 1 || k.Len() != 1 {
		t.Fatalf("swept %d, left %d", n, k.Len())
	}
	if !k.Allow("a").Allowed {
		t.Fatal("swept key starts fresh")
	}
}

func TestMiddleware429(t *testing.T) {
	clock := NewFakeClock(epoch)
	store := NewKeyed(func() Limiter { return NewSlidingWindow(1, 90*time.Second, clock) }, clock, 0)
	h := Middleware(Options{Store: store})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for i, want := range []int{200, 429} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "10.0.0.1:5000"
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("request %d: %d", i, rec.Code)
		}
		if want == 429 && rec.Header().Get("Retry-After") != "90" {
			t.Fatalf("retry-after %q", rec.Header().Get("Retry-After"))
		}
	}
}

func TestClientIP(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "[::1]:8080"
	req.Header.Set("X-Forwarded-For", " 203.0.113.9 , 10.0.0.1")
	if ClientIP(req, false) != "::1" || ClientIP(req, true) != "203.0.113.9" {
		t.Fatal(ClientIP(req, false), ClientIP(req, true))
	}
}

func equalBools(a, b []bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
