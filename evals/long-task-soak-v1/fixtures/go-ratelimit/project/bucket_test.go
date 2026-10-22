package ratelimit

import (
	"testing"
	"time"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func TestBucketStartsFullAndDrains(t *testing.T) {
	clock := NewFakeClock(epoch)
	b := NewTokenBucket(3, 1, clock)
	for i := 0; i < 3; i++ {
		if d := b.Allow(); !d.Allowed || d.Remaining != 2-i || d.Limit != 3 {
			t.Fatalf("request %d: %+v", i, d)
		}
	}
	if d := b.Allow(); d.Allowed || d.RetryAfter != time.Second {
		t.Fatalf("drained bucket: %+v", d)
	}
}

func TestBucketRefillsAfterOneSecond(t *testing.T) {
	clock := NewFakeClock(epoch)
	b := NewTokenBucket(1, 1, clock)
	b.Allow()
	clock.Advance(time.Second)
	if d := b.Allow(); !d.Allowed {
		t.Fatalf("expected a refilled token: %+v", d)
	}
}
